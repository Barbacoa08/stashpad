use rusqlite::{params, Connection};
use stashpad_alpha_kit::{model::*, store::Store};
const A: &str = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
#[test]
fn empty_profile_is_schema_six() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("test.sqlite3");
    let mut db = Store::open(&p).unwrap();
    assert_eq!(
        serde_json::to_value(db.load().unwrap()).unwrap()["items"],
        serde_json::json!([])
    );
    let c = Connection::open(&p).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        6
    );
}
#[test]
fn actual_all_legacy_schemas_preserve_bytes_settings_drafts_and_undo() {
    for v in 0..=3 {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("test.sqlite3");
        let c = Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE notes(id TEXT PRIMARY KEY,markdown TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER);CREATE TABLE drafts(key TEXT PRIMARY KEY,markdown TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);").unwrap();
        c.execute(
            "INSERT INTO notes VALUES (?1,'exact\r\n**source**',1,2,3)",
            [A],
        )
        .unwrap();
        c.execute(
            "INSERT INTO drafts VALUES ('compose','capture\r\n',4,5)",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO settings VALUES ('unknown','keep')", [])
            .unwrap();
        c.execute("INSERT INTO settings VALUES ('undoDeleteId',?1)", [A])
            .unwrap();
        if v >= 2 {
            c.execute_batch("CREATE TABLE stashes(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);ALTER TABLE notes ADD COLUMN stash_id TEXT;").unwrap();
        }
        if v >= 3 {
            c.execute_batch("ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1));UPDATE notes SET done=1;").unwrap();
        }
        c.execute_batch(&format!("PRAGMA user_version={v};"))
            .unwrap();
        drop(c);
        let mut db = Store::open(&p).unwrap();
        let value = serde_json::to_value(db.load().unwrap()).unwrap();
        assert_eq!(value["items"][0]["id"], A);
        assert_eq!(value["items"][0]["markdown"], "exact\r\n**source**");
        assert_eq!(value["items"][0]["done"], v == 3);
        assert_eq!(value["items"][0]["restoreIndex"], 0);
        assert_eq!(value["drafts"][0]["markdown"], "capture\r\n");
        {
            let r = stashpad_alpha_kit::store::capture_undo(&db.load().unwrap()).unwrap();
            db.undo(&r)
        }
        .unwrap();
        db.replace(&WorkspaceSnapshot::default()).unwrap();
        drop(db);
        let c = Connection::open(&p).unwrap();
        assert_eq!(
            c.query_row("SELECT value FROM settings WHERE key='unknown'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "keep"
        );
    }
}
#[test]
fn invalid_and_future_migrations_leave_file_identical() {
    for v in [0, 1, 2, 3, 6] {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bad.sqlite3");
        let c = Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE notes(id TEXT PRIMARY KEY,markdown TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER);CREATE TABLE drafts(key TEXT PRIMARY KEY,markdown TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);").unwrap();
        c.execute("INSERT INTO notes VALUES (?1,'keep',-1,2,NULL)", params![A])
            .unwrap();
        if v >= 2 {
            c.execute_batch("CREATE TABLE stashes(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);ALTER TABLE notes ADD COLUMN stash_id TEXT;").unwrap();
        }
        if v >= 3 {
            c.execute_batch("ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0;")
                .unwrap();
        }
        c.execute_batch(&format!("PRAGMA user_version={v}"))
            .unwrap();
        drop(c);
        let before = std::fs::read(&p).unwrap();
        assert!(Store::open(&p).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), before);
    }
}
fn home() -> Location {
    Location {
        scope: Scope::Live,
        item_id: None,
    }
}
fn id(n: u128) -> String {
    uuid::Uuid::from_u128(n).to_string()
}
fn capture(db: &mut Store, n: u128, parent: Location, source: &str) -> WorkspaceSnapshot {
    db.capture(&CaptureItem {
        id: id(n),
        draft: DraftAck {
            key: parent.compose_key(),
            revision: 1,
        },
        location: parent,
        markdown: source.into(),
    })
    .unwrap()
}
fn child(db: &mut Store, n: u128, parent: Location) -> WorkspaceSnapshot {
    db.create_child_stash(&CreateChildStash {
        id: id(n),
        parent,
        leave: None,
    })
    .unwrap()
}
fn at(n: u128, scope: Scope) -> Location {
    Location {
        scope,
        item_id: Some(id(n)),
    }
}
#[test]
fn fixed_identity_replay_conflicts_and_atomic_failed_parent_promotion() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Store::open(&dir.path().join("test.sqlite3")).unwrap();
    capture(&mut db, 1, home(), "**exact**\r\n");
    let r = CreateChildStash {
        id: id(2),
        parent: at(1, Scope::Live),
        leave: None,
    };
    let made = db.create_child_stash(&r).unwrap();
    assert_eq!(db.create_child_stash(&r).unwrap(), made);
    assert_eq!(
        made.items.iter().find(|x| x.id == id(1)).unwrap().kind,
        Kind::Stash
    );
    assert!(db
        .create_child_stash(&CreateChildStash {
            id: id(2),
            parent: home(),
            leave: None,
        })
        .is_err());
    assert_eq!(db.load().unwrap(), made);
    capture(&mut db, 3, home(), "still note");
    let before = db.load().unwrap();
    assert!(db
        .create_child_stash(&CreateChildStash {
            id: "invalid".into(),
            parent: at(3, Scope::Live),
            leave: None,
        })
        .is_err());
    assert_eq!(db.load().unwrap(), before);
}
#[test]
fn inherited_trash_detachment_independent_descendants_fallback_and_undo_interleave() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.sqlite3");
    let mut db = Store::open(&path).unwrap();
    child(&mut db, 1, home());
    child(&mut db, 2, at(1, Scope::Live));
    capture(&mut db, 3, at(2, Scope::Live), "independent");
    capture(&mut db, 4, at(2, Scope::Live), "inherits");
    db.checkpoint(&id(4), "retained edit", 9).unwrap();
    db.checkpoint(&format!("compose:{}", id(2)), "retained capture", 8)
        .unwrap();
    db.delete(&id(3)).unwrap();
    let deleted = db.delete(&id(1)).unwrap();
    assert_eq!(db.delete(&id(1)).unwrap(), deleted);
    assert_eq!(
        stashpad_alpha_kit::store::effective_scope(&deleted, &id(4)).unwrap(),
        Scope::Trash
    );
    assert_eq!(deleted.undo_delete_ids, vec![id(1)]);
    let restored = db.restore(&id(3)).unwrap();
    assert_eq!(
        restored
            .items
            .iter()
            .find(|x| x.id == id(3))
            .unwrap()
            .parent_id,
        None
    );
    assert_eq!(restored.undo_delete_ids, vec![id(1)]);
    let detached = db.delete(&id(4)).unwrap();
    assert!(detached
        .items
        .iter()
        .find(|x| x.id == id(4))
        .unwrap()
        .deleted_at
        .is_some());
    let restored = db.restore(&id(1)).unwrap();
    assert_eq!(restored.undo_delete_ids, vec![id(4)]);
    assert_eq!(
        stashpad_alpha_kit::store::effective_scope(&restored, &id(2)).unwrap(),
        Scope::Live
    );
    let undo = {
        let r = stashpad_alpha_kit::store::capture_undo(&db.load().unwrap()).unwrap();
        db.undo(&r)
    }
    .unwrap();
    assert_eq!(
        undo.items.iter().find(|x| x.id == id(4)).unwrap().parent_id,
        Some(id(2))
    );
    assert_eq!(undo.drafts.len(), 2);
    assert_eq!(undo.undo_delete_ids, Vec::<String>::new());
    assert_eq!(db.restore(&id(1)).unwrap(), undo);
    drop(db);
    let mut db = Store::open(&path).unwrap();
    assert_eq!(db.load().unwrap(), undo);
}
#[test]
fn inherited_child_restore_to_home_carries_its_children() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Store::open(&dir.path().join("test.sqlite3")).unwrap();
    child(&mut db, 1, home());
    child(&mut db, 2, at(1, Scope::Live));
    capture(&mut db, 3, at(2, Scope::Live), "child");
    db.delete(&id(1)).unwrap();
    let s = db.restore(&id(2)).unwrap();
    assert_eq!(
        s.items.iter().find(|x| x.id == id(2)).unwrap().parent_id,
        None
    );
    assert_eq!(
        s.items.iter().find(|x| x.id == id(3)).unwrap().parent_id,
        Some(id(2))
    );
    assert_eq!(s.undo_delete_ids, vec![id(1)]);
    assert_eq!(
        stashpad_alpha_kit::store::effective_scope(&s, &id(3)).unwrap(),
        Scope::Live
    );
}
#[test]
fn strict_ack_replay_and_trash_creation_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Store::open(&dir.path().join("test.sqlite3")).unwrap();
    db.checkpoint("compose", "newer", 3).unwrap();
    let req = CaptureItem {
        id: id(1),
        location: home(),
        markdown: "saved".into(),
        draft: DraftAck {
            key: "compose".into(),
            revision: 2,
        },
    };
    let s = db.capture(&req).unwrap();
    assert_eq!(s.drafts[0].markdown, "newer");
    assert_eq!(db.capture(&req).unwrap(), s);
    assert!(db
        .capture(&CaptureItem {
            draft: DraftAck {
                key: "compose".into(),
                revision: -1
            },
            ..req.clone()
        })
        .is_err());
    assert!(db.checkpoint("compose", "invalid", -1).is_err());
    assert_eq!(db.load().unwrap(), s);
    let trash = Location {
        scope: Scope::Trash,
        item_id: None,
    };
    child(&mut db, 2, trash);
    let s = capture(&mut db, 3, at(2, Scope::Trash), "inherited");
    let root = s.items.iter().find(|x| x.id == id(2)).unwrap();
    assert!(root.deleted_at.is_some());
    assert_eq!(root.restore_index, None);
    assert!(s
        .items
        .iter()
        .find(|x| x.id == id(3))
        .unwrap()
        .deleted_at
        .is_none());
    assert!(db
        .capture(&CaptureItem {
            id: id(4),
            location: at(2, Scope::Live),
            markdown: "wrong scope".into(),
            draft: DraftAck {
                key: format!("compose:{}", id(2)),
                revision: 0
            }
        })
        .is_err());
}
#[test]
fn reorder_sparse_ranks_bounds_and_neighbor_timestamps() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Store::open(&dir.path().join("test.sqlite3")).unwrap();
    capture(&mut db, 1, home(), "first");
    let mut s = capture(&mut db, 2, home(), "second");
    s.items[0].position = 2;
    s.items[1].position = 9;
    db.replace(&s).unwrap();
    let s = child(&mut db, 3, home());
    assert_eq!(
        s.items.iter().map(|x| x.position).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    let moved = db
        .reorder(&ReorderItem {
            id: id(2),
            group: home(),
            to_index: 0,
        })
        .unwrap();
    assert_eq!(moved.items[0].updated_at, s.items[0].updated_at);
    assert!(moved.items[1].updated_at > s.items[1].updated_at);
    assert_eq!(
        db.reorder(&ReorderItem {
            id: id(2),
            group: home(),
            to_index: 0
        })
        .unwrap(),
        moved
    );
    for index in [-1, 3, MAX_SAFE] {
        assert!(db
            .reorder(&ReorderItem {
                id: id(2),
                group: home(),
                to_index: index
            })
            .is_err());
    }
    assert_eq!(db.load().unwrap(), moved);
}
#[test]
fn metadata_color_promotion_and_strict_current_wire() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Store::open(&dir.path().join("test.sqlite3")).unwrap();
    capture(&mut db, 1, home(), "source");
    db.set_done(&id(1), true).unwrap();
    let s = db.set_color(&id(1), Some(ColorToken::Purple)).unwrap();
    assert_eq!(db.set_color(&id(1), Some(ColorToken::Purple)).unwrap(), s);
    let s = db.promote(&id(1)).unwrap();
    assert!(s.items[0].done);
    assert_eq!(s.items[0].color, Some(ColorToken::Purple));
    let value: serde_json::Value =
        serde_json::from_slice(&stashpad_alpha_kit::backup::encode(&s).unwrap()).unwrap();
    for field in [
        "parentId",
        "color",
        "deletedAt",
        "restoreParentId",
        "restoreIndex",
        "done",
        "position",
    ] {
        let mut bad = value.clone();
        bad["workspace"]["items"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(stashpad_alpha_kit::backup::validate(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
    for (key, value) in [
        ("color", serde_json::json!(1)),
        ("kind", serde_json::json!("folder")),
        ("position", serde_json::json!(1.5)),
        ("restoreIndex", serde_json::json!(0)),
    ] {
        let mut bad = serde_json::to_value(
            stashpad_alpha_kit::backup::validate(&stashpad_alpha_kit::backup::encode(&s).unwrap())
                .unwrap(),
        )
        .unwrap();
        bad["workspace"]["items"][0][key] = value;
        assert!(stashpad_alpha_kit::backup::validate(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
}
#[test]
fn schema_three_near_capacity_failure_rolls_back_tables_settings_and_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("capacity.sqlite3");
    let c = Connection::open(&path).unwrap();
    c.execute_batch("CREATE TABLE notes(id TEXT PRIMARY KEY,markdown TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER,stash_id TEXT,done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)));CREATE TABLE stashes(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE drafts(key TEXT PRIMARY KEY,markdown TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);INSERT INTO settings VALUES ('unknown','retained');PRAGMA user_version=3;").unwrap();
    let mut b = serde_json::json!({"format":"stashpad-alpha","version":3,"exportedAt":"2026-11-11T00:00:00.000Z","workspace":{"stashes":[],"notes":[],"drafts":[{"key":"compose","markdown":"","revision":0,"updatedAt":0}],"undoDeleteId":null}});
    for i in 0..9 {
        let key = id(i + 1);
        let source = "x".repeat(MAX_SOURCE);
        c.execute(
            "INSERT INTO notes VALUES (?1,?2,0,0,NULL,NULL,0)",
            params![key, source],
        )
        .unwrap();
        b["workspace"]["notes"].as_array_mut().unwrap().push(serde_json::json!({"id":key,"stashId":null,"done":false,"markdown":source,"createdAt":0,"updatedAt":0,"deletedAt":null}));
    }
    let padding = "x".repeat(MAX_ENVELOPE - serde_json::to_vec(&b).unwrap().len());
    b["workspace"]["drafts"][0]["markdown"] = padding.clone().into();
    assert_eq!(serde_json::to_vec(&b).unwrap().len(), MAX_ENVELOPE);
    c.execute("INSERT INTO drafts VALUES ('compose',?1,0,0)", [padding])
        .unwrap();
    drop(c);
    let before = std::fs::read(&path).unwrap();
    assert!(Store::open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let c = Connection::open(&path).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert!(c.prepare("SELECT * FROM items").is_err());
    assert!(c.prepare("SELECT * FROM notes").is_ok());
    assert!(stashpad_alpha_kit::backup::validate(&serde_json::to_vec(&b).unwrap()).is_err());
}
#[test]
fn failed_capacity_creation_leaves_note_kind_and_every_prior_field_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Store::open(&dir.path().join("full.sqlite3")).unwrap();
    let mut s = WorkspaceSnapshot::default();
    for i in 0..20000 {
        s.items.push(Item {
            id: id(i + 1),
            parent_id: None,
            kind: Kind::Note,
            markdown: String::new(),
            done: false,
            color: None,
            position: i as i64,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
            restore_parent_id: None,
            restore_index: None,
        });
    }
    s.drafts.push(Draft {
        key: id(1),
        markdown: "recovery".into(),
        revision: 1,
        updated_at: 0,
    });
    let before = db.replace(&s).unwrap();
    assert!(db
        .create_child_stash(&CreateChildStash {
            id: id(20001),
            parent: at(1, Scope::Live),
            leave: None,
        })
        .is_err());
    assert_eq!(db.load().unwrap(), before);
}
#[test]
fn capture_whitespace_matches_javascript_without_rewriting_source() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Store::open(&dir.path().join("test.sqlite3")).unwrap();
    for source in ["", " \r\n\t", "\u{feff}"] {
        assert!(
            db.capture(&CaptureItem {
                id: id(1),
                location: home(),
                markdown: source.into(),
                draft: DraftAck {
                    key: "compose".into(),
                    revision: 0
                }
            })
            .is_err(),
            "accepted blank {source:?}"
        );
    }
    let s = capture(&mut db, 1, home(), "\u{85}");
    assert_eq!(s.items[0].markdown, "\u{85}");
}
#[test]
fn shared_current_fixture_roundtrips_exactly_including_trash_drafts() {
    let bytes = include_bytes!("../../tests/fixtures/valid-v4.json");
    let b = stashpad_alpha_kit::backup::validate(bytes).unwrap();
    let mut expected = serde_json::from_slice::<serde_json::Value>(bytes).unwrap();
    expected["version"] = 6.into();
    let singleton = expected["workspace"]
        .as_object_mut()
        .unwrap()
        .remove("undoDeleteId")
        .unwrap();
    expected["workspace"]["undoDeleteIds"] = if singleton.is_null() {
        serde_json::json!([])
    } else {
        serde_json::json!([singleton])
    };
    assert_eq!(serde_json::to_value(b).unwrap(), expected);
}
#[test]
fn legacy_mixed_order_and_deleted_restore_index_use_exact_created_time_id_comparator() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ordered.sqlite3");
    let c = Connection::open(&path).unwrap();
    c.execute_batch("CREATE TABLE notes(id TEXT PRIMARY KEY,markdown TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER,stash_id TEXT,done INTEGER NOT NULL DEFAULT 0);CREATE TABLE stashes(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE drafts(key TEXT PRIMARY KEY,markdown TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);PRAGMA user_version=3;").unwrap();
    c.execute(
        "INSERT INTO stashes VALUES (?1,?2,NULL,5,6)",
        params![id(2), "Name\r\n**source**"],
    )
    .unwrap();
    for (n, created, deleted) in [(1, 5, None), (3, 5, Some(7)), (4, 8, None)] {
        c.execute(
            "INSERT INTO notes VALUES (?1,'source',?2,?2,?3,NULL,1)",
            params![id(n), created, deleted],
        )
        .unwrap();
    }
    drop(c);
    let mut db = Store::open(&path).unwrap();
    let s = db.load().unwrap();
    for (n, position) in [(1, 0), (2, 1), (4, 2)] {
        assert_eq!(
            s.items.iter().find(|x| x.id == id(n)).unwrap().position,
            position
        );
    }
    let deleted = s.items.iter().find(|x| x.id == id(3)).unwrap();
    assert_eq!(deleted.restore_index, Some(2));
    assert_eq!(deleted.restore_parent_id, None);
    assert_eq!(deleted.position, 0);
    assert_eq!(
        s.items.iter().find(|x| x.id == id(2)).unwrap().markdown,
        "Name\r\n**source**"
    );
}
