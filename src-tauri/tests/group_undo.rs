use rusqlite::Connection;
use scratchtree_lib::{backup, store::Store};
#[test]
fn schema_seven_stores_strict_array_and_preserves_unknown_similarly_named_setting() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("workspace.sqlite3");
    drop(Store::open(&p).unwrap());
    let c = Connection::open(&p).unwrap();
    let version: i64 = c
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 7);
    let undo: String = c
        .query_row(
            "SELECT value FROM settings WHERE key='undoDeleteIds'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(undo, "[]");
    c.execute(
        "INSERT INTO settings VALUES ('undoDeleteIds.extra','private-unknown')",
        [],
    )
    .unwrap();
    drop(c);
    let mut db = Store::open(&p).unwrap();
    db.replace(&scratchtree_lib::model::WorkspaceSnapshot::default())
        .unwrap();
    drop(db);
    let c = Connection::open(&p).unwrap();
    let unknown: String = c
        .query_row(
            "SELECT value FROM settings WHERE key='undoDeleteIds.extra'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unknown, "private-unknown");
    c.execute(
        "UPDATE settings SET value='not-json' WHERE key='undoDeleteIds'",
        [],
    )
    .unwrap();
    drop(c);
    let before = std::fs::read(&p).unwrap();
    assert!(Store::open(&p).is_err());
    assert_eq!(std::fs::read(&p).unwrap(), before);
}
#[test]
fn backup_seven_requires_ordered_unique_exact_explicit_deletion_ids() {
    let valid = br#"{"format":"scratchtree-alpha","version":7,"exportedAt":"2026-11-12T00:00:00.000Z","library":{"items":[],"drafts":[],"undoDeleteIds":[]}}"#;
    assert!(backup::validate(valid).is_ok());
}

use scratchtree_lib::{
    model::*,
    store::{capture_move, capture_undo},
};
fn id(n: u128) -> String {
    uuid::Uuid::from_u128(n).to_string()
}
fn item(n: u128, parent: Option<u128>, kind: Kind, position: i64) -> Item {
    Item {
        id: id(n),
        parent_id: parent.map(id),
        kind,
        position,
        markdown: format!("**{n}**\r\n"),
        done: true,
        color: Some(ColorToken::Purple),
        created_at: 1,
        updated_at: 2,
        deleted_at: None,
        restore_parent_id: None,
        restore_index: None,
    }
}
fn root(scope: Scope) -> Location {
    Location {
        scope,
        item_id: None,
    }
}
fn movement(
    ids: Vec<String>,
    from: Location,
    to: Location,
    before_from: Vec<String>,
    before_to: Vec<String>,
    after_from: Vec<String>,
    after_to: Vec<String>,
) -> MoveItems {
    MoveItems {
        ids,
        from,
        to,
        before_from,
        before_to,
        after_from,
        after_to,
        proof: None,
        deleted_at: Some(100),
    }
}
#[test]
fn group_move_undo_reopens_and_exact_replay_preserves_content_and_newer_marker() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("workspace.sqlite3");
    let mut db = Store::open(&p).unwrap();
    let s = WorkspaceSnapshot {
        items: vec![
            item(1, None, Kind::Note, 0),
            item(2, None, Kind::Note, 1),
            item(3, None, Kind::Note, 2),
            item(4, None, Kind::Tree, 3),
            item(5, Some(4), Kind::Note, 0),
        ],
        drafts: vec![Draft {
            key: id(1),
            markdown: "draft\r\n".into(),
            revision: 3,
            updated_at: 5,
        }],
        undo_delete_ids: vec![],
    };
    db.replace(&s).unwrap();
    let r = capture_move(
        &s,
        movement(
            vec![id(1), id(3)],
            root(Scope::Live),
            root(Scope::Trash),
            vec![id(1), id(2), id(3), id(4)],
            vec![],
            vec![id(2), id(4)],
            vec![id(1), id(3)],
        ),
    )
    .unwrap();
    let moved = db.move_items(&r).unwrap();
    assert_eq!(moved.undo_delete_ids, vec![id(1), id(3)]);
    drop(db);
    let mut db = Store::open(&p).unwrap();
    assert_eq!(db.move_items(&r).unwrap(), moved);
    let newer = db.delete(&id(5)).unwrap();
    assert_eq!(db.move_items(&r).unwrap(), newer);
    // Undo captures the currently remaining action, not the historical movement.
    let request = capture_undo(&newer).unwrap();
    let after = db.undo(&request).unwrap();
    assert!(after.undo_delete_ids.is_empty());
    let next = db.delete(&id(2)).unwrap();
    assert_eq!(db.undo(&request).unwrap(), next);
    assert_eq!(next.drafts, s.drafts);
    let imported = backup::validate(&backup::encode(&next).unwrap()).unwrap();
    assert_eq!(imported.library, next);
}
#[test]
fn one_group_undo_restores_noncontiguous_source_order_and_filters_partial_members() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("workspace.sqlite3")).unwrap();
    let s = WorkspaceSnapshot {
        items: (1..=4)
            .map(|n| item(n, None, Kind::Note, n as i64 - 1))
            .collect(),
        ..Default::default()
    };
    db.replace(&s).unwrap();
    let r = capture_move(
        &s,
        movement(
            vec![id(1), id(3)],
            root(Scope::Live),
            root(Scope::Trash),
            (1..=4).map(id).collect(),
            vec![],
            vec![id(2), id(4)],
            vec![id(1), id(3)],
        ),
    )
    .unwrap();
    db.move_items(&r).unwrap();
    let request = capture_undo(&db.load().unwrap()).unwrap();
    let after = db.undo(&request).unwrap();
    let mut live: Vec<_> = after.items.iter().collect();
    live.sort_by_key(|x| x.position);
    assert_eq!(
        live.iter().map(|x| x.id.clone()).collect::<Vec<_>>(),
        (1..=4).map(id).collect::<Vec<_>>()
    );
    db.move_items(
        &capture_move(
            &after,
            movement(
                vec![id(1), id(3)],
                root(Scope::Live),
                root(Scope::Trash),
                (1..=4).map(id).collect(),
                vec![],
                vec![id(2), id(4)],
                vec![id(1), id(3)],
            ),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(db.restore(&id(1)).unwrap().undo_delete_ids, vec![id(3)]);
    let pending = db.load().unwrap();
    let request = capture_undo(&pending).unwrap();
    let mut changed = pending.clone();
    changed
        .items
        .iter_mut()
        .find(|x| x.id == id(3))
        .unwrap()
        .restore_index = Some(7);
    db.replace(&changed).unwrap();
    assert!(db.undo(&request).is_err());
    assert_eq!(db.load().unwrap(), changed);
}
#[test]
fn trash_to_live_chosen_owner_detaches_nearest_independent_records_and_preserves_group_members() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("workspace.sqlite3")).unwrap();
    let mut a = item(1, None, Kind::Tree, 0);
    a.deleted_at = Some(3);
    let mut independent = item(3, Some(2), Kind::Tree, 0);
    independent.deleted_at = Some(4);
    independent.restore_parent_id = Some(id(2));
    independent.restore_index = Some(0);
    let mut deeper = item(4, Some(3), Kind::Note, 0);
    deeper.deleted_at = Some(5);
    deeper.restore_parent_id = Some(id(3));
    deeper.restore_index = Some(0);
    let s = WorkspaceSnapshot {
        items: vec![
            a,
            item(2, Some(1), Kind::Tree, 0),
            independent,
            deeper,
            item(5, None, Kind::Tree, 0),
        ],
        drafts: vec![],
        undo_delete_ids: vec![id(1), id(3), id(4)],
    };
    db.replace(&s).unwrap();
    let to = Location {
        scope: Scope::Live,
        item_id: Some(id(5)),
    };
    let r = capture_move(
        &s,
        movement(
            vec![id(1)],
            root(Scope::Trash),
            to,
            vec![id(1)],
            vec![],
            vec![],
            vec![id(1)],
        ),
    )
    .unwrap();
    let after = db.move_items(&r).unwrap();
    assert_eq!(after.undo_delete_ids, vec![id(3), id(4)]);
    assert_eq!(
        after
            .items
            .iter()
            .find(|x| x.id == id(3))
            .unwrap()
            .parent_id,
        None
    );
    assert_eq!(
        after
            .items
            .iter()
            .find(|x| x.id == id(4))
            .unwrap()
            .parent_id,
        Some(id(3))
    );
    assert_eq!(db.move_items(&r).unwrap(), after);
    let request = capture_undo(&after).unwrap();
    let undone = db.undo(&request).unwrap();
    assert!(undone.undo_delete_ids.is_empty());
    assert_eq!(
        undone
            .items
            .iter()
            .find(|x| x.id == id(3))
            .unwrap()
            .parent_id,
        Some(id(2))
    );
    assert_eq!(
        undone
            .items
            .iter()
            .find(|x| x.id == id(4))
            .unwrap()
            .parent_id,
        Some(id(3))
    );
}
#[test]
fn stale_redelete_cannot_be_consumed_by_old_exact_undo_request() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("workspace.sqlite3")).unwrap();
    let mut x = item(1, None, Kind::Note, 0);
    x.updated_at = now() + 100000;
    db.replace(&WorkspaceSnapshot {
        items: vec![x],
        ..Default::default()
    })
    .unwrap();
    let first = db.delete(&id(1)).unwrap();
    let request = capture_undo(&first).unwrap();
    db.undo(&request).unwrap();
    let newer = db.delete(&id(1)).unwrap();
    assert_ne!(first.items[0].deleted_at, newer.items[0].deleted_at);
    assert!(db.undo(&request).is_err());
    assert_eq!(db.load().unwrap(), newer);
}

