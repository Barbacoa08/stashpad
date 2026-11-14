use crate::{backup, model::*};
use rusqlite::{params, Connection};
use std::path::Path;
pub struct Store {
    connection: Connection,
}
const TABLE:&str="CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('note','tree')),markdown TEXT NOT NULL,done INTEGER NOT NULL CHECK(done IN (0,1)),color TEXT CHECK(color IN ('red','orange','yellow','green','teal','blue','purple','pink','gray')),position INTEGER NOT NULL CHECK(position>=0),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER,restore_parent_id TEXT,restore_index INTEGER);";
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).map_err(storage_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(3))
            .map_err(storage_error)?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(storage_error)?;
        let objects: i64 = connection
            .query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get(0))
            .map_err(storage_error)?;
        if version != 7 && (version != 0 || objects != 0) {
            return Err(error(
                "schema_version",
                "This library uses an unsupported schema. No data were replaced.",
            ));
        }
        let mut store = Self { connection };
        if version == 0 {
            store
                .connection
                .execute_batch("BEGIN IMMEDIATE;")
                .map_err(storage_error)?;
            let result = (|| {
                store
                    .connection
                    .execute_batch(TABLE)
                    .map_err(storage_error)?;
                store.connection.execute_batch("CREATE TABLE drafts(key TEXT PRIMARY KEY,markdown TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);INSERT INTO settings VALUES ('undoDeleteIds','[]');PRAGMA user_version=7;COMMIT;").map_err(storage_error)
            })();
            if let Err(e) = result {
                let _ = store.connection.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }
        store.load()?;
        Ok(store)
    }
    fn read_drafts(&self) -> Result<Vec<Draft>> {
        let mut q = self
            .connection
            .prepare("SELECT key,markdown,revision,updated_at FROM drafts ORDER BY key")
            .map_err(storage_error)?;
        let rows = q
            .query_map([], |r| {
                Ok(Draft {
                    key: r.get(0)?,
                    markdown: r.get(1)?,
                    revision: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            })
            .map_err(storage_error)?;
        rows.map(|r| r.map_err(storage_error)).collect()
    }
    pub fn load(&mut self) -> Result<WorkspaceSnapshot> {
        let raw: String = self
            .connection
            .query_row(
                "SELECT value FROM settings WHERE key='undoDeleteIds'",
                [],
                |r| r.get(0),
            )
            .map_err(storage_error)?;
        let undo_delete_ids: Vec<String> = serde_json::from_str(&raw).map_err(storage_error)?;
        let s = WorkspaceSnapshot {
            items: self.read_items()?,
            drafts: self.read_drafts()?,
            undo_delete_ids,
        };
        backup::encode(&s)?;
        Ok(s)
    }
    fn read_items(&self) -> Result<Vec<Item>> {
        let mut items = vec![];
        let mut q=self.connection.prepare("SELECT id,parent_id,kind,markdown,done,color,position,created_at,updated_at,deleted_at,restore_parent_id,restore_index FROM items ORDER BY id").map_err(storage_error)?;
        for row in q
            .query_map([], |r| {
                let kind: String = r.get(2)?;
                let done: i64 = r.get(4)?;
                let color: Option<String> = r.get(5)?;
                if done != 0 && done != 1 {
                    return Err(rusqlite::Error::IntegralValueOutOfRange(4, done));
                }
                let kind = serde_json::from_value(serde_json::json!(kind)).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                let color = serde_json::from_value(serde_json::json!(color)).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        5,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                Ok(Item {
                    id: r.get(0)?,
                    parent_id: r.get(1)?,
                    kind,
                    markdown: r.get(3)?,
                    done: done == 1,
                    color,
                    position: r.get(6)?,
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
                    deleted_at: r.get(9)?,
                    restore_parent_id: r.get(10)?,
                    restore_index: r.get(11)?,
                })
            })
            .map_err(storage_error)?
        {
            items.push(row.map_err(storage_error)?);
        }
        Ok(items)
    }
    fn write_rows(c: &Connection, s: &WorkspaceSnapshot) -> Result<()> {
        c.execute("DELETE FROM drafts", []).map_err(storage_error)?;
        c.execute("DELETE FROM items", []).map_err(storage_error)?;
        for x in &s.items {
            let kind = if x.kind == Kind::Tree { "tree" } else { "note" };
            let color = x.color.as_ref().map(|c| {
                serde_json::to_value(c)
                    .expect("color enum")
                    .as_str()
                    .expect("color string")
                    .to_string()
            });
            c.execute(
                "INSERT INTO items VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    x.id,
                    x.parent_id,
                    kind,
                    x.markdown,
                    x.done,
                    color,
                    x.position,
                    x.created_at,
                    x.updated_at,
                    x.deleted_at,
                    x.restore_parent_id,
                    x.restore_index
                ],
            )
            .map_err(storage_error)?;
        }
        for d in &s.drafts {
            c.execute(
                "INSERT INTO drafts VALUES (?1,?2,?3,?4)",
                params![d.key, d.markdown, d.revision, d.updated_at],
            )
            .map_err(storage_error)?;
        }
        c.execute("DELETE FROM settings WHERE key='undoDeleteIds'", [])
            .map_err(storage_error)?;
        c.execute(
            "INSERT INTO settings VALUES ('undoDeleteIds',?1)",
            [serde_json::to_string(&s.undo_delete_ids).map_err(storage_error)?],
        )
        .map_err(storage_error)?;
        Ok(())
    }
    pub fn replace(&mut self, s: &WorkspaceSnapshot) -> Result<WorkspaceSnapshot> {
        self.replace_with_failure(s, false)
    }
    pub fn replace_with_failure(
        &mut self,
        s: &WorkspaceSnapshot,
        fail: bool,
    ) -> Result<WorkspaceSnapshot> {
        backup::encode(s)?;
        let tx = self.connection.transaction().map_err(storage_error)?;
        Self::write_rows(&tx, s)?;
        if cfg!(debug_assertions) && fail {
            return Err(error(
                "synthetic_failure",
                "Synthetic transaction failure before commit.",
            ));
        }
        tx.commit().map_err(storage_error)?;
        self.load()
    }
    pub fn checkpoint(
        &mut self,
        key: &str,
        markdown: &str,
        revision: i64,
    ) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        let draft = Draft {
            key: key.into(),
            markdown: markdown.into(),
            revision,
            updated_at: now(),
        };
        // Validate even stale requests, rather than acknowledging malformed metadata.
        let mut prospective = s.clone();
        prospective.drafts.retain(|d| d.key != key);
        prospective.drafts.push(draft.clone());
        backup::encode(&prospective)?;
        if s.drafts
            .iter()
            .any(|d| d.key == key && d.revision >= revision)
        {
            return Ok(s);
        }
        s.drafts.retain(|d| d.key != key);
        s.drafts.push(draft);
        self.replace(&s)
    }
    pub fn discard_draft(&mut self, key: &str) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        s.drafts.retain(|d| d.key != key);
        self.replace(&s)
    }
    pub fn save_source(
        &mut self,
        id: &str,
        markdown: &str,
        draft: &DraftAck,
    ) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        ack(&mut s, draft, id)?;
        let x = find_mut(&mut s, id)?;
        if x.markdown != markdown {
            x.markdown = markdown.into();
            touch(x);
        }
        self.replace(&s)
    }
    pub fn capture(&mut self, r: &CaptureItem) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        validate_location(&s, &r.location, true)?;
        if ecma_trim(&r.markdown).is_empty() {
            return Err(error(
                "empty_note",
                "Enter non-whitespace text before saving. Your draft is retained.",
            ));
        }
        ack(&mut s, &r.draft, &r.location.compose_key())?;
        create(&mut s, &r.id, &r.location, Kind::Note, &r.markdown)?;
        self.replace(&s)
    }
    pub fn create_child_tree(&mut self, r: &CreateChildTree) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        create(&mut s, &r.id, &r.parent, Kind::Tree, "Untitled")?;
        if let Some(from) = &r.leave {
            let to = Location {
                scope: r.parent.scope.clone(),
                item_id: Some(r.id.clone()),
            };
            transition_snapshot(
                &mut s,
                &TransitionLocation {
                    from: from.clone(),
                    to,
                    promote_destination: false,
                },
            )?;
        }
        self.replace(&s)
    }
    pub fn promote(&mut self, id: &str) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        let x = find_mut(&mut s, id)?;
        if x.kind == Kind::Note {
            x.kind = Kind::Tree;
            touch(x);
        }
        self.replace(&s)
    }
    pub fn set_done(&mut self, id: &str, done: bool) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        let x = find_mut(&mut s, id)?;
        if x.done != done {
            x.done = done;
            touch(x);
        }
        self.replace(&s)
    }
    pub fn set_color(&mut self, id: &str, color: Option<ColorToken>) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        let x = find_mut(&mut s, id)?;
        if x.color != color {
            x.color = color;
            touch(x);
        }
        self.replace(&s)
    }
    pub fn delete(&mut self, id: &str) -> Result<WorkspaceSnapshot> {
        self.delete_leaving(id, None)
    }
    pub fn delete_leaving(
        &mut self,
        id: &str,
        leave: Option<&Location>,
    ) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        let x = find(&s, id)?;
        if x.deleted_at.is_some() {
            return Ok(s);
        }
        if let Some(from) = leave {
            validate_location(&s, from, true)?;
            if from
                .item_id
                .as_ref()
                .is_none_or(|owner| !subtree(&s, id).contains(owner))
            {
                return Err(stale());
            }
        }
        let old = group(&s, &item_location(&s, id)?);
        let ordinal = old.iter().position(|key| key == id).expect("item in group") as i64;
        let trash = Location {
            scope: Scope::Trash,
            item_id: None,
        };
        let roots = group(&s, &trash);
        normalize(&mut s, &roots);
        let rank = roots.len() as i64;
        let x = find_mut(&mut s, id)?;
        x.restore_parent_id = x.parent_id.take();
        x.restore_index = Some(ordinal);
        x.deleted_at = Some(now().max(x.updated_at.saturating_add(1)));
        x.position = rank;
        touch(x);
        normalize(
            &mut s,
            &old.into_iter().filter(|key| key != id).collect::<Vec<_>>(),
        );
        s.undo_delete_ids = vec![id.into()];
        if let Some(owner) = leave.and_then(|at| at.item_id.as_deref()) {
            if !s
                .items
                .iter()
                .any(|x| x.parent_id.as_deref() == Some(owner))
            {
                find_mut(&mut s, owner)?.kind = Kind::Note;
            }
        }
        self.replace(&s)
    }
    pub fn restore(&mut self, id: &str) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        restore(&mut s, id)?;
        self.replace(&s)
    }
    pub fn undo(&mut self, r: &UndoDeleteRequest) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        if !structural_action(&mut s, &r.ids, &r.proof, true, |s| restore_group(s, &r.ids))? {
            return Ok(s);
        }
        self.replace(&s)
    }
    pub fn reorder(&mut self, r: &ReorderItem) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        validate_location(&s, &r.group, false)?;
        if item_location(&s, &r.id)? != r.group {
            return Err(error(
                "invalid_context",
                "Reorder requires the same sibling group.",
            ));
        }
        let mut ids = group(&s, &r.group);
        if r.to_index < 0 || r.to_index >= ids.len() as i64 {
            return Err(error("invalid_index", "Invalid sibling index."));
        }
        let index = ids
            .iter()
            .position(|id| id == &r.id)
            .expect("item in group");
        if index == r.to_index as usize {
            return Ok(s);
        }
        let id = ids.remove(index);
        ids.insert(r.to_index as usize, id);
        normalize(&mut s, &ids);
        touch(find_mut(&mut s, &r.id)?);
        self.replace(&s)
    }
    pub fn purge(&mut self, r: &PurgeItem) -> Result<PurgeResult> {
        let mut s = self.load()?;
        let expected = unique_ids(&r.expected_subtree_ids)?;
        if !expected.contains(r.id.as_str()) {
            return Err(stale());
        }
        if !s.items.iter().any(|x| x.id == r.id) {
            let folded: std::collections::HashSet<String> =
                expected.iter().map(|id| id.to_lowercase()).collect();
            if s.items
                .iter()
                .any(|x| folded.contains(&x.id.to_lowercase()))
            {
                return Err(stale());
            }
            let mut removed_ids = r.expected_subtree_ids.clone();
            removed_ids.sort();
            return Ok(PurgeResult {
                workspace: s,
                removed_ids,
            });
        }
        if effective_scope(&s, &r.id)? != Scope::Trash || item_location(&s, &r.id)? != r.location {
            return Err(stale());
        }
        let removed = subtree(&s, &r.id);
        if removed != expected.into_iter().map(str::to_owned).collect() {
            return Err(stale());
        }
        let old = group(&s, &r.location);
        s.items.retain(|x| !removed.contains(&x.id));
        for x in &mut s.items {
            if x.restore_parent_id
                .as_ref()
                .is_some_and(|id| removed.contains(id))
            {
                x.restore_parent_id = None;
            }
        }
        s.drafts.retain(|d| {
            !removed.contains(&d.key)
                && !d
                    .key
                    .strip_prefix("compose:")
                    .is_some_and(|id| removed.contains(id))
        });
        s.undo_delete_ids.retain(|id| !removed.contains(id));
        normalize(
            &mut s,
            &old.into_iter()
                .filter(|id| !removed.contains(id))
                .collect::<Vec<_>>(),
        );
        let workspace = self.replace(&s)?;
        let mut removed_ids: Vec<_> = removed.into_iter().collect();
        removed_ids.sort();
        Ok(PurgeResult {
            workspace,
            removed_ids,
        })
    }
    pub fn transition(&mut self, r: &TransitionLocation) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        transition_snapshot(&mut s, r)?;
        self.replace(&s)
    }
    pub fn move_items(&mut self, r: &MoveItems) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        if let Some(proof) = &r.proof {
            if !structural_action(&mut s, &r.ids, proof, false, |s| apply_move(s, r))? {
                return Ok(s);
            }
        } else {
            if r.from.scope != r.to.scope {
                return Err(stale());
            }
            apply_move(&mut s, r)?;
        }
        self.replace(&s)
    }
    pub fn restore_with_safety(
        &mut self,
        s: &WorkspaceSnapshot,
        path: &Path,
        fail: bool,
    ) -> Result<WorkspaceSnapshot> {
        let current = self.load()?;
        backup::encode(s)?;
        backup::atomic_write(path, &backup::encode(&current)?)?;
        self.replace_with_failure(s, fail)
    }
}
fn find<'a>(s: &'a WorkspaceSnapshot, id: &str) -> Result<&'a Item> {
    s.items.iter().find(|x| x.id == id).ok_or_else(|| {
        error(
            "not_found",
            "This note is unavailable. Your input is retained.",
        )
    })
}
fn find_mut<'a>(s: &'a mut WorkspaceSnapshot, id: &str) -> Result<&'a mut Item> {
    s.items.iter_mut().find(|x| x.id == id).ok_or_else(|| {
        error(
            "not_found",
            "This note is unavailable. Your input is retained.",
        )
    })
}
fn touch(x: &mut Item) {
    x.updated_at = now().max(x.updated_at.saturating_add(1));
}
pub fn effective_scope(s: &WorkspaceSnapshot, id: &str) -> Result<Scope> {
    let index: std::collections::HashMap<&str, &Item> =
        s.items.iter().map(|x| (x.id.as_str(), x)).collect();
    let mut key = id;
    loop {
        let x = index.get(key).ok_or_else(|| {
            error(
                "not_found",
                "This note is unavailable. Your input is retained.",
            )
        })?;
        if x.deleted_at.is_some() {
            return Ok(Scope::Trash);
        }
        match x.parent_id.as_deref() {
            None => return Ok(Scope::Live),
            Some(parent) => key = parent,
        }
    }
}
fn item_location(s: &WorkspaceSnapshot, id: &str) -> Result<Location> {
    let x = find(s, id)?;
    Ok(Location {
        scope: effective_scope(s, id)?,
        item_id: x.parent_id.clone(),
    })
}
fn validate_location(s: &WorkspaceSnapshot, at: &Location, allow_note: bool) -> Result<()> {
    if let Some(id) = at.item_id.as_deref() {
        let x = find(s, id)?;
        if (!allow_note && x.kind != Kind::Tree) || effective_scope(s, id)? != at.scope {
            return Err(error(
                "invalid_context",
                "This destination is unavailable. Your input is retained.",
            ));
        }
    }
    Ok(())
}
fn group(s: &WorkspaceSnapshot, at: &Location) -> Vec<String> {
    let mut xs: Vec<&Item> = s
        .items
        .iter()
        .filter(|x| {
            x.parent_id == at.item_id
                && (at.item_id.is_some() || (x.deleted_at.is_some() == (at.scope == Scope::Trash)))
        })
        .collect();
    xs.sort_by_key(|x| x.position);
    xs.into_iter().map(|x| x.id.clone()).collect()
}
fn normalize(s: &mut WorkspaceSnapshot, ids: &[String]) {
    let positions: std::collections::HashMap<&str, i64> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i as i64))
        .collect();
    for x in &mut s.items {
        if let Some(pos) = positions.get(x.id.as_str()) {
            x.position = *pos;
        }
    }
}
fn ack(s: &mut WorkspaceSnapshot, draft: &DraftAck, key: &str) -> Result<()> {
    if draft.key != key || !(0..=MAX_SAFE).contains(&draft.revision) {
        return Err(error(
            "invalid_context",
            "Invalid draft acknowledgment. Your input is retained.",
        ));
    }
    s.drafts
        .retain(|d| d.key != key || d.revision > draft.revision);
    Ok(())
}
fn create(
    s: &mut WorkspaceSnapshot,
    id: &str,
    at: &Location,
    kind: Kind,
    markdown: &str,
) -> Result<()> {
    validate_location(s, at, true)?;
    if let Some(prior) = s
        .items
        .iter()
        .find(|x| x.id.to_lowercase() == id.to_lowercase())
    {
        if prior.id == id
            && prior.parent_id == at.item_id
            && prior.kind == kind
            && prior.markdown == markdown
            && !prior.done
            && prior.color.is_none()
            && effective_scope(s, id)? == at.scope
        {
            return Ok(());
        }
        return Err(error(
            "id_conflict",
            "Creation identity conflicts with existing content. Nothing was overwritten.",
        ));
    }
    let siblings = group(s, at);
    normalize(s, &siblings);
    let rank = siblings.len() as i64;
    if let Some(parent) = at.item_id.as_deref() {
        let x = find_mut(s, parent)?;
        if x.kind == Kind::Note {
            x.kind = Kind::Tree;
            touch(x);
        }
    }
    let time = now();
    s.items.push(Item {
        id: id.into(),
        parent_id: at.item_id.clone(),
        kind,
        markdown: markdown.into(),
        done: false,
        color: None,
        position: rank,
        created_at: time,
        updated_at: time,
        deleted_at: if at.scope == Scope::Trash && at.item_id.is_none() {
            Some(time)
        } else {
            None
        },
        restore_parent_id: None,
        restore_index: None,
    });
    Ok(())
}
fn restore(s: &mut WorkspaceSnapshot, id: &str) -> Result<()> {
    if effective_scope(s, id)? == Scope::Live {
        return Ok(());
    }
    restore_group(s, &[id.to_string()])
}

