mod common;
use common::*;
use stashpad_alpha_kit::{model::*, store::Store};
fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let db = Store::open(&dir.path().join("notes.sqlite3")).unwrap();
    (dir, db)
}
#[test]
fn exact_source_create_edit_reopen() {
    let (dir, mut db) = store();
    let source = "α **bold**  \n- one\n  - two\n```js\nconst x='*';\n```\n";
    let s = db.save(None, source, "compose", 1, None).unwrap();
    let id = s.items[0].id.clone();
    db.save(Some(&id), "edited \n", &id, 2, None).unwrap();
    drop(db);
    let mut db = Store::open(&dir.path().join("notes.sqlite3")).unwrap();
    assert_eq!(db.load().unwrap().items[0].markdown, "edited \n");
}
#[test]
fn latest_revision_and_save_preserves_newer_draft() {
    let (_dir, mut db) = store();
    db.checkpoint("compose", "newer", 3).unwrap();
    db.checkpoint("compose", "older", 2).unwrap();
    let s = db.save(None, "saved", "compose", 2, None).unwrap();
    assert_eq!(s.drafts[0].markdown, "newer");
}
#[test]
fn delete_undo_after_reopen() {
    let (dir, mut db) = store();
    let s = db.save(None, "a", "compose", 1, None).unwrap();
    let id = &s.items[0].id;
    db.delete(id).unwrap();
    drop(db);
    let mut db = Store::open(&dir.path().join("notes.sqlite3")).unwrap();
    assert!(db.load().unwrap().undo_delete_id.is_some());
    assert_eq!(db.undo().unwrap().items[0].deleted_at, None);
}
#[test]
fn atomic_failure_rolls_back() {
    let (_dir, mut db) = store();
    let before = db.load().unwrap();
    assert!(db.save(None, " ", "compose", 1, None).is_err());
    assert_eq!(db.load().unwrap(), before);
}
#[test]
fn invalid_initial_read_is_error() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("notes.sqlite3");
    std::fs::write(&p, b"not a sqlite database").unwrap();
    assert!(Store::open(&p).is_err());
}
#[test]
fn capacity_source_and_envelope_overhead() {
    let (_dir, mut db) = store();
    let source = "x".repeat(MAX_SOURCE);
    let s = db.save(None, &source, "compose", 1, None).unwrap();
    assert!(db
        .save(None, &"x".repeat(MAX_SOURCE + 1), "compose", 2, None)
        .is_err());
    assert_eq!(db.load().unwrap(), s);
    let bytes = stashpad_alpha_kit::backup::encode(&s).unwrap();
    assert_eq!(
        stashpad_alpha_kit::backup::validate(&bytes)
            .unwrap()
            .workspace,
        s
    );
}

