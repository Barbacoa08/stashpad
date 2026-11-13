use rusqlite::Connection;
use scratchtree_lib::{backup, model::*, store::Store};
const ID: &str = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
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
    {
        let r = scratchtree_lib::store::capture_undo(&db.load().unwrap()).unwrap();
        db.undo(&r)
    }
    .unwrap();
    drop(db);
    let mut db = Store::open(&path).unwrap();
    let saved = db.load().unwrap();
    assert!(!saved.items[0].done);
    assert_eq!(
        backup::validate(&backup::encode(&saved).unwrap())
            .unwrap()
            .library,
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
fn current_completed_utf8_source_capacity_is_exact() {
    let mut s = backup::validate(include_bytes!("../../tests/fixtures/valid-v7.json"))
        .unwrap()
        .library;
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