fn stale() -> AppError {
    error("stale_structure", "The captured notes or destination changed. Review the action again; your content is retained.")
}
fn unique_ids(ids: &[String]) -> Result<std::collections::HashSet<&str>> {
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if id.len() != 36 || uuid::Uuid::parse_str(id).is_err() || !seen.insert(id.as_str()) {
            return Err(stale());
        }
    }
    Ok(seen)
}
fn subtree(s: &WorkspaceSnapshot, id: &str) -> std::collections::HashSet<String> {
    let mut children: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    for x in &s.items {
        if let Some(parent) = x.parent_id.as_deref() {
            children.entry(parent).or_default().push(&x.id);
        }
    }
    let mut result = std::collections::HashSet::new();
    let mut pending = vec![id];
    while let Some(id) = pending.pop() {
        if result.insert(id.to_owned()) {
            if let Some(xs) = children.get(id) {
                pending.extend(xs);
            }
        }
    }
    result
}
fn deletion_dates(s: &WorkspaceSnapshot) -> std::collections::HashMap<&str, Option<i64>> {
    let index: std::collections::HashMap<&str, &Item> =
        s.items.iter().map(|x| (x.id.as_str(), x)).collect();
    let mut dates = std::collections::HashMap::new();
    for x in &s.items {
        let mut current = Some(x.id.as_str());
        let mut pending = Vec::new();
        while let Some(id) = current {
            if dates.contains_key(id) {
                break;
            }
            let node = index[id];
            pending.push(id);
            if node.deleted_at.is_some() {
                dates.insert(id, node.deleted_at);
                break;
            }
            current = node.parent_id.as_deref();
        }
        let date = current.and_then(|id| dates.get(id).copied().flatten());
        for id in pending {
            dates.insert(id, date);
        }
    }
    dates
}
fn transition_snapshot(s: &mut WorkspaceSnapshot, r: &TransitionLocation) -> Result<()> {
    // A prior acknowledged exit may have already demoted the origin.
    validate_location(s, &r.from, true)?;
    validate_location(s, &r.to, r.promote_destination)?;
    if r.promote_destination {
        if let Some(id) = r.to.item_id.as_deref() {
            let x = find_mut(s, id)?;
            if x.kind == Kind::Note {
                x.kind = Kind::Tree;
                touch(x);
            }
        }
    }
    if r.from == r.to {
        return Ok(());
    }
    if let Some(id) = r.from.item_id.as_deref() {
        if !s.items.iter().any(|x| x.parent_id.as_deref() == Some(id)) {
            find_mut(s, id)?.kind = Kind::Note;
        }
    }
    Ok(())
}
fn apply_move(s: &mut WorkspaceSnapshot, r: &MoveItems) -> Result<()> {
    validate_location(s, &r.from, false)?;
    validate_location(s, &r.to, false)?;
    if r.ids.is_empty() {
        return Err(stale());
    }
    let selected = unique_ids(&r.ids)?;
    unique_ids(&r.before_from)?;
    unique_ids(&r.before_to)?;
    unique_ids(&r.after_from)?;
    unique_ids(&r.after_to)?;
    if r.before_from
        .iter()
        .filter(|id| selected.contains(id.as_str()))
        .cloned()
        .collect::<Vec<_>>()
        != r.ids
    {
        return Err(stale());
    }
    let without = |xs: &[String]| {
        xs.iter()
            .filter(|id| !selected.contains(id.as_str()))
            .cloned()
            .collect::<Vec<_>>()
    };
    if r.from == r.to {
        if r.before_from != r.before_to
            || r.after_from != r.after_to
            || r.before_from.len() != r.after_from.len()
            || without(&r.before_from) != without(&r.after_from)
            || r.after_from
                .iter()
                .filter(|id| selected.contains(id.as_str()))
                .cloned()
                .collect::<Vec<_>>()
                != r.ids
        {
            return Err(stale());
        }
    } else {
        if r.before_to.iter().any(|id| selected.contains(id.as_str()))
            || r.after_from != without(&r.before_from)
            || without(&r.after_to) != r.before_to
            || r.after_to.len() != r.before_to.len() + r.ids.len()
        {
            return Err(stale());
        }
        let Some(start) = r.after_to.iter().position(|id| id == &r.ids[0]) else {
            return Err(stale());
        };
        if r.after_to.get(start..start + r.ids.len()) != Some(r.ids.as_slice()) {
            return Err(stale());
        }
    }
    let index: std::collections::HashMap<&str, &Item> =
        s.items.iter().map(|x| (x.id.as_str(), x)).collect();
    let mut parent = r.to.item_id.as_deref();
    while let Some(id) = parent {
        if selected.contains(id) {
            return Err(stale());
        }
        parent = index.get(id).and_then(|x| x.parent_id.as_deref());
    }
    let actual_from = group(s, &r.from);
    let actual_to = group(s, &r.to);
    if actual_from == r.after_from && actual_to == r.after_to {
        return Ok(());
    }
    if actual_from != r.before_from || actual_to != r.before_to {
        return Err(stale());
    }
    if r.from.scope == Scope::Trash && r.to.scope == Scope::Live {
        detach_group_deleted_descendants(s, &r.ids, false);
        s.undo_delete_ids
            .retain(|id| !selected.contains(id.as_str()));
    }
    let all_dates = deletion_dates(s);
    let dates: Vec<_> = r
        .ids
        .iter()
        .map(|id| all_dates.get(id.as_str()).copied().flatten())
        .collect();
    let destination_date =
        r.to.item_id
            .as_deref()
            .and_then(|id| all_dates.get(id).copied().flatten());
    let old_positions: std::collections::HashMap<&str, usize> = r
        .before_from
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let new_positions: std::collections::HashMap<&str, usize> = r
        .after_to
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let selected_dates: std::collections::HashMap<&str, Option<i64>> = r
        .ids
        .iter()
        .zip(dates)
        .map(|(id, date)| (id.as_str(), date))
        .collect();
    for x in &mut s.items {
        if !selected.contains(x.id.as_str()) {
            continue;
        }
        let old_index = old_positions[x.id.as_str()];
        let new_index = new_positions[x.id.as_str()];
        if r.from == r.to && old_index == new_index {
            continue;
        }
        let date = selected_dates[x.id.as_str()];
        if r.from.scope == Scope::Live && r.to.scope == Scope::Trash {
            let date = r
                .deleted_at
                .filter(|t| (0..=MAX_SAFE).contains(t))
                .ok_or_else(stale)?;
            x.deleted_at = Some(date);
            x.restore_parent_id = x.parent_id.clone();
            x.restore_index = Some(old_index as i64);
        } else if r.from.scope == Scope::Trash && r.to.scope == Scope::Live {
            x.deleted_at = None;
            x.restore_parent_id = None;
            x.restore_index = None;
        }
        if r.from.scope == Scope::Trash
            && r.to.scope == Scope::Trash
            && x.deleted_at.is_none()
            && (r.to.item_id.is_none() || date != destination_date)
        {
            x.deleted_at = date;
            x.restore_parent_id = x.parent_id.clone();
            x.restore_index = Some(old_index as i64);
        }
        x.parent_id = r.to.item_id.clone();
        touch(x);
        if r.from.scope == Scope::Live && r.to.scope == Scope::Trash {
            x.updated_at = x.updated_at.max(r.deleted_at.ok_or_else(stale)?);
        }
    }
    if r.from.scope == Scope::Live && r.to.scope == Scope::Trash {
        s.undo_delete_ids = r.ids.clone();
    }
    normalize(s, &r.after_from);
    normalize(s, &r.after_to);
    if r.from.scope == Scope::Trash && r.to.scope == Scope::Live {
        let roots = group(
            s,
            &Location {
                scope: Scope::Trash,
                item_id: None,
            },
        );
        normalize(s, &roots);
    }

    Ok(())
}