#[test]
fn schema_seven_missing_null_malformed_duplicate_live_or_wrong_case_marker_rejects_without_writes()
{
    for raw in [
        None,
        Some("null"),
        Some("{}"),
        Some("[1]"),
        Some("[\"missing\"]"),
        Some("[\"00000000-0000-0000-0000-000000000001\"]"),
    ] {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("workspace.sqlite3");
        let mut db = Store::open(&p).unwrap();
        db.replace(&WorkspaceSnapshot {
            items: vec![item(1, None, Kind::Note, 0)],
            ..Default::default()
        })
        .unwrap();
        drop(db);
        let c = Connection::open(&p).unwrap();
        match raw {
            Some(raw) => {
                c.execute(
                    "UPDATE settings SET value=?1 WHERE key='undoDeleteIds'",
                    [raw],
                )
                .unwrap();
            }
            None => {
                c.execute("DELETE FROM settings WHERE key='undoDeleteIds'", [])
                    .unwrap();
            }
        }
        drop(c);
        let before = std::fs::read(&p).unwrap();
        assert!(Store::open(&p).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), before);
    }
}

#[test]
fn broad_group_undo_has_one_atomic_mutation_and_preserves_four_thousand_roots_in_marker_order() {
    for width in [1000, 4000] {
        let d = tempfile::tempdir().unwrap();
        let mut db = Store::open(&d.path().join("workspace.sqlite3")).unwrap();
        let mut s = WorkspaceSnapshot::default();
        for n in 1..=width {
            let mut x = item(n, None, Kind::Note, n as i64 - 1);
            x.deleted_at = Some(3);
            x.restore_index = Some(n as i64 - 1);
            s.items.push(x);
            s.undo_delete_ids.push(id(n));
        }
        db.replace(&s).unwrap();
        let c = Connection::open(d.path().join("workspace.sqlite3")).unwrap();
        c.execute_batch("INSERT INTO settings VALUES ('test-insert-count','0');CREATE TRIGGER count_inserts AFTER INSERT ON items BEGIN UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='test-insert-count'; END;").unwrap();
        let started = std::time::Instant::now();
        let request = capture_undo(&s).unwrap();
        let after = db.undo(&request).unwrap();
        eprintln!("group Undo width={width}: {:?}", started.elapsed());
        assert_eq!(
            c.query_row(
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key='test-insert-count'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            width as i64
        );
        assert!(after.undo_delete_ids.is_empty());
        assert_eq!(after.items.len(), width as usize);
        for x in &after.items {
            let n = uuid::Uuid::parse_str(&x.id).unwrap().as_u128();
            assert_eq!(x.position, n as i64 - 1);
            assert_eq!(x.markdown, format!("**{n}**\r\n"));
            assert_eq!(x.deleted_at, None);
        }
    }
}
#[test]
fn exact_move_and_undo_replay_acknowledge_without_any_sql_write() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("workspace.sqlite3");
    let mut db = Store::open(&p).unwrap();
    let s = WorkspaceSnapshot {
        items: vec![item(1, None, Kind::Note, 0)],
        ..Default::default()
    };
    db.replace(&s).unwrap();
    let request = capture_move(
        &s,
        movement(
            vec![id(1)],
            root(Scope::Live),
            root(Scope::Trash),
            vec![id(1)],
            vec![],
            vec![],
            vec![id(1)],
        ),
    )
    .unwrap();
    let after = db.move_items(&request).unwrap();
    let c = Connection::open(&p).unwrap();
    c.execute_batch("CREATE TRIGGER refuse_write BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT,'replay must never write'); END;").unwrap();
    assert_eq!(db.move_items(&request).unwrap(), after);
    c.execute_batch("DROP TRIGGER refuse_write;").unwrap();
    let undo = capture_undo(&after).unwrap();
    let restored = db.undo(&undo).unwrap();
    c.execute_batch("CREATE TRIGGER refuse_write BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT,'replay must never write'); END;").unwrap();
    assert_eq!(db.undo(&undo).unwrap(), restored);
}
#[test]
fn group_undo_rejects_partial_or_altered_after_and_actual_sql_failure_rolls_back_all_members() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("workspace.sqlite3");
    let mut db = Store::open(&p).unwrap();
    let mut s = WorkspaceSnapshot::default();
    for n in 1..=2 {
        let mut x = item(n, None, Kind::Note, n as i64 - 1);
        x.deleted_at = Some(3);
        x.restore_index = Some(n as i64 - 1);
        s.items.push(x);
        s.undo_delete_ids.push(id(n));
    }
    db.replace(&s).unwrap();
    let r = capture_undo(&s).unwrap();
    let mut altered = r.clone();
    altered.proof.after[0].position = 7;
    assert!(db.undo(&altered).is_err());
    assert_eq!(db.load().unwrap(), s);
    db.restore(&id(1)).unwrap();
    let partial = db.load().unwrap();
    assert!(db.undo(&r).is_err());
    assert_eq!(db.load().unwrap(), partial);
    db.replace(&s).unwrap();
    let c = Connection::open(&p).unwrap();
    c.execute_batch(&format!("CREATE TRIGGER fail_member AFTER INSERT ON items WHEN NEW.id='{}' BEGIN SELECT RAISE(ABORT,'synthetic second member failure'); END;",id(2))).unwrap();
    drop(c);
    let before = std::fs::read(&p).unwrap();
    assert!(db.undo(&r).is_err());
    assert_eq!(db.load().unwrap(), s);
    assert_eq!(std::fs::read(&p).unwrap(), before);
}
#[test]
fn cross_area_rejects_added_children_changed_facts_and_replays_newer_source_only_without_timestamp_touch(
) {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("workspace.sqlite3")).unwrap();
    let s = WorkspaceSnapshot {
        items: vec![
            item(1, None, Kind::Tree, 0),
            item(2, Some(1), Kind::Note, 0),
        ],
        ..Default::default()
    };
    db.replace(&s).unwrap();
    let r = capture_move(
        &s,
        movement(
            vec![id(1)],
            root(Scope::Live),
            root(Scope::Trash),
            vec![id(1)],
            vec![],
            vec![],
            vec![id(1)],
        ),
    )
    .unwrap();
    let mut extra = s.clone();
    extra.items.push(item(3, Some(1), Kind::Note, 1));
    db.replace(&extra).unwrap();
    assert!(db.move_items(&r).is_err());
    assert_eq!(db.load().unwrap(), extra);
    db.replace(&s).unwrap();
    let mut moved = db.move_items(&r).unwrap();
    moved.items[0].deleted_at = Some(101);
    db.replace(&moved).unwrap();
    assert!(db.move_items(&r).is_err());
    assert_eq!(db.load().unwrap(), moved);
    db.replace(&s).unwrap();
    db.move_items(&r).unwrap();
    let edited = db
        .save_source(
            &id(2),
            "newer **source**\r\n",
            &DraftAck {
                key: id(2),
                revision: 0,
            },
        )
        .unwrap();
    assert_eq!(db.move_items(&r).unwrap(), edited);
    let undo = capture_undo(&edited).unwrap();
    db.undo(&undo).unwrap();
    let edited = db
        .save_source(
            &id(1),
            "newer root",
            &DraftAck {
                key: id(1),
                revision: 0,
            },
        )
        .unwrap();
    assert_eq!(db.undo(&undo).unwrap(), edited);
}
#[test]
fn singleton_restore_preserves_manually_reordered_inherited_siblings_when_detaching_independent_record(
) {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("workspace.sqlite3")).unwrap();
    let mut root = item(1, None, Kind::Tree, 0);
    root.deleted_at = Some(3);
    let mut detached = item(4, Some(1), Kind::Note, 1);
    detached.deleted_at = Some(4);
    db.replace(&WorkspaceSnapshot {
        items: vec![
            root,
            item(2, Some(1), Kind::Note, 2),
            item(3, Some(1), Kind::Note, 0),
            detached,
        ],
        ..Default::default()
    })
    .unwrap();
    let restored = db.restore(&id(1)).unwrap();
    let mut children: Vec<_> = restored
        .items
        .iter()
        .filter(|x| x.parent_id == Some(id(1)))
        .collect();
    children.sort_by_key(|x| x.position);
    assert_eq!(
        children.iter().map(|x| x.id.clone()).collect::<Vec<_>>(),
        vec![id(3), id(2)]
    );
}
#[test]
fn filtered_group_shared_future_stamp_cannot_be_reused_by_later_singleton_deletion() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("workspace.sqlite3")).unwrap();
    let future = now() + 100000;
    let mut a = item(1, None, Kind::Note, 0);
    a.updated_at = future - 2;
    let mut b = item(2, None, Kind::Note, 1);
    b.updated_at = future;
    let s = WorkspaceSnapshot {
        items: vec![a, b],
        ..Default::default()
    };
    db.replace(&s).unwrap();
    let mut r = movement(
        vec![id(1), id(2)],
        root(Scope::Live),
        root(Scope::Trash),
        vec![id(1), id(2)],
        vec![],
        vec![],
        vec![id(1), id(2)],
    );
    r.deleted_at = Some(future + 1);
    let r = capture_move(&s, r).unwrap();
    db.move_items(&r).unwrap();
    db.restore(&id(2)).unwrap();
    let request = capture_undo(&db.load().unwrap()).unwrap();
    db.undo(&request).unwrap();
    let newer = db.delete(&id(1)).unwrap();
    assert!(db.undo(&request).is_err());
    assert_eq!(db.load().unwrap(), newer);
}
#[test]
fn replay_batches_thousands_of_distinct_independent_deletion_groups() {
    for width in [250, 1000, 4000] {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("workspace.sqlite3");
        let mut db = Store::open(&p).unwrap();
        let mut ancestor = item(1, None, Kind::Tree, 0);
        ancestor.deleted_at = Some(3);
        let mut s = WorkspaceSnapshot {
            items: vec![ancestor],
            ..Default::default()
        };
        for i in 0..width {
            s.items.push(item(i * 2 + 2, Some(1), Kind::Tree, i as i64));
            let mut independent = item(i * 2 + 3, Some(i * 2 + 2), Kind::Note, 0);
            independent.deleted_at = Some(4);
            s.items.push(independent);
        }
        db.replace(&s).unwrap();
        let r = capture_move(
            &s,
            movement(
                vec![id(1)],
                root(Scope::Trash),
                root(Scope::Live),
                vec![id(1)],
                vec![],
                vec![],
                vec![id(1)],
            ),
        )
        .unwrap();
        let expected = db.move_items(&r).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(db.move_items(&r).unwrap(), expected);
        eprintln!(
            "distinct-group replay width={width}: {:?}",
            started.elapsed()
        );
    }
}

