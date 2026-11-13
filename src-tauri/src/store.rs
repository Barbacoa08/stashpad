use crate::{backup, model::*};
use rusqlite::{params, Connection};
use std::path::Path;
pub struct Store {
    connection: Connection,
}
const TABLE:&str="CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('note','stash')),markdown TEXT NOT NULL,done INTEGER NOT NULL CHECK(done IN (0,1)),color TEXT CHECK(color IN ('red','orange','yellow','green','teal','blue','purple','pink','gray')),position INTEGER NOT NULL CHECK(position>=0),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER,restore_parent_id TEXT,restore_index INTEGER);";
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).map_err(storage_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(3))
            .map_err(storage_error)?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(storage_error)?;
        if !(0..=5).contains(&version) {
            return Err(error(
                "schema_version",
                "This workspace needs a newer app. No data were replaced.",
            ));
        }
        let mut store = Self { connection };
        if version < 4 {
            store
                .connection
                .execute_batch("BEGIN IMMEDIATE;")
                .map_err(storage_error)?;
            let result = (|| {
                if version == 0 {
                    store.connection.execute_batch("CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,markdown TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER);CREATE TABLE IF NOT EXISTS drafts(key TEXT PRIMARY KEY,markdown TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);").map_err(storage_error)?;
                }
                if version < 2 {
                    store.connection.execute_batch("CREATE TABLE stashes(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);ALTER TABLE notes ADD COLUMN stash_id TEXT;").map_err(storage_error)?;
                }
                if version < 3 {
                    store.connection.execute_batch("ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1));").map_err(storage_error)?;
                }
                let old = store.read_legacy()?;
                crate::legacy_backup::encode(&old)?;
                let current = backup::convert_legacy(old);
                backup::encode(&current).map_err(|e|if e.code=="capacity_exceeded"{error("capacity_exceeded","The converted workspace exceeds the 10 MiB backup capacity. All prior data and settings are retained.")}else{e})?;
                store
                    .connection
                    .execute_batch(TABLE)
                    .map_err(storage_error)?;
                Self::write_rows(&store.connection, &current)?;
                store
                    .connection
                    .execute_batch(
                        "DROP TABLE notes;DROP TABLE stashes;PRAGMA user_version=5;COMMIT;",
                    )
                    .map_err(storage_error)
            })();
            if let Err(e) = result {
                let _ = store.connection.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }
        if version == 4 {
            store
                .connection
                .execute_batch("BEGIN IMMEDIATE;")
                .map_err(storage_error)?;
            let result = (|| {
                let current = store.load()?;
                backup::validate_v4_snapshot(&current)?;
                backup::encode(&current)?;
                store
                    .connection
                    .execute_batch("PRAGMA user_version=5;COMMIT;")
                    .map_err(storage_error)
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
    fn read_undo(&self) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        self.connection
            .query_row(
                "SELECT value FROM settings WHERE key='undoDeleteId'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map(|x: Option<Option<String>>| x.flatten())
            .map_err(storage_error)
    }
    fn read_legacy(&self) -> Result<V3Workspace> {
        let mut s = V3Workspace {
            stashes: vec![],
            notes: vec![],
            drafts: self.read_drafts()?,
            undo_delete_id: self.read_undo()?,
        };
        let mut q = self
            .connection
            .prepare("SELECT id,name,parent_id,created_at,updated_at FROM stashes ORDER BY id")
            .map_err(storage_error)?;
        for r in q
            .query_map([], |r| {
                Ok(LegacyStash {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    parent_id: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            })
            .map_err(storage_error)?
        {
            s.stashes.push(r.map_err(storage_error)?);
        }
        let mut q=self.connection.prepare("SELECT id,stash_id,markdown,done,created_at,updated_at,deleted_at FROM notes ORDER BY id").map_err(storage_error)?;
        for r in q
            .query_map([], |r| {
                let raw: i64 = r.get(3)?;
                if raw != 0 && raw != 1 {
                    return Err(rusqlite::Error::IntegralValueOutOfRange(3, raw));
                }
                Ok(V3Note {
                    id: r.get(0)?,
                    stash_id: r.get(1)?,
                    markdown: r.get(2)?,
                    done: raw == 1,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                    deleted_at: r.get(6)?,
                })
            })
            .map_err(storage_error)?
        {
            s.notes.push(r.map_err(storage_error)?);
        }
        Ok(s)
    }
    pub fn load(&mut self) -> Result<WorkspaceSnapshot> {
        let mut s = WorkspaceSnapshot {
            items: vec![],
            drafts: self.read_drafts()?,
            undo_delete_id: self.read_undo()?,
        };
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
            s.items.push(row.map_err(storage_error)?);
        }
        backup::encode(&s)?;
        Ok(s)
    }
    fn write_rows(c: &Connection, s: &WorkspaceSnapshot) -> Result<()> {
        c.execute("DELETE FROM drafts", []).map_err(storage_error)?;
        c.execute("DELETE FROM items", []).map_err(storage_error)?;
        for x in &s.items {
            let kind = if x.kind == Kind::Stash {
                "stash"
            } else {
                "note"
            };
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
        c.execute("DELETE FROM settings WHERE key='undoDeleteId'", [])
            .map_err(storage_error)?;
        if let Some(id) = &s.undo_delete_id {
            c.execute("INSERT INTO settings VALUES ('undoDeleteId',?1)", [id])
                .map_err(storage_error)?;
        }
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
    pub fn create_child_stash(&mut self, r: &CreateChildStash) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        create(&mut s, &r.id, &r.parent, Kind::Stash, "Untitled")?;
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
            x.kind = Kind::Stash;
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
        x.deleted_at = Some(now());
        x.position = rank;
        touch(x);
        normalize(
            &mut s,
            &old.into_iter().filter(|key| key != id).collect::<Vec<_>>(),
        );
        s.undo_delete_id = Some(id.into());
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
    pub fn undo(&mut self) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        if let Some(id) = s.undo_delete_id.clone() {
            restore(&mut s, &id)?;
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
        if s.undo_delete_id
            .as_ref()
            .is_some_and(|id| removed.contains(id))
        {
            s.undo_delete_id = None;
        }
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
        validate_location(&s, &r.from, false)?;
        validate_location(&s, &r.to, false)?;
        if r.from.scope != r.to.scope {
            return Err(stale());
        }
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
        let actual_from = group(&s, &r.from);
        let actual_to = group(&s, &r.to);
        if actual_from == r.after_from && actual_to == r.after_to {
            return Ok(s);
        }
        if actual_from != r.before_from || actual_to != r.before_to {
            return Err(stale());
        }
        let all_dates = deletion_dates(&s);
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
            if r.to.scope == Scope::Trash
                && x.deleted_at.is_none()
                && (r.to.item_id.is_none() || date != destination_date)
            {
                x.deleted_at = date;
                x.restore_parent_id = x.parent_id.clone();
                x.restore_index = Some(old_index as i64);
            }
            x.parent_id = r.to.item_id.clone();
            touch(x);
        }
        normalize(&mut s, &r.after_from);
        normalize(&mut s, &r.after_to);
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
            "This item is unavailable. Your input is retained.",
        )
    })
}
fn find_mut<'a>(s: &'a mut WorkspaceSnapshot, id: &str) -> Result<&'a mut Item> {
    s.items.iter_mut().find(|x| x.id == id).ok_or_else(|| {
        error(
            "not_found",
            "This item is unavailable. Your input is retained.",
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
                "This item is unavailable. Your input is retained.",
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
        if (!allow_note && x.kind != Kind::Stash) || effective_scope(s, id)? != at.scope {
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
            x.kind = Kind::Stash;
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
    let x = find(s, id)?;
    let parent = x
        .restore_parent_id
        .as_ref()
        .filter(|parent| effective_scope(s, parent).is_ok_and(|scope| scope == Scope::Live))
        .cloned();
    let index = x.restore_index;
    let old_location = item_location(s, id)?;
    let roots = detach_deleted_descendants(s, id);
    let old = if old_location.item_id.is_none() {
        roots
    } else {
        normalize(s, &roots);
        group(s, &old_location)
    };
    if let Some(parent) = parent.as_deref() {
        let owner = find_mut(s, parent)?;
        if owner.kind == Kind::Note {
            owner.kind = Kind::Stash;
            touch(owner);
        }
    }
    let mut target = group(
        s,
        &Location {
            scope: Scope::Live,
            item_id: parent.clone(),
        },
    );
    let at = (index.unwrap_or(target.len() as i64) as usize).min(target.len());
    target.insert(at, id.into());
    let x = find_mut(s, id)?;
    x.parent_id = parent;
    x.deleted_at = None;
    x.restore_parent_id = None;
    x.restore_index = None;
    touch(x);
    normalize(s, &old.into_iter().filter(|x| x != id).collect::<Vec<_>>());
    normalize(s, &target);
    if s.undo_delete_id.as_deref() == Some(id) {
        s.undo_delete_id = None;
    }
    Ok(())
}

fn stale() -> AppError {
    error("stale_structure", "The captured items or destination changed. Review the action again; your content is retained.")
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
                x.kind = Kind::Stash;
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
fn detach_deleted_descendants(s: &mut WorkspaceSnapshot, id: &str) -> Vec<String> {
    // Item indices remain stable: only parent edges and ranks change in this pass.
    let mut children: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    let mut roots: Vec<usize> = Vec::new();
    for (index, x) in s.items.iter().enumerate() {
        if let Some(parent) = &x.parent_id {
            children.entry(parent.clone()).or_default().push(index);
        } else if x.deleted_at.is_some() {
            roots.push(index);
        }
    }
    roots.sort_by_key(|index| s.items[*index].position);
    let mut pending = children.get(id).cloned().unwrap_or_default();
    let mut detached = std::collections::HashSet::new();
    let mut affected = std::collections::HashSet::new();
    while let Some(index) = pending.pop() {
        let x = &s.items[index];
        if x.deleted_at.is_some() {
            affected.insert(x.parent_id.clone().expect("descendant has parent"));
            detached.insert(index);
            roots.push(index);
        } else if let Some(xs) = children.get(&x.id) {
            pending.extend(xs.iter().copied());
        }
    }
    for index in &detached {
        s.items[*index].parent_id = None;
    }
    // Stop at nearest explicit deletion roots, and normalize each affected group
    // once without repeatedly scanning the workspace or rebuilding its scope index.
    for parent in affected {
        let mut remaining: Vec<usize> = children[&parent]
            .iter()
            .copied()
            .filter(|index| !detached.contains(index))
            .collect();
        remaining.sort_by_key(|index| s.items[*index].position);
        for (position, index) in remaining.into_iter().enumerate() {
            s.items[index].position = position as i64;
        }
    }
    // Restore removes its root before ranking the final Trash-root group once.
    roots
        .into_iter()
        .map(|index| s.items[index].id.clone())
        .collect()
}