#[test]
fn transaction_failure_keeps_previous_rows() {
    let (_dir, mut db) = store();
    let s = db.save(None, "committed", "compose", 1, None).unwrap();
    assert!(db
        .replace_with_failure(&WorkspaceSnapshot::default(), true)
        .is_err());
    assert_eq!(db.load().unwrap(), s);
}
#[test]
fn monotonic_timestamp_under_backward_clock() {
    let (_dir, mut db) = store();
    let mut s = db.save(None, "a", "compose", 1, None).unwrap();
    s.items[0].updated_at += 1_000_000;
    let old = s.items[0].updated_at;
    db.replace(&s).unwrap();
    let s = db
        .save(Some(&s.items[0].id), "b", &s.items[0].id, 2, None)
        .unwrap();
    assert_eq!(s.items[0].updated_at, old + 1);
}
#[test]
fn full_note_draft_count_boundary_roundtrips() {
    let (_dir, mut db) = store();
    let mut s = WorkspaceSnapshot::default();
    for i in 0..20000 {
        let id = uuid::Uuid::from_u128(i + 1).to_string();
        s.items.push(Item {
            parent_id: None,
            id: id.clone(),
            markdown: "x".into(),
            created_at: 0,
            updated_at: 0,
            done: false,
            deleted_at: None,
            position: i as i64,
            ..item()
        });
        s.drafts.push(Draft {
            key: id,
            markdown: "draft".into(),
            revision: 1,
            updated_at: 0,
        });
    }
    s.drafts.push(Draft {
        key: "compose".into(),
        markdown: "compose".into(),
        revision: 1,
        updated_at: 0,
    });
    let committed = db.replace(&s).unwrap();
    let bytes = stashpad_alpha_kit::backup::encode(&committed).unwrap();
    let roundtrip = stashpad_alpha_kit::backup::validate(&bytes).unwrap();
    assert_eq!(db.replace(&roundtrip.workspace).unwrap(), committed);
    assert!(db.save(None, "one over", "compose", 1, None).is_err());
    assert_eq!(db.load().unwrap(), committed);
}
#[test]
fn compact_envelope_exact_limit_includes_drafts_and_metadata() {
    let (_dir, mut db) = store();
    let mut s = WorkspaceSnapshot::default();
    for i in 0..9 {
        s.items.push(Item {
            parent_id: None,
            id: uuid::Uuid::from_u128(i + 1).to_string(),
            markdown: "x".repeat(MAX_SOURCE),
            created_at: 0,
            updated_at: 0,
            done: false,
            deleted_at: None,
            position: i as i64,
            ..item()
        });
    }
    s.drafts.push(Draft {
        key: "compose".into(),
        markdown: String::new(),
        revision: 1,
        updated_at: 0,
    });
    let overhead = stashpad_alpha_kit::backup::encode(&s).unwrap().len();
    s.drafts[0].markdown = "x".repeat(MAX_ENVELOPE - overhead);
    let committed = db.replace(&s).unwrap();
    let bytes = stashpad_alpha_kit::backup::encode(&committed).unwrap();
    assert_eq!(bytes.len(), MAX_ENVELOPE);
    assert_eq!(
        stashpad_alpha_kit::backup::validate(&bytes)
            .unwrap()
            .workspace,
        committed
    );
    let over = format!("{}x", committed.drafts[0].markdown);
    assert!(db.checkpoint("compose", &over, 2).is_err());
    assert_eq!(db.load().unwrap(), committed);
}
#[test]
fn cancel_edit_discards_only_its_draft_and_survives_reopen() {
    let (dir, mut db) = store();
    let s = db.save(None, "saved", "compose", 1, None).unwrap();
    let id = s.items[0].id.clone();
    db.checkpoint("compose", "capture", 2).unwrap();
    db.checkpoint(&id, "unfinished", 3).unwrap();
    db.discard_draft(&id).unwrap();
    drop(db);
    let mut db = Store::open(&dir.path().join("notes.sqlite3")).unwrap();
    let s = db.load().unwrap();
    assert_eq!(s.items[0].markdown, "saved");
    assert_eq!(s.drafts.len(), 1);
    assert_eq!(s.drafts[0].key, "compose");
    assert_eq!(s.drafts[0].markdown, "capture");
}

#[test]
fn actual_v1_file_migrates_additively_and_failed_migration_rolls_back() {
    for invalid in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite3");
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE notes(id TEXT PRIMARY KEY,markdown TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER);CREATE TABLE drafts(key TEXT PRIMARY KEY,markdown TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);PRAGMA user_version=1;").unwrap();
        let id = if invalid {
            "bad-id"
        } else {
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        };
        c.execute(
            "INSERT INTO notes VALUES (?1,?2,0,0,0)",
            rusqlite::params![id, "exact\r\n**source**"],
        )
        .unwrap();
        c.execute("INSERT INTO settings VALUES ('undoDeleteId',?1)", [id])
            .unwrap();
        let active = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
        c.execute(
            "INSERT INTO notes VALUES (?1,?2,1,2,NULL)",
            rusqlite::params![active, "active exact\r\n"],
        )
        .unwrap();
        c.execute(
            "INSERT INTO drafts VALUES (?1,?2,4,5)",
            rusqlite::params![active, "note draft exact\r\n"],
        )
        .unwrap();
        c.execute(
            "INSERT INTO drafts VALUES ('compose',?1,6,7)",
            ["Home draft exact\r\n"],
        )
        .unwrap();
        drop(c);
        if invalid {
            assert!(Store::open(&path).is_err());
            let c = rusqlite::Connection::open(&path).unwrap();
            assert_eq!(
                c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                c.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name='stash_id'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        } else {
            let mut s = Store::open(&path).unwrap();
            let v = serde_json::to_value(s.load().unwrap()).unwrap();
            assert!(v["items"].as_array().unwrap().iter().any(|n| n["id"] == id
                && n["markdown"] == "exact\r\n**source**"
                && n["deletedAt"] == 0));
            assert_eq!(v["undoDeleteId"], id);
            let snapshot = s.load().unwrap();
            assert!(snapshot.items.iter().any(|n| n.id == active
                && n.parent_id.is_none()
                && n.markdown == "active exact\r\n"
                && n.created_at == 1
                && n.updated_at == 2));
            assert!(snapshot.drafts.iter().any(|d| d.key == active
                && d.markdown == "note draft exact\r\n"
                && d.revision == 4
                && d.updated_at == 5));
            assert!(snapshot.drafts.iter().any(|d| d.key == "compose"
                && d.markdown == "Home draft exact\r\n"
                && d.revision == 6
                && d.updated_at == 7));
            drop(s);
            assert!(Store::open(&path).is_ok());
        }
    }
}

