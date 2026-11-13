use rusqlite::{params, Connection};
use stashpad_alpha_kit::{backup, model::*, store::Store};
const ID: &str = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const DELETED: &str = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
const OWNER: &str = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";
fn legacy(path: &std::path::Path, version: i64) -> Connection {
    let c = Connection::open(path).unwrap();
    c.execute_batch("CREATE TABLE notes(id TEXT PRIMARY KEY,markdown TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER);CREATE TABLE drafts(key TEXT PRIMARY KEY,markdown TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);").unwrap();
    c.execute_batch(&format!("PRAGMA user_version={version};"))
        .unwrap();
    c.execute(
        "INSERT INTO notes VALUES (?1,?2,1,2,NULL)",
        params![ID, "α\r\n**source**\n"],
    )
    .unwrap();
    c.execute("INSERT INTO notes VALUES (?1,'deleted',3,4,5)", [DELETED])
        .unwrap();
    c.execute("INSERT INTO drafts VALUES (?1,'unfinished\r\n',6,7)", [ID])
        .unwrap();
    c.execute("INSERT INTO drafts VALUES ('compose','capture',8,9)", [])
        .unwrap();
    c.execute("INSERT INTO settings VALUES ('undoDeleteId',?1)", [DELETED])
        .unwrap();
    c.execute("INSERT INTO settings VALUES ('unrelated','retained')", [])
        .unwrap();
    if version == 2 {
        c.execute_batch("CREATE TABLE stashes(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);ALTER TABLE notes ADD COLUMN stash_id TEXT;").unwrap();
        c.execute("INSERT INTO stashes VALUES (?1,'Owner',NULL,1,2)", [OWNER])
            .unwrap();
        c.execute(
            "UPDATE notes SET stash_id=?1 WHERE id=?2",
            params![OWNER, ID],
        )
        .unwrap();
        c.execute(
            "INSERT INTO drafts VALUES (?1,'scoped',10,11)",
            [format!("compose:{OWNER}")],
        )
        .unwrap();
    }
    c
}