fn detach_group_deleted_descendants(
    s: &mut WorkspaceSnapshot,
    ids: &[String],
    historical_single: bool,
) {
    use std::collections::{HashMap, HashSet};
    let index: HashMap<String, usize> = s
        .items
        .iter()
        .enumerate()
        .map(|(i, x)| (x.id.clone(), i))
        .collect();
    let mut children: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, x) in s.items.iter().enumerate() {
        if let Some(parent) = &x.parent_id {
            children.entry(parent.clone()).or_default().push(i);
        }
    }
    // Preserve native exact-ID singleton traversal for any valid input array order.
    for group in children.values_mut() {
        if historical_single {
            group.sort_by(|a, b| s.items[*a].id.cmp(&s.items[*b].id));
        } else {
            group.sort_by_key(|i| s.items[*i].position);
        }
    }
    let mut roots = group(
        s,
        &Location {
            scope: Scope::Trash,
            item_id: None,
        },
    );
    let mut seen = HashSet::new();
    let mut detached = HashSet::new();
    let mut affected = HashSet::new();
    for id in ids {
        let mut pending = children.get(id).cloned().unwrap_or_default();
        if !historical_single {
            pending.reverse();
        }
        while let Some(i) = pending.pop() {
            if !seen.insert(i) {
                continue;
            }
            if s.items[i].deleted_at.is_some() {
                affected.insert(s.items[i].parent_id.clone().expect("descendant parent"));
                detached.insert(i);
                s.items[i].parent_id = None;
                roots.push(s.items[i].id.clone());
            } else if let Some(xs) = children.get(&s.items[i].id) {
                if historical_single {
                    pending.extend(xs);
                } else {
                    pending.extend(xs.iter().rev());
                }
            }
        }
    }
    for parent in affected {
        let mut remaining: Vec<_> = children[&parent]
            .iter()
            .copied()
            .filter(|i| !detached.contains(i))
            .collect();
        remaining.sort_by_key(|i| s.items[*i].position);
        for (rank, i) in remaining.iter().enumerate() {
            s.items[*i].position = rank as i64;
        }
    }
    for (rank, id) in roots.iter().enumerate() {
        s.items[index[id]].position = rank as i64;
    }
}
fn group_key(x: &Item) -> String {
    x.parent_id.clone().unwrap_or_else(|| {
        if x.deleted_at.is_some() {
            "trash".into()
        } else {
            "live".into()
        }
    })
}
fn restore_group(s: &mut WorkspaceSnapshot, ids: &[String]) -> Result<()> {
    use std::collections::{HashMap, HashSet};
    let index: HashMap<String, usize> = s
        .items
        .iter()
        .enumerate()
        .map(|(i, x)| (x.id.clone(), i))
        .collect();
    detach_group_deleted_descendants(s, ids, ids.len() == 1);
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, x) in s.items.iter().enumerate() {
        groups.entry(group_key(x)).or_default().push(i);
    }
    for group in groups.values_mut() {
        group.sort_by_key(|i| s.items[*i].position);
    }
    let mut affected = HashSet::new();
    for id in ids {
        let i = *index.get(id).ok_or_else(stale)?;
        let mut cursor = Some(i);
        let mut trashed = false;
        while let Some(j) = cursor {
            if s.items[j].deleted_at.is_some() {
                trashed = true;
                break;
            }
            cursor = s.items[j]
                .parent_id
                .as_ref()
                .and_then(|id| index.get(id))
                .copied();
        }
        if !trashed {
            return Err(stale());
        }
        let old_key = group_key(&s.items[i]);
        let old = groups.get_mut(&old_key).ok_or_else(stale)?;
        let at = old.iter().position(|x| *x == i).ok_or_else(stale)?;
        old.remove(at);
        affected.insert(old_key);
        let parent = s.items[i].restore_parent_id.clone().filter(|id| {
            let mut cursor = index.get(id).copied();
            while let Some(i) = cursor {
                if s.items[i].deleted_at.is_some() {
                    return false;
                }
                cursor = s.items[i]
                    .parent_id
                    .as_ref()
                    .and_then(|id| index.get(id))
                    .copied();
            }
            index.contains_key(id)
        });
        if let Some(parent) = &parent {
            let owner = &mut s.items[index[parent]];
            if owner.kind == Kind::Note {
                owner.kind = Kind::Tree;
                touch(owner);
            }
        }
        let new_key = parent.clone().unwrap_or_else(|| "live".into());
        let target = groups.entry(new_key.clone()).or_default();
        let at = s.items[i]
            .restore_index
            .map(|v| v as usize)
            .unwrap_or(target.len())
            .min(target.len());
        target.insert(at, i);
        affected.insert(new_key);
        let x = &mut s.items[i];
        x.parent_id = parent;
        x.deleted_at = None;
        x.restore_parent_id = None;
        x.restore_index = None;
        touch(x);
    }
    for key in affected {
        for (rank, i) in groups[&key].iter().enumerate() {
            s.items[*i].position = rank as i64;
        }
    }
    let restored: HashSet<_> = ids.iter().collect();
    s.undo_delete_ids.retain(|id| !restored.contains(id));
    Ok(())
}
pub fn structural_items(s: &WorkspaceSnapshot) -> Vec<StructuralItem> {
    let mut items: Vec<_> = s
        .items
        .iter()
        .map(|x| StructuralItem {
            id: x.id.clone(),
            parent_id: x.parent_id.clone(),
            kind: x.kind.clone(),
            position: x.position,
            deleted_at: x.deleted_at,
            restore_parent_id: x.restore_parent_id.clone(),
            restore_index: x.restore_index,
        })
        .collect();
    items.sort_by(|a, b| a.id.cmp(&b.id));
    items
}
fn from_structure(items: &[StructuralItem], ids: &[String]) -> Result<WorkspaceSnapshot> {
    if items.len() > 20000 {
        return Err(stale());
    }
    let s = WorkspaceSnapshot {
        items: items
            .iter()
            .map(|x| Item {
                id: x.id.clone(),
                parent_id: x.parent_id.clone(),
                kind: x.kind.clone(),
                markdown: String::new(),
                done: false,
                color: None,
                position: x.position,
                created_at: 0,
                updated_at: 0,
                deleted_at: x.deleted_at,
                restore_parent_id: x.restore_parent_id.clone(),
                restore_index: x.restore_index,
            })
            .collect(),
        drafts: vec![],
        undo_delete_ids: ids.to_vec(),
    };
    if structural_items(&s) != items {
        return Err(stale());
    }
    backup::encode(&s)?;
    Ok(s)
}
fn structural_key(x: &StructuralItem) -> String {
    x.parent_id.clone().unwrap_or_else(|| {
        if x.deleted_at.is_some() {
            "trash".into()
        } else {
            "live".into()
        }
    })
}
fn subtree_union(
    s: &WorkspaceSnapshot,
    roots: &std::collections::HashSet<String>,
) -> std::collections::HashSet<String> {
    use std::collections::{HashMap, HashSet};
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for x in &s.items {
        if let Some(parent) = x.parent_id.as_deref() {
            children.entry(parent).or_default().push(&x.id);
        }
    }
    let mut result = HashSet::new();
    let mut pending: Vec<&str> = roots.iter().map(String::as_str).collect();
    while let Some(id) = pending.pop() {
        if result.insert(id.to_string()) {
            if let Some(xs) = children.get(id) {
                pending.extend(xs);
            }
        }
    }
    result
}
fn replay_matches(
    s: &WorkspaceSnapshot,
    before: &WorkspaceSnapshot,
    after: &WorkspaceSnapshot,
    ids: &[String],
) -> bool {
    use std::collections::{HashMap, HashSet};
    let old: HashMap<_, _> = structural_items(before)
        .into_iter()
        .map(|x| (x.id.clone(), x))
        .collect();
    let expected: HashMap<_, _> = structural_items(after)
        .into_iter()
        .map(|x| (x.id.clone(), x))
        .collect();
    let actual: HashMap<_, _> = structural_items(s)
        .into_iter()
        .map(|x| (x.id.clone(), x))
        .collect();
    let mut groups = HashSet::new();
    let mut roots: HashSet<String> = ids.iter().cloned().collect();
    for (id, x) in &expected {
        if old.get(id) != Some(x) {
            groups.insert(structural_key(x));
            groups.insert(structural_key(&old[id]));
            if x.parent_id != old[id].parent_id {
                roots.insert(id.clone());
            }
        }
    }
    for (id, x) in &expected {
        if (groups.contains(&structural_key(x)) || roots.contains(id)) && actual.get(id) != Some(x)
        {
            return false;
        }
    }
    let ordered_groups = |records: &HashMap<String, StructuralItem>| {
        let mut result: HashMap<String, Vec<&StructuralItem>> = HashMap::new();
        for x in records.values() {
            result.entry(structural_key(x)).or_default().push(x);
        }
        result
            .into_iter()
            .map(|(key, mut group)| {
                group.sort_by_key(|x| x.position);
                (
                    key,
                    group.into_iter().map(|x| x.id.clone()).collect::<Vec<_>>(),
                )
            })
            .collect::<HashMap<_, _>>()
    };
    let expected_groups = ordered_groups(&expected);
    let actual_groups = ordered_groups(&actual);
    for key in groups {
        let wanted = expected_groups.get(&key).map(Vec::as_slice).unwrap_or(&[]);
        let found = actual_groups.get(&key).map(Vec::as_slice).unwrap_or(&[]);
        if key == "trash" {
            if found.get(..wanted.len()) != Some(wanted) {
                return false;
            }
        } else if wanted != found {
            return false;
        }
    }
    let wanted = subtree_union(after, &roots);
    let found = subtree_union(s, &roots);
    wanted == found && wanted.iter().all(|id| actual.get(id) == expected.get(id))
}
fn structural_action<F>(
    s: &mut WorkspaceSnapshot,
    ids: &[String],
    proof: &StructuralProof,
    undo: bool,
    apply: F,
) -> Result<bool>
where
    F: Fn(&mut WorkspaceSnapshot) -> Result<()>,
{
    unique_ids(ids)?;
    if ids.is_empty() {
        return Err(stale());
    }
    let before = from_structure(&proof.before, if undo { ids } else { &[] })?;
    let mut after = before.clone();
    apply(&mut after)?;
    if structural_items(&after) != proof.after {
        return Err(stale());
    }
    if structural_items(s) == proof.before && (!undo || s.undo_delete_ids == ids) {
        apply(s)?;
        return Ok(true);
    }
    if !replay_matches(s, &before, &after, ids) {
        return Err(stale());
    }
    Ok(false)
}
pub fn capture_undo(s: &WorkspaceSnapshot) -> Result<UndoDeleteRequest> {
    let mut after = s.clone();
    restore_group(&mut after, &s.undo_delete_ids)?;
    backup::encode(&after)?;
    if s.undo_delete_ids.is_empty() {
        return Err(stale());
    }
    Ok(UndoDeleteRequest {
        ids: s.undo_delete_ids.clone(),
        proof: StructuralProof {
            before: structural_items(s),
            after: structural_items(&after),
        },
    })
}
pub fn capture_move(s: &WorkspaceSnapshot, mut r: MoveItems) -> Result<MoveItems> {
    let mut after = s.clone();
    apply_move(&mut after, &r)?;
    backup::encode(&after)?;
    r.proof = Some(StructuralProof {
        before: structural_items(s),
        after: structural_items(&after),
    });
    Ok(r)
}