#[test]
fn nested_storage_scoped_drafts_and_edit_ownership_survive_reopen() {
    let (dir, mut db) = store();
    let s = db.create_stash(" Parent ", None).unwrap();
    let parent = s
        .items
        .iter()
        .find(|x| x.kind == Kind::Stash)
        .unwrap()
        .id
        .clone();
    let s = db.create_stash("Child", Some(&parent)).unwrap();
    let child = s
        .items
        .iter()
        .find(|s| s.parent_id.is_some())
        .unwrap()
        .id
        .clone();
    db.checkpoint("compose", "Home draft", 1).unwrap();
    db.checkpoint(&compose_key(Some(&parent)), "Parent draft", 1)
        .unwrap();
    db.checkpoint(&compose_key(Some(&child)), "Child draft", 1)
        .unwrap();
    let s = db
        .save(
            None,
            "exact\r\n",
            &compose_key(Some(&child)),
            1,
            Some(&child),
        )
        .unwrap();
    let index = s.items.iter().position(|x| x.kind == Kind::Note).unwrap();
    let id = s.items[index].id.clone();
    assert_eq!(s.items[index].parent_id.as_deref(), Some(child.as_str()));
    let s = db
        .save(Some(&id), "edited\r\n", &id, 2, Some(&parent))
        .unwrap();
    assert_eq!(
        s.items
            .iter()
            .find(|x| x.kind == Kind::Note)
            .unwrap()
            .parent_id
            .as_deref(),
        Some(child.as_str())
    );
    assert!(db.create_stash("bad", Some("missing")).is_err());
    assert_eq!(db.load().unwrap(), s);
    db.rename_stash(&parent, "Renamed").unwrap();
    drop(db);
    let mut db = Store::open(&dir.path().join("notes.sqlite3")).unwrap();
    let s = db.load().unwrap();
    assert_eq!(
        s.items
            .iter()
            .find(|x| x.kind == Kind::Note)
            .unwrap()
            .markdown,
        "edited\r\n"
    );
    assert_eq!(s.drafts.len(), 2);
    assert_eq!(
        s.items.iter().find(|s| s.id == parent).unwrap().markdown,
        "Renamed"
    );
}
#[test]
fn stash_source_is_full_markdown_without_legacy_name_limits() {
    let (_dir, mut db) = store();
    let source = "\u{feff}Name\u{feff}";
    let s = db.create_stash(source, None).unwrap();
    assert_eq!(s.items[0].markdown, source);
    assert!(db.create_stash(&"😀".repeat(201), None).is_ok());
    assert!(db.create_stash("", None).is_ok());
}

#[test]
fn future_schema_is_rejected_without_changing_existing_rows_or_file() {
    let (dir, mut db) = store();
    db.save(None, "retained", "compose", 1, None).unwrap();
    drop(db);
    let path = dir.path().join("notes.sqlite3");
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute_batch("PRAGMA user_version=6;").unwrap();
    drop(c);
    let before = std::fs::read(&path).unwrap();
    assert!(Store::open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn empty_existing_note_preserves_identity_owner_and_exact_whitespace() {
    let (dir, mut db) = store();
    let s = db.create_stash("Owner", None).unwrap();
    let owner = s
        .items
        .iter()
        .find(|x| x.kind == Kind::Stash)
        .unwrap()
        .id
        .clone();
    let s = db
        .save(
            None,
            "initial",
            &format!("compose:{owner}"),
            1,
            Some(&owner),
        )
        .unwrap();
    let id = s
        .items
        .iter()
        .find(|x| x.kind == Kind::Note)
        .unwrap()
        .id
        .clone();
    for source in ["", " \r\n\n\t"] {
        let s = db.save(Some(&id), source, &id, 2, Some(&owner)).unwrap();
        assert_eq!(
            s.items.iter().find(|x| x.kind == Kind::Note).unwrap().id,
            id
        );
        assert_eq!(
            s.items
                .iter()
                .find(|x| x.kind == Kind::Note)
                .unwrap()
                .parent_id
                .as_deref(),
            Some(owner.as_str())
        );
        assert_eq!(
            s.items
                .iter()
                .find(|x| x.kind == Kind::Note)
                .unwrap()
                .markdown,
            source
        );
        assert!(s
            .items
            .iter()
            .find(|x| x.kind == Kind::Note)
            .unwrap()
            .deleted_at
            .is_none());
    }
    assert!(db.save(None, "", "compose", 1, None).is_err());
    drop(db);
    let mut db = Store::open(&dir.path().join("notes.sqlite3")).unwrap();
    assert_eq!(
        db.load()
            .unwrap()
            .items
            .iter()
            .find(|x| x.id == id)
            .unwrap()
            .markdown,
        " \r\n\n\t"
    );
}
