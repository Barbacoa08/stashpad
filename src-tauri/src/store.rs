use crate::{backup, model::*};
use rusqlite::{params, Connection};
use std::path::Path;
pub struct Store {
    connection: Connection,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).map_err(storage_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(3))
            .map_err(storage_error)?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(storage_error)?;
        if version > 1 {
            return Err(error(
                "schema_version",
                "This workspace needs a newer app. No data were replaced.",
            ));
        }
        connection.execute_batch("BEGIN; CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, markdown TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER); CREATE TABLE IF NOT EXISTS drafts(key TEXT PRIMARY KEY,markdown TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT); PRAGMA user_version=1; COMMIT;").map_err(storage_error)?;
        let mut store = Self { connection };
        store.load()?;
        Ok(store)
    }
    pub fn load(&mut self) -> Result<WorkspaceSnapshot> {
        let mut s = WorkspaceSnapshot::default();
        {
            let mut statement = self
                .connection
                .prepare(
                    "SELECT id,markdown,created_at,updated_at,deleted_at FROM notes ORDER BY id",
                )
                .map_err(storage_error)?;
            let rows = statement
                .query_map([], |r| {
                    Ok(Note {
                        id: r.get(0)?,
                        markdown: r.get(1)?,
                        created_at: r.get(2)?,
                        updated_at: r.get(3)?,
                        deleted_at: r.get(4)?,
                    })
                })
                .map_err(storage_error)?;
            for n in rows {
                s.notes.push(n.map_err(storage_error)?)
            }
            let mut statement = self
                .connection
                .prepare("SELECT key,markdown,revision,updated_at FROM drafts ORDER BY key")
                .map_err(storage_error)?;
            let rows = statement
                .query_map([], |r| {
                    Ok(Draft {
                        key: r.get(0)?,
                        markdown: r.get(1)?,
                        revision: r.get(2)?,
                        updated_at: r.get(3)?,
                    })
                })
                .map_err(storage_error)?;
            for d in rows {
                s.drafts.push(d.map_err(storage_error)?)
            }
            let mut statement = self
                .connection
                .prepare("SELECT value FROM settings WHERE key='undoDeleteId'")
                .map_err(storage_error)?;
            let mut rows = statement.query([]).map_err(storage_error)?;
            if let Some(row) = rows.next().map_err(storage_error)? {
                s.undo_delete_id = row.get(0).map_err(storage_error)?;
            }
        }
        backup::encode(&s).map_err(|_|error("storage_invalid","The local workspace is invalid. Retry or use a verified recovery copy; no empty substitute was loaded."))?;
        Ok(s)
    }
    pub fn replace(&mut self, s: &WorkspaceSnapshot) -> Result<WorkspaceSnapshot> {
        self.replace_with_failure(s, false)
    }
    pub fn replace_with_failure(
        &mut self,
        s: &WorkspaceSnapshot,
        fail: bool,
    ) -> Result<WorkspaceSnapshot> {
        backup::encode(s).map_err(|_|error("capacity_exceeded","The proposed workspace exceeds backup capacity or contains invalid references. Your input is retained."))?;
        let tx = self.connection.transaction().map_err(storage_error)?;
        tx.execute("DELETE FROM drafts", [])
            .map_err(storage_error)?;
        tx.execute("DELETE FROM notes", []).map_err(storage_error)?;
        tx.execute("DELETE FROM settings", [])
            .map_err(storage_error)?;
        for n in &s.notes {
            tx.execute(
                "INSERT INTO notes VALUES (?1,?2,?3,?4,?5)",
                params![n.id, n.markdown, n.created_at, n.updated_at, n.deleted_at],
            )
            .map_err(storage_error)?;
        }
        for d in &s.drafts {
            tx.execute(
                "INSERT INTO drafts VALUES (?1,?2,?3,?4)",
                params![d.key, d.markdown, d.revision, d.updated_at],
            )
            .map_err(storage_error)?;
        }
        tx.execute(
            "INSERT INTO settings VALUES ('undoDeleteId',?1)",
            params![s.undo_delete_id],
        )
        .map_err(storage_error)?;
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
        if s.drafts
            .iter()
            .any(|d| d.key == key && d.revision >= revision)
        {
            return Ok(s);
        }
        s.drafts.retain(|d| d.key != key);
        s.drafts.push(Draft {
            key: key.into(),
            markdown: markdown.into(),
            revision,
            updated_at: now(),
        });
        self.replace(&s)
    }
    pub fn save(
        &mut self,
        id: Option<&str>,
        markdown: &str,
        draft_key: &str,
        revision: i64,
    ) -> Result<WorkspaceSnapshot> {
        if markdown.trim().is_empty() {
            return Err(error(
                "empty_note",
                "Enter non-whitespace text before saving. Your draft is retained.",
            ));
        }
        let mut s = self.load()?;
        if let Some(id) = id {
            let n = s
                .notes
                .iter_mut()
                .find(|n| n.id == id && n.deleted_at.is_none())
                .ok_or_else(|| {
                    error(
                        "not_found",
                        "This active note is unavailable. Your input is retained.",
                    )
                })?;
            n.markdown = markdown.into();
            n.updated_at = now().max(n.updated_at.saturating_add(1));
        } else {
            let time = now();
            s.notes.push(Note {
                id: uuid::Uuid::new_v4().to_string(),
                markdown: markdown.into(),
                created_at: time,
                updated_at: time,
                deleted_at: None,
            });
        }
        s.drafts
            .retain(|d| d.key != draft_key || d.revision > revision);
        self.replace(&s)
    }
    pub fn discard_draft(&mut self, key: &str) -> Result<WorkspaceSnapshot> {
        let mut snapshot = self.load()?;
        snapshot.drafts.retain(|draft| draft.key != key);
        self.replace(&snapshot)
    }
    pub fn delete(&mut self, id: &str) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        let n = s
            .notes
            .iter_mut()
            .find(|n| n.id == id && n.deleted_at.is_none())
            .ok_or_else(|| error("not_found", "This note is unavailable."))?;
        n.deleted_at = Some(now());
        s.drafts.retain(|d| d.key != id);
        s.undo_delete_id = Some(id.into());
        self.replace(&s)
    }
    pub fn undo(&mut self) -> Result<WorkspaceSnapshot> {
        let mut s = self.load()?;
        if let Some(id) = s.undo_delete_id.take() {
            let n = s
                .notes
                .iter_mut()
                .find(|n| n.id == id)
                .ok_or_else(|| error("not_found", "The deleted note is unavailable."))?;
            n.deleted_at = None;
        }
        self.replace(&s)
    }
    pub fn restore_with_safety(
        &mut self,
        s: &WorkspaceSnapshot,
        path: &Path,
        fail_transaction: bool,
    ) -> Result<WorkspaceSnapshot> {
        let current = self.load()?;
        backup::encode(s)?;
        backup::atomic_write(path, &backup::encode(&current)?)?;
        self.replace_with_failure(s, fail_transaction)
    }
}