#[test]
fn actual_legacy_migrations_are_transactional_and_preserve_all_metadata() {
    for version in [1, 2] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite3");
        drop(legacy(&path, version));
        let mut db = Store::open(&path).unwrap();
        let s = db.load().unwrap();
        let active = s.items.iter().find(|x| x.id == ID).unwrap();
        assert!(!active.done);
        assert_eq!(active.markdown, "α\r\n**source**\n");
        assert_eq!(active.created_at, 1);
        assert_eq!(active.updated_at, 2);
        assert_eq!(
            active.parent_id.as_deref(),
            if version == 1 { None } else { Some(OWNER) }
        );
        assert_eq!(s.undo_delete_id.as_deref(), Some(DELETED));
        assert_eq!(s.drafts.len(), if version == 1 { 2 } else { 3 });
        db.set_done(ID, true).unwrap();
        drop(db);
        let c = Connection::open(&path).unwrap();
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            5
        );
        assert_eq!(
            c.query_row(
                "SELECT value FROM settings WHERE key='unrelated'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "retained"
        );
        assert!(c.execute("UPDATE items SET done=2", []).is_err());
        assert!(c.prepare("SELECT * FROM notes").is_err());
    }
}
#[test]
fn strict_legacy_and_current_wire_parity() {
    let old: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../tests/fixtures/valid-v1.json")).unwrap();
    for version in [1, 2, 3] {
        let mut b = old.clone();
        b["version"] = version.into();
        if version >= 2 {
            b["workspace"]["stashes"] = serde_json::json!([]);
            for n in b["workspace"]["notes"].as_array_mut().unwrap() {
                n["stashId"] = serde_json::Value::Null;
            }
        }
        if version == 3 {
            for (i, n) in b["workspace"]["notes"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .enumerate()
            {
                n["done"] = (i == 0).into();
            }
        }
        let normalized = backup::validate(&serde_json::to_vec(&b).unwrap()).unwrap();
        assert_eq!(normalized.version, 5);
        assert_eq!(normalized.workspace.items[0].done, version == 3);
        for value in [
            serde_json::Value::Null,
            serde_json::json!(0),
            serde_json::json!("false"),
        ] {
            let mut bad = b.clone();
            bad["workspace"]["notes"][0]["done"] = value;
            assert!(backup::validate(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
        b["workspace"]["notes"][0]
            .as_object_mut()
            .unwrap()
            .remove("done");
        if version == 3 {
            assert!(backup::validate(&serde_json::to_vec(&b).unwrap()).is_err());
        }
    }
}
#[test]
fn new_metadata_overhead_rejects_legacy_capacity_without_migrating() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("capacity.sqlite3");
    let c = legacy(&path, 2);
    c.execute("DELETE FROM notes", []).unwrap();
    c.execute("DELETE FROM drafts", []).unwrap();
    c.execute("DELETE FROM settings WHERE key='undoDeleteId'", [])
        .unwrap();
    c.execute("DELETE FROM stashes", []).unwrap();
    let mut b = serde_json::json!({"format":"stashpad-alpha","version":2,"exportedAt":"2026-11-11T00:00:00.000Z","workspace":{"stashes":[],"notes":[],"drafts":[{"key":"compose","markdown":"","revision":0,"updatedAt":0}],"undoDeleteId":null}});
    for i in 0..9 {
        let id = uuid::Uuid::from_u128(i + 1).to_string();
        let source = "x".repeat(MAX_SOURCE);
        c.execute(
            "INSERT INTO notes VALUES (?1,?2,0,0,NULL,NULL)",
            params![id, source],
        )
        .unwrap();
        b["workspace"]["notes"].as_array_mut().unwrap().push(serde_json::json!({"id":id,"stashId":null,"markdown":source,"createdAt":0,"updatedAt":0,"deletedAt":null}));
    }
    let padding = "x".repeat(MAX_ENVELOPE - serde_json::to_vec(&b).unwrap().len());
    b["workspace"]["drafts"][0]["markdown"] = padding.clone().into();
    c.execute("INSERT INTO drafts VALUES ('compose',?1,0,0)", [padding])
        .unwrap();
    drop(c);
    let before = std::fs::read(&path).unwrap();
    let e = Store::open(&path)
        .err()
        .expect("capacity migration rejected");
    assert!(e.message.contains("10 MiB") && e.message.contains("retained"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(backup::validate(&serde_json::to_vec(&b).unwrap()).is_err());
}
#[test]
fn desired_completion_is_idempotent_monotonic_persistent_and_editable_in_trash() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.sqlite3");
    let mut db = Store::open(&path).unwrap();
    assert!(db.load().unwrap().items.is_empty());
    let s = db
        .capture(&CaptureItem {
            id: ID.into(),
            location: Location {
                scope: Scope::Live,
                item_id: None,
            },
            markdown: "exact\r\nsource".into(),
            draft: DraftAck {
                key: "compose".into(),
                revision: 1,
            },
        })
        .unwrap();
    assert_eq!(db.set_done(ID, false).unwrap(), s);
    let mut s = db.set_done(ID, true).unwrap();
    let time = s.items[0].updated_at;
    assert_eq!(db.set_done(ID, true).unwrap(), s);
    s.items[0].updated_at += 1000000;
    db.replace(&s).unwrap();
    let changed = db.set_done(ID, false).unwrap();
    assert_eq!(changed.items[0].updated_at, s.items[0].updated_at + 1);
    assert_eq!(changed.items[0].markdown, "exact\r\nsource");
    assert!(changed.items[0].updated_at > time);
    db.set_done(ID, true).unwrap();
    db.save_source(
        ID,
        "edited\r\n",
        &DraftAck {
            key: ID.into(),
            revision: 2,
        },
    )
    .unwrap();
    let deleted = db.delete(ID).unwrap();
    let changed = db.set_done(ID, false).unwrap();
    assert_eq!(changed.items[0].deleted_at, deleted.items[0].deleted_at);
    assert!(!changed.items[0].done);
    assert!(db.set_done("missing", true).is_err());
    db.undo().unwrap();
    drop(db);
    let mut db = Store::open(&path).unwrap();
    let saved = db.load().unwrap();
    assert!(!saved.items[0].done);
    assert_eq!(
        backup::validate(&backup::encode(&saved).unwrap())
            .unwrap()
            .workspace,
        saved
    );
    let c = Connection::open(&path).unwrap();
    c.execute_batch("PRAGMA ignore_check_constraints=ON;UPDATE items SET done=2;")
        .unwrap();
    assert!(db.load().is_err());
    drop(db);
    assert!(Store::open(&path).is_err());
}
#[test]
fn owned_legacy_and_completed_current_fixtures_are_shared_with_typescript() {
    for bytes in [
        include_bytes!("../../tests/fixtures/valid-v1.json").as_slice(),
        include_bytes!("../../tests/fixtures/valid-v2.json").as_slice(),
        include_bytes!("../../tests/fixtures/valid-v3.json").as_slice(),
    ] {
        let legacy = stashpad_alpha_kit::legacy_backup::validate(bytes).unwrap();
        let current = backup::validate(bytes).unwrap();
        assert_eq!(current.workspace, backup::convert_legacy(legacy.workspace));
        let value: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        for key in ["deletedAt", "id", "markdown", "createdAt", "updatedAt"] {
            let mut b = value.clone();
            b["workspace"]["notes"][0]
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert!(backup::validate(&serde_json::to_vec(&b).unwrap()).is_err());
        }
    }
}
#[test]
fn invalid_legacy_rows_rollback_every_addition_and_preserve_entire_file() {
    for version in [1, 2] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("invalid.sqlite3");
        let c = legacy(&path, version);
        c.execute("UPDATE notes SET created_at=-1 WHERE id=?1", [ID])
            .unwrap();
        drop(c);
        let before = std::fs::read(&path).unwrap();
        assert!(Store::open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let c = Connection::open(&path).unwrap();
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            version
        );
        assert!(c.prepare("SELECT * FROM items").is_err());
        if version == 1 {
            assert!(c.prepare("SELECT stash_id FROM notes").is_err());
        }
    }
}
#[test]
fn current_completed_utf8_source_capacity_is_exact() {
    let mut s = backup::validate(include_bytes!("../../tests/fixtures/valid-v3.json"))
        .unwrap()
        .workspace;
    s.items.iter_mut().find(|x| x.done).unwrap().markdown = "α".repeat(MAX_SOURCE / 2);
    assert!(backup::encode(&s).is_ok());
    s.items
        .iter_mut()
        .find(|x| x.done)
        .unwrap()
        .markdown
        .push('a');
    assert!(backup::encode(&s).is_err());
}
