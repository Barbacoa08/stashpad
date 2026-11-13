use rusqlite::Connection;
use stashpad_alpha_kit::{backup, model::*, store::Store};
fn id(n: u128) -> String {
    uuid::Uuid::from_u128(n).to_string()
}
fn at(n: u128, scope: Scope) -> Location {
    Location {
        scope,
        item_id: Some(id(n)),
    }
}
fn root(scope: Scope) -> Location {
    Location {
        scope,
        item_id: None,
    }
}
fn item(n: u128, parent: Option<u128>, kind: Kind, position: i64) -> Item {
    Item {
        id: id(n),
        parent_id: parent.map(id),
        kind,
        markdown: "**exact**\r\n".into(),
        done: true,
        color: Some(ColorToken::Purple),
        position,
        created_at: 1,
        updated_at: 2,
        deleted_at: None,
        restore_parent_id: None,
        restore_index: None,
    }
}
#[test]
fn v5_preserves_note_owned_composer_and_restore_capability_but_v4_stays_frozen() {
    let mut deleted = item(2, None, Kind::Note, 0);
    deleted.deleted_at = Some(3);
    deleted.restore_parent_id = Some(id(1));
    deleted.restore_index = Some(0);
    let s = WorkspaceSnapshot {
        items: vec![item(1, None, Kind::Note, 0), deleted],
        drafts: vec![Draft {
            key: format!("compose:{}", id(1)),
            markdown: "capture\r\n".into(),
            revision: 9,
            updated_at: 4,
        }],
        undo_delete_ids: vec![id(2)],
    };
    let bytes = backup::encode(&s).expect("current format accepts preserved note-owner capability");
    let mut v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["version"], 6);
    assert_eq!(backup::validate(&bytes).unwrap().workspace, s);
    v["version"] = 4.into();
    assert!(backup::validate(&serde_json::to_vec(&v).unwrap()).is_err());
}
#[test]
fn schema_four_upgrade_validates_frozen_rules_and_preserves_unknown_settings() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("test.sqlite3");
    let mut db = Store::open(&p).unwrap();
    let s = WorkspaceSnapshot {
        items: vec![item(1, None, Kind::Note, 0)],
        ..Default::default()
    };
    db.replace(&s).unwrap();
    drop(db);
    let c = Connection::open(&p).unwrap();
    c.execute_batch("INSERT INTO settings VALUES ('unknown','exact');DELETE FROM settings WHERE key='undoDeleteId';PRAGMA user_version=4;")
        .unwrap();
    drop(c);
    let mut db = Store::open(&p).unwrap();
    assert_eq!(db.load().unwrap(), s);
    drop(db);
    let c = Connection::open(&p).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        6
    );
    assert_eq!(
        c.query_row("SELECT value FROM settings WHERE key='unknown'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "exact"
    );
    c.execute(
        "INSERT INTO drafts VALUES (?1,'retained',1,1)",
        [format!("compose:{}", id(1))],
    )
    .unwrap();
    c.execute_batch("PRAGMA user_version=4").unwrap();
    drop(c);
    let before = std::fs::read(&p).unwrap();
    assert!(Store::open(&p).is_err());
    assert_eq!(std::fs::read(&p).unwrap(), before);
}
#[test]
fn purge_removes_only_parent_edges_and_owned_drafts_and_replays_after_reopen() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("test.sqlite3");
    let mut db = Store::open(&p).unwrap();
    let mut a = item(1, None, Kind::Stash, 0);
    a.deleted_at = Some(3);
    let b = item(2, Some(1), Kind::Stash, 0);
    let c = item(3, Some(2), Kind::Note, 0);
    let mut independent = item(4, None, Kind::Note, 1);
    independent.deleted_at = Some(4);
    independent.restore_parent_id = Some(id(2));
    independent.restore_index = Some(7);
    let s = WorkspaceSnapshot {
        items: vec![a, b, c, independent],
        drafts: vec![
            Draft {
                key: id(2),
                markdown: "source".into(),
                revision: 4,
                updated_at: 3,
            },
            Draft {
                key: format!("compose:{}", id(2)),
                markdown: "draft".into(),
                revision: 5,
                updated_at: 4,
            },
            Draft {
                key: "compose:trash".into(),
                markdown: "keep".into(),
                revision: 7,
                updated_at: 8,
            },
        ],
        undo_delete_ids: vec![id(4)],
    };
    db.replace(&s).unwrap();
    let req = PurgeItem {
        id: id(2),
        location: at(1, Scope::Trash),
        expected_subtree_ids: vec![id(2), id(3)],
    };
    let result = db.purge(&req).unwrap();
    assert_eq!(result.removed_ids, vec![id(2), id(3)]);
    assert_eq!(result.workspace.items.len(), 2);
    assert_eq!(result.workspace.undo_delete_ids, vec![id(4)]);
    assert_eq!(result.workspace.drafts, vec![s.drafts[2].clone()]);
    let survivor = result
        .workspace
        .items
        .iter()
        .find(|x| x.id == id(4))
        .unwrap();
    assert_eq!(survivor.restore_parent_id, None);
    assert_eq!(survivor.restore_index, Some(7));
    assert_eq!(survivor.updated_at, 2);
    drop(db);
    let mut db = Store::open(&p).unwrap();
    assert_eq!(db.purge(&req).unwrap().workspace, result.workspace);
    let restored = db.restore(&id(4)).unwrap();
    assert_eq!(
        restored
            .items
            .iter()
            .find(|x| x.id == id(4))
            .unwrap()
            .parent_id,
        None
    );
    assert!(db
        .purge(&PurgeItem {
            id: id(4),
            location: root(Scope::Live),
            expected_subtree_ids: vec![id(4)]
        })
        .is_err());
}
#[test]
fn transition_demotes_only_empty_origin_preserving_every_independent_capability() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("test.sqlite3")).unwrap();
    let mut a = item(1, None, Kind::Stash, 0);
    a.done = false;
    let mut b = item(2, None, Kind::Note, 0);
    b.deleted_at = Some(3);
    b.restore_parent_id = Some(id(1));
    b.restore_index = Some(0);
    let s = WorkspaceSnapshot {
        items: vec![a, b],
        drafts: vec![Draft {
            key: format!("compose:{}", id(1)),
            markdown: "capture".into(),
            revision: 9,
            updated_at: 4,
        }],
        undo_delete_ids: vec![id(2)],
    };
    db.replace(&s).unwrap();
    let stay = db
        .transition(&TransitionLocation {
            from: at(1, Scope::Live),
            to: at(1, Scope::Live),
            promote_destination: false,
        })
        .unwrap();
    assert_eq!(stay, s);
    let after = db
        .transition(&TransitionLocation {
            from: at(1, Scope::Live),
            to: root(Scope::Live),
            promote_destination: false,
        })
        .unwrap();
    let mut expected = s.clone();
    expected.items[0].kind = Kind::Note;
    assert_eq!(after, expected);
    let restored = db.restore(&id(2)).unwrap();
    assert_eq!(
        restored.items.iter().find(|x| x.id == id(1)).unwrap().kind,
        Kind::Stash
    );
    assert_eq!(
        restored
            .items
            .iter()
            .find(|x| x.id == id(2))
            .unwrap()
            .parent_id,
        Some(id(1))
    );
    assert_eq!(restored.drafts, s.drafts);
}
#[test]
fn group_moves_are_atomic_replayable_and_preserve_only_changed_roots_timestamps() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("test.sqlite3")).unwrap();
    let s = WorkspaceSnapshot {
        items: vec![
            item(1, None, Kind::Stash, 0),
            item(2, None, Kind::Stash, 1),
            item(3, Some(1), Kind::Note, 0),
            item(4, Some(1), Kind::Stash, 1),
            item(5, Some(1), Kind::Note, 2),
            item(6, Some(4), Kind::Note, 0),
        ],
        ..Default::default()
    };
    db.replace(&s).unwrap();
    let req = MoveItems {
        proof: None,
        deleted_at: None,
        ids: vec![id(3), id(5)],
        from: at(1, Scope::Live),
        to: at(2, Scope::Live),
        before_from: vec![id(3), id(4), id(5)],
        before_to: vec![],
        after_from: vec![id(4)],
        after_to: vec![id(3), id(5)],
    };
    let moved = db.move_items(&req).unwrap();
    assert_eq!(db.move_items(&req).unwrap(), moved);
    for x in &moved.items {
        let old = s.items.iter().find(|y| y.id == x.id).unwrap();
        if [id(3), id(5)].contains(&x.id) {
            assert_eq!(x.parent_id, Some(id(2)));
            assert!(x.updated_at > old.updated_at);
        } else {
            assert_eq!(x.updated_at, old.updated_at);
        }
    }
    let mut bad = req.clone();
    bad.after_to.reverse();
    assert!(db.move_items(&bad).is_err());
    assert_eq!(db.load().unwrap(), moved);
}
#[test]
fn trash_move_preserves_deletion_date_and_independently_deleted_nodes_on_restore() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("test.sqlite3")).unwrap();
    let mut a = item(1, None, Kind::Stash, 0);
    a.deleted_at = Some(3);
    let mut b = item(2, None, Kind::Stash, 1);
    b.deleted_at = Some(5);
    let s = WorkspaceSnapshot {
        items: vec![a, b, item(3, Some(1), Kind::Note, 0)],
        ..Default::default()
    };
    db.replace(&s).unwrap();
    let req = MoveItems {
        proof: None,
        deleted_at: None,
        ids: vec![id(3)],
        from: at(1, Scope::Trash),
        to: at(2, Scope::Trash),
        before_from: vec![id(3)],
        before_to: vec![],
        after_from: vec![],
        after_to: vec![id(3)],
    };
    let moved = db.move_items(&req).unwrap();
    let x = moved.items.iter().find(|x| x.id == id(3)).unwrap();
    assert_eq!(x.deleted_at, Some(3));
    assert_eq!(x.restore_parent_id, Some(id(1)));
    let restored = db.restore(&id(2)).unwrap();
    let x = restored.items.iter().find(|x| x.id == id(3)).unwrap();
    assert_eq!(x.parent_id, None);
    assert_eq!(x.deleted_at, Some(3));
}
#[test]
fn child_creation_atomically_demotes_its_captured_empty_origin() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("test.sqlite3")).unwrap();
    let s = WorkspaceSnapshot {
        items: vec![item(1, None, Kind::Stash, 0), item(2, None, Kind::Note, 1)],
        ..Default::default()
    };
    db.replace(&s).unwrap();
    let request: CreateChildStash = serde_json::from_value(
        serde_json::json!({"id":id(3),"parent":at(2,Scope::Live),"leave":at(1,Scope::Live)}),
    )
    .expect("captured exit belongs to creation transaction");
    let after = db.create_child_stash(&request).unwrap();
    assert_eq!(after.items[0].kind, Kind::Note);
    assert_eq!(after.items[1].kind, Kind::Stash);
    assert_eq!(db.create_child_stash(&request).unwrap(), after);
}
#[test]
fn purge_sql_failure_rolls_back_rows_drafts_undo_and_unknown_settings() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("test.sqlite3");
    let mut db = Store::open(&p).unwrap();
    let mut a = item(1, None, Kind::Stash, 0);
    a.deleted_at = Some(3);
    let s = WorkspaceSnapshot {
        items: vec![a, item(2, Some(1), Kind::Note, 0)],
        drafts: vec![Draft {
            key: id(2),
            markdown: "retained".into(),
            revision: 1,
            updated_at: 2,
        }],
        undo_delete_ids: vec![id(1)],
    };
    db.replace(&s).unwrap();
    let c = Connection::open(&p).unwrap();
    c.execute_batch("INSERT INTO settings VALUES ('unknown','keep');CREATE TRIGGER reject_purge BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT,'synthetic');END;").unwrap();
    drop(c);
    let req = PurgeItem {
        id: id(1),
        location: root(Scope::Trash),
        expected_subtree_ids: vec![id(1), id(2)],
    };
    assert!(db.purge(&req).is_err());
    assert_eq!(db.load().unwrap(), s);
    drop(db);
    let c = Connection::open(&p).unwrap();
    assert_eq!(
        c.query_row("SELECT value FROM settings WHERE key='unknown'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "keep"
    );
    c.execute_batch("DROP TRIGGER reject_purge").unwrap();
    drop(c);
    let mut db = Store::open(&p).unwrap();
    assert_eq!(db.load().unwrap(), s);
    let after = db.purge(&req).unwrap();
    assert!(after.workspace.items.is_empty());
    assert!(after.workspace.drafts.is_empty());
    assert_eq!(after.workspace.undo_delete_ids, Vec::<String>::new());
}
#[test]
fn stale_purge_membership_and_move_groups_reject_without_changes() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("test.sqlite3")).unwrap();
    let mut a = item(1, None, Kind::Stash, 0);
    a.deleted_at = Some(3);
    let s = WorkspaceSnapshot {
        items: vec![a, item(2, Some(1), Kind::Note, 0)],
        ..Default::default()
    };
    db.replace(&s).unwrap();
    for ids in [vec![id(1)], vec![id(1), id(2), id(2)], vec![id(2), id(999)]] {
        assert!(db
            .purge(&PurgeItem {
                id: id(1),
                location: root(Scope::Trash),
                expected_subtree_ids: ids
            })
            .is_err());
        assert_eq!(db.load().unwrap(), s);
    }
    let s = WorkspaceSnapshot {
        items: vec![
            item(1, None, Kind::Stash, 0),
            item(2, None, Kind::Note, 1),
            item(3, None, Kind::Note, 2),
            item(4, Some(1), Kind::Stash, 0),
        ],
        ..Default::default()
    };
    db.replace(&s).unwrap();
    let base = MoveItems {
        proof: None,
        deleted_at: None,
        ids: vec![id(2)],
        from: root(Scope::Live),
        to: at(1, Scope::Live),
        before_from: vec![id(1), id(2), id(3)],
        before_to: vec![id(4)],
        after_from: vec![id(1), id(3)],
        after_to: vec![id(4), id(2)],
    };
    for mode in 0..6 {
        let mut r = base.clone();
        match mode {
            0 => r.ids = vec![],
            1 => r.ids = vec![id(2), id(2)],
            2 => r.before_from.reverse(),
            3 => r.to.scope = Scope::Trash,
            4 => r.to = at(4, Scope::Live),
            _ => r.ids = vec![id(1)],
        };
        assert!(db.move_items(&r).is_err());
        assert_eq!(db.load().unwrap(), s);
    }
}
#[test]
fn whole_group_permutation_handles_noncontiguous_selection_and_exact_noop() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("test.sqlite3")).unwrap();
    let s = WorkspaceSnapshot {
        items: (1..=5)
            .map(|n| item(n, None, Kind::Note, n as i64 - 1))
            .collect(),
        ..Default::default()
    };
    db.replace(&s).unwrap();
    let before: (Vec<_>, Vec<_>) = (
        (1..=5).map(id).collect(),
        vec![id(2), id(1), id(4), id(3), id(5)],
    );
    let request = MoveItems {
        proof: None,
        deleted_at: None,
        ids: vec![id(2), id(4)],
        from: root(Scope::Live),
        to: root(Scope::Live),
        before_from: before.0.clone(),
        before_to: before.0,
        after_from: before.1.clone(),
        after_to: before.1,
    };
    let moved = db.move_items(&request).unwrap();
    for x in &moved.items {
        assert_eq!(x.updated_at > 2, [id(2), id(4)].contains(&x.id));
    }
    assert_eq!(db.move_items(&request).unwrap(), moved);
    let same = MoveItems {
        proof: None,
        deleted_at: None,
        before_from: request.after_from.clone(),
        before_to: request.after_to.clone(),
        ..request
    };
    assert_eq!(db.move_items(&same).unwrap(), moved);
}
#[test]
fn twenty_thousand_deep_purge_is_iterative_and_backup_five_roundtrips() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("test.sqlite3")).unwrap();
    let mut s = WorkspaceSnapshot::default();
    for n in 1..=20000 {
        s.items.push(item(
            n,
            if n == 1 { None } else { Some(n - 1) },
            Kind::Stash,
            0,
        ));
    }
    s.items[0].deleted_at = Some(3);
    s.undo_delete_ids = vec![id(1)];
    db.replace(&s).unwrap();
    let r = PurgeItem {
        id: id(1),
        location: root(Scope::Trash),
        expected_subtree_ids: (1..=20000).map(id).collect(),
    };
    let result = db.purge(&r).unwrap();
    assert_eq!(result.removed_ids.len(), 20000);
    assert_eq!(
        backup::validate(&backup::encode(&result.workspace).unwrap())
            .unwrap()
            .workspace,
        WorkspaceSnapshot::default()
    );
}
#[test]
fn explicit_same_id_transition_promotes_without_demotion() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("test.sqlite3")).unwrap();
    let s = WorkspaceSnapshot {
        items: vec![item(1, None, Kind::Note, 0)],
        ..Default::default()
    };
    db.replace(&s).unwrap();
    let after = db
        .transition(&TransitionLocation {
            from: at(1, Scope::Live),
            to: at(1, Scope::Live),
            promote_destination: true,
        })
        .unwrap();
    assert_eq!(after.items[0].kind, Kind::Stash);
}
#[test]
fn each_v4_frozen_owner_and_deleted_root_rule_remains_strict_independently() {
    for mode in 0..3 {
        let mut s = WorkspaceSnapshot {
            items: vec![item(1, None, Kind::Note, 0)],
            ..Default::default()
        };
        match mode {
            0 => s.drafts.push(Draft {
                key: format!("compose:{}", id(1)),
                markdown: "retained".into(),
                revision: 1,
                updated_at: 2,
            }),
            1 => {
                let mut deleted = item(2, None, Kind::Note, 0);
                deleted.deleted_at = Some(3);
                deleted.restore_parent_id = Some(id(1));
                deleted.restore_index = Some(4);
                s.items.push(deleted);
            }
            _ => {
                s.items[0].kind = Kind::Stash;
                s.items[0].deleted_at = Some(3);
                let mut nested = item(2, Some(1), Kind::Note, 0);
                nested.deleted_at = Some(4);
                s.items.push(nested);
            }
        }
        let mut value: serde_json::Value =
            serde_json::from_slice(&backup::encode(&s).unwrap()).unwrap();
        assert!(backup::validate(&serde_json::to_vec(&value).unwrap()).is_ok());
        value["version"] = 4.into();
        assert!(backup::validate(&serde_json::to_vec(&value).unwrap()).is_err());
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("test.sqlite3");
        let mut db = Store::open(&p).unwrap();
        db.replace(&s).unwrap();
        drop(db);
        let c = Connection::open(&p).unwrap();
        c.execute_batch(
            "INSERT INTO settings VALUES ('unknown','retained');PRAGMA user_version=4;",
        )
        .unwrap();
        drop(c);
        let before = std::fs::read(&p).unwrap();
        assert!(Store::open(&p).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), before);
        if mode == 2 {
            s.items[0].deleted_at = None;
            assert!(backup::encode(&s).is_err());
        }
    }
}
#[test]
fn move_capacity_failure_retains_both_groups_sources_drafts_and_settings() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("test.sqlite3");
    let mut db = Store::open(&p).unwrap();
    let mut s = WorkspaceSnapshot {
        items: vec![item(1, None, Kind::Stash, 0)],
        drafts: vec![Draft {
            key: "compose".into(),
            markdown: String::new(),
            revision: 9,
            updated_at: 4,
        }],
        undo_delete_ids: vec![],
    };
    for n in 2..=10 {
        let mut x = item(n, None, Kind::Note, n as i64 - 1);
        x.markdown = "x".repeat(MAX_SOURCE);
        s.items.push(x);
    }
    let length = backup::encode(&s).unwrap().len();
    s.drafts[0].markdown = "x".repeat(MAX_ENVELOPE - length);
    assert_eq!(backup::encode(&s).unwrap().len(), MAX_ENVELOPE);
    db.replace(&s).unwrap();
    let c = Connection::open(&p).unwrap();
    c.execute_batch("INSERT INTO settings VALUES ('unknown','retained');")
        .unwrap();
    drop(c);
    let request = MoveItems {
        proof: None,
        deleted_at: None,
        ids: vec![id(2)],
        from: root(Scope::Live),
        to: at(1, Scope::Live),
        before_from: (1..=10).map(id).collect(),
        before_to: vec![],
        after_from: (1..=10).filter(|n| *n != 2).map(id).collect(),
        after_to: vec![id(2)],
    };
    assert!(db.move_items(&request).is_err());
    assert_eq!(db.load().unwrap(), s);
    drop(db);
    let mut db = Store::open(&p).unwrap();
    assert_eq!(db.load().unwrap(), s);
    let c = Connection::open(&p).unwrap();
    assert_eq!(
        c.query_row("SELECT value FROM settings WHERE key='unknown'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "retained"
    );
}
#[test]
fn move_sql_failure_rolls_back_both_groups_after_prospective_validation() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("test.sqlite3");
    let mut db = Store::open(&p).unwrap();
    let s = WorkspaceSnapshot {
        items: vec![item(1, None, Kind::Stash, 0), item(2, None, Kind::Note, 1)],
        ..Default::default()
    };
    db.replace(&s).unwrap();
    let c = Connection::open(&p).unwrap();
    c.execute_batch("INSERT INTO settings VALUES ('unknown','retained');CREATE TRIGGER reject_move BEFORE INSERT ON items WHEN new.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic');END;").unwrap();
    drop(c);
    let request = MoveItems {
        proof: None,
        deleted_at: None,
        ids: vec![id(2)],
        from: root(Scope::Live),
        to: at(1, Scope::Live),
        before_from: vec![id(1), id(2)],
        before_to: vec![],
        after_from: vec![id(1)],
        after_to: vec![id(2)],
    };
    assert!(db.move_items(&request).is_err());
    assert_eq!(db.load().unwrap(), s);
    drop(db);
    assert_eq!(Store::open(&p).unwrap().load().unwrap(), s);
}
#[test]
fn soft_delete_and_empty_origin_demotion_share_one_commit() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("test.sqlite3")).unwrap();
    let s = WorkspaceSnapshot {
        items: vec![item(1, None, Kind::Stash, 0)],
        drafts: vec![Draft {
            key: format!("compose:{}", id(1)),
            markdown: "separate".into(),
            revision: 4,
            updated_at: 3,
        }],
        undo_delete_ids: vec![],
    };
    db.replace(&s).unwrap();
    let after = db
        .delete_leaving(&id(1), Some(&at(1, Scope::Live)))
        .unwrap();
    assert_eq!(after.items[0].kind, Kind::Note);
    assert_eq!(after.drafts, s.drafts);
    assert_eq!(after.undo_delete_ids, vec![id(1)]);
    assert_eq!(
        db.delete_leaving(&id(1), Some(&at(1, Scope::Live)))
            .unwrap(),
        after
    );
    assert_eq!(
        {
            let r = stashpad_alpha_kit::store::capture_undo(&db.load().unwrap()).unwrap();
            db.undo(&r)
        }
        .unwrap()
        .items[0]
            .kind,
        Kind::Note
    );
}

