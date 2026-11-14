use rusqlite::Connection;
use scratchtree_lib::{model::*, store::Store};
#[test]
fn empty_profile_is_schema_seven() {
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
        7
    );
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
    db.create_child_tree(&CreateChildTree {
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
    let r = CreateChildTree {
        id: id(2),
        parent: at(1, Scope::Live),
        leave: None,
    };
    let made = db.create_child_tree(&r).unwrap();
    assert_eq!(db.create_child_tree(&r).unwrap(), made);
    assert_eq!(
        made.items.iter().find(|x| x.id == id(1)).unwrap().kind,
        Kind::Tree
    );
    assert!(db
        .create_child_tree(&CreateChildTree {
            id: id(2),
            parent: home(),
            leave: None,
        })
        .is_err());
    assert_eq!(db.load().unwrap(), made);
    capture(&mut db, 3, home(), "still note");
    let before = db.load().unwrap();
    assert!(db
        .create_child_tree(&CreateChildTree {
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
        scratchtree_lib::store::effective_scope(&deleted, &id(4)).unwrap(),
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
        scratchtree_lib::store::effective_scope(&restored, &id(2)).unwrap(),
        Scope::Live
    );
    let undo = {
        let r = scratchtree_lib::store::capture_undo(&db.load().unwrap()).unwrap();
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
        scratchtree_lib::store::effective_scope(&s, &id(3)).unwrap(),
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
        serde_json::from_slice(&scratchtree_lib::backup::encode(&s).unwrap()).unwrap();
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
        bad["library"]["items"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(scratchtree_lib::backup::validate(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
    for (key, value) in [
        ("color", serde_json::json!(1)),
        ("kind", serde_json::json!("folder")),
        ("position", serde_json::json!(1.5)),
        ("restoreIndex", serde_json::json!(0)),
    ] {
        let mut bad = serde_json::to_value(
            scratchtree_lib::backup::validate(&scratchtree_lib::backup::encode(&s).unwrap())
                .unwrap(),
        )
        .unwrap();
        bad["library"]["items"][0][key] = value;
        assert!(scratchtree_lib::backup::validate(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
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
        .create_child_tree(&CreateChildTree {
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
    let bytes = include_bytes!("../../tests/fixtures/valid-v7.json");
    let b = scratchtree_lib::backup::validate(bytes).unwrap();
    let expected = serde_json::from_slice::<serde_json::Value>(bytes).unwrap();
    assert_eq!(serde_json::to_value(b).unwrap(), expected);
}