#[test]
fn public_singleton_undo_capture_is_canonical_for_unsorted_valid_snapshot() {
    let d = tempfile::tempdir().unwrap();
    let mut db = Store::open(&d.path().join("workspace.sqlite3")).unwrap();
    let mut parent = item(1, None, Kind::Tree, 0);
    parent.deleted_at = Some(3);
    let mut three = item(3, Some(1), Kind::Note, 0);
    three.deleted_at = Some(4);
    let mut two = item(2, Some(1), Kind::Note, 1);
    two.deleted_at = Some(5);
    let unsorted = WorkspaceSnapshot {
        items: vec![parent, three.clone(), two.clone()],
        drafts: vec![Draft {
            key: id(3),
            markdown: "draft\r\n".into(),
            revision: 8,
            updated_at: 9,
        }],
        undo_delete_ids: vec![id(1)],
    };
    let request = capture_undo(&unsorted).unwrap();
    db.replace(&unsorted).unwrap();
    let loaded = db.load().unwrap();
    assert_eq!(
        serde_json::to_value(&request.proof).unwrap(),
        serde_json::to_value(capture_undo(&loaded).unwrap().proof).unwrap()
    );
    let after = db.undo(&request).unwrap();
    let mut roots: Vec<_> = after
        .items
        .iter()
        .filter(|x| x.deleted_at.is_some())
        .collect();
    roots.sort_by_key(|x| x.position);
    assert_eq!(
        roots.iter().map(|x| x.id.clone()).collect::<Vec<_>>(),
        vec![id(3), id(2)]
    );
    three.parent_id = None;
    three.position = 0;
    two.parent_id = None;
    two.position = 1;
    assert_eq!(after.items.iter().find(|x| x.id == id(3)), Some(&three));
    assert_eq!(after.items.iter().find(|x| x.id == id(2)), Some(&two));
    assert_eq!(after.drafts, unsorted.drafts);
    assert_eq!(db.undo(&request).unwrap(), after);
}