#[test]
fn broad_restore_batches_independent_roots_and_preserves_nested_facts_after_reopen() {
    for width in [250_u128, 1000, 2000] {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("test.sqlite3");
        let mut db = Store::open(&p).unwrap();
        let mut ancestor = item(1, None, Kind::Stash, 0);
        ancestor.deleted_at = Some(3);
        let mut existing = item(2, None, Kind::Note, 1);
        existing.deleted_at = Some(4);
        let mut s = WorkspaceSnapshot {
            items: vec![ancestor, existing],
            drafts: vec![Draft {
                key: format!("compose:{}", id(4)),
                markdown: "retained\r\n".into(),
                revision: 7,
                updated_at: 8,
            }],
            undo_delete_ids: vec![id(5)],
        };
        for i in 0..width {
            let n = 3 + i * 4;
            s.items.push(item(n, Some(1), Kind::Stash, i as i64));
            let mut explicit = item(n + 1, Some(n), Kind::Stash, 0);
            explicit.deleted_at = Some(5);
            explicit.restore_parent_id = Some(id(n));
            explicit.restore_index = Some(0);
            s.items.push(explicit);
            let mut deeper = item(n + 2, Some(n + 1), Kind::Note, 0);
            deeper.deleted_at = Some(6);
            deeper.restore_parent_id = Some(id(n + 1));
            deeper.restore_index = Some(0);
            s.items.push(deeper);
            s.items.push(item(n + 3, Some(n), Kind::Note, 1));
        }
        db.replace(&s).unwrap();
        let started = std::time::Instant::now();
        let after = db.restore(&id(1)).unwrap();
        println!(
            "Restore {} items via SQLite: {:?}",
            s.items.len(),
            started.elapsed()
        );
        let mut roots: Vec<&Item> = after
            .items
            .iter()
            .filter(|x| x.parent_id.is_none() && x.deleted_at.is_some())
            .collect();
        roots.sort_by_key(|x| x.position);
        let expected: Vec<String> = std::iter::once(id(2))
            .chain((0..width).rev().map(|i| id(4 + i * 4)))
            .collect();
        assert_eq!(
            roots.iter().map(|x| x.id.clone()).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            roots.iter().map(|x| x.position).collect::<Vec<_>>(),
            (0..=width as i64).collect::<Vec<_>>()
        );
        let index: std::collections::HashMap<&str, &Item> =
            after.items.iter().map(|x| (x.id.as_str(), x)).collect();
        for original in s.items.iter().skip(2) {
            let mut expected = original.clone();
            if expected.deleted_at == Some(5) {
                expected.parent_id = None;
                expected.position = roots.iter().position(|x| x.id == expected.id).unwrap() as i64;
            } else if expected.deleted_at.is_none()
                && expected.parent_id != Some(id(1))
                && expected.position == 1
            {
                expected.position = 0;
            }
            assert_eq!(index[original.id.as_str()], &expected);
        }
        assert_eq!(after.drafts, s.drafts);
        assert_eq!(after.undo_delete_ids, s.undo_delete_ids);
        drop(db);
        assert_eq!(Store::open(&p).unwrap().load().unwrap(), after);
    }
}
