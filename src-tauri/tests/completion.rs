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
fn common_rows(c: &Connection, version: i64) -> Vec<String> {
    let notes = if version == 1 {
        "SELECT json_group_array(json_array(id,markdown,created_at,updated_at,deleted_at)) FROM (SELECT * FROM notes ORDER BY id)"
    } else {
        "SELECT json_group_array(json_array(id,markdown,created_at,updated_at,deleted_at,stash_id)) FROM (SELECT * FROM notes ORDER BY id)"
    };
    let mut queries = vec![notes,
        "SELECT json_group_array(json_array(key,markdown,revision,updated_at)) FROM (SELECT * FROM drafts ORDER BY key)",
        "SELECT json_group_array(json_array(key,value)) FROM (SELECT * FROM settings ORDER BY key)"];
    if version == 2 {
        queries.push("SELECT json_group_array(json_array(id,name,parent_id,created_at,updated_at)) FROM (SELECT * FROM stashes ORDER BY id)");
    }
    queries
        .into_iter()
        .map(|query| c.query_row(query, [], |r| r.get(0)).unwrap())
        .collect()
}
#[test]
fn actual_legacy_migrations_are_additive_and_atomic() {
    for version in [1, 2] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite3");
        let c = legacy(&path, version);
        let before = common_rows(&c, version);
        drop(c);
        let mut db = Store::open(&path).unwrap();
        let s = db.load().unwrap();
        let value = serde_json::to_value(&s).unwrap();
        assert!(value["notes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["done"] == false));
        assert_eq!(s.undo_delete_id.as_deref(), Some(DELETED));
        assert_eq!(s.drafts.len(), if version == 1 { 2 } else { 3 });
        assert_eq!(
            s.notes
                .iter()
                .find(|n| n.id == ID)
                .unwrap()
                .stash_id
                .as_deref(),
            if version == 1 { None } else { Some(OWNER) }
        );
        drop(db);
        let c = Connection::open(&path).unwrap();
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        let after = common_rows(&c, version);
        assert_eq!(before, after);
        assert_eq!(
            c.query_row(
                "SELECT value FROM settings WHERE key='unrelated'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "retained"
        );
        assert!(c.execute("UPDATE notes SET done=2", []).is_err());
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
        assert_eq!(normalized.version, 3);
        assert_eq!(
            serde_json::to_value(&normalized).unwrap()["workspace"]["notes"][0]["done"],
            version == 3
        );
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
fn completion_overhead_rejects_legacy_capacity_without_migrating() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("capacity.sqlite3");
    let c = legacy(&path, 2);
    c.execute("DELETE FROM notes", []).unwrap();
    c.execute("DELETE FROM drafts", []).unwrap();
    c.execute("DELETE FROM settings WHERE key='undoDeleteId'", [])
        .unwrap();
    let mut b = serde_json::json!({"format":"stashpad-alpha","version":2,"exportedAt":"2026-11-11T00:00:00.000Z","workspace":{"stashes":[],"notes":[],"drafts":[{"key":"compose","markdown":"","revision":0,"updatedAt":0}],"undoDeleteId":null}});
    c.execute("DELETE FROM stashes", []).unwrap();
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
    assert_eq!(serde_json::to_vec(&b).unwrap().len(), MAX_ENVELOPE);
    c.execute("INSERT INTO drafts VALUES ('compose',?1,0,0)", [padding])
        .unwrap();
    drop(c);
    let before = std::fs::read(&path).unwrap();
    let failure = Store::open(&path)
        .err()
        .expect("over-capacity migration rejected");
    assert!(failure.message.contains("10 MiB") && failure.message.contains("retained"));
    assert_eq!(before, std::fs::read(&path).unwrap());
    let c = Connection::open(&path).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert!(c.prepare("SELECT done FROM notes").is_err());
    let failure = backup::validate(&serde_json::to_vec(&b).unwrap()).unwrap_err();
    assert!(failure.message.contains("10 MiB") && failure.message.contains("retained"));
}
#[test]
fn desired_completion_is_idempotent_monotonic_persistent_and_not_revival() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.sqlite3");
    let mut db = Store::open(&path).unwrap();
    assert!(db.load().unwrap().notes.is_empty());
    let c = Connection::open(&path).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    drop(c);
    let s = db
        .save(None, "exact\r\nsource", "compose", 1, None)
        .unwrap();
    let id = s.notes[0].id.clone();
    assert!(!s.notes[0].done);
    assert_eq!(db.set_done(&id, false).unwrap(), s);
    let mut s = db.set_done(&id, true).unwrap();
    assert!(s.notes[0].done);
    let time = s.notes[0].updated_at;
    assert_eq!(db.set_done(&id, true).unwrap(), s);
    s.notes[0].updated_at += 1_000_000;
    db.replace(&s).unwrap();
    let changed = db.set_done(&id, false).unwrap();
    assert_eq!(changed.notes[0].updated_at, s.notes[0].updated_at + 1);
    assert_eq!(changed.notes[0].markdown, "exact\r\nsource");
    assert!(changed.notes[0].updated_at > time);
    db.set_done(&id, true).unwrap();
    let s = db.save(Some(&id), "edited\r\n", &id, 2, None).unwrap();
    assert!(s.notes[0].done);
    let deleted = db.delete(&id).unwrap();
    assert!(db.set_done(&id, false).is_err());
    assert_eq!(db.load().unwrap(), deleted);
    assert!(db.set_done("missing", true).is_err());
    db.undo().unwrap();
    drop(db);
    let mut db = Store::open(&path).unwrap();
    let saved = db.load().unwrap();
    assert!(saved.notes[0].done);
    assert_eq!(
        backup::validate(&backup::encode(&saved).unwrap())
            .unwrap()
            .workspace,
        saved
    );
    let c = Connection::open(&path).unwrap();
    c.execute_batch("PRAGMA ignore_check_constraints=ON;UPDATE notes SET done=2;")
        .unwrap();
    assert!(db.load().is_err());
    drop(db);
    assert!(Store::open(&path).is_err());
}
#[test]
fn owned_legacy_and_completed_current_fixtures_are_shared_with_typescript() {
    let old: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../tests/fixtures/valid-v2.json")).unwrap();
    let current: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../tests/fixtures/valid-v3.json")).unwrap();
    let mut expected = old.clone();
    expected["version"] = 3.into();
    for n in expected["workspace"]["notes"].as_array_mut().unwrap() {
        n["done"] = false.into();
    }
    assert_eq!(
        serde_json::to_value(backup::validate(&serde_json::to_vec(&old).unwrap()).unwrap())
            .unwrap(),
        expected
    );
    assert_eq!(
        serde_json::to_value(backup::validate(&serde_json::to_vec(&current).unwrap()).unwrap())
            .unwrap(),
        current
    );
    for value in [&old, &current] {
        for key in [
            "stashId",
            "deletedAt",
            "id",
            "markdown",
            "createdAt",
            "updatedAt",
        ] {
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
        assert_eq!(before, std::fs::read(&path).unwrap());
        let c = Connection::open(&path).unwrap();
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            version
        );
        assert!(c.prepare("SELECT done FROM notes").is_err());
        if version == 1 {
            assert!(c.prepare("SELECT stash_id FROM notes").is_err());
            assert!(c.prepare("SELECT * FROM stashes").is_err());
        }
    }
}
#[test]
fn current_completed_utf8_source_capacity_is_exact() {
    let b = backup::validate(include_bytes!("../../tests/fixtures/valid-v3.json")).unwrap();
    let mut s = b.workspace;
    s.notes[0].markdown = "α".repeat(MAX_SOURCE / 2);
    assert!(backup::encode(&s).is_ok());
    s.notes[0].markdown.push('a');
    assert!(backup::encode(&s).is_err());
}
