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
    let s = db.save(None, source, "compose", 1).unwrap();
    let id = s.notes[0].id.clone();
    db.save(Some(&id), "edited \n", &id, 2).unwrap();
    drop(db);
    let mut db = Store::open(&dir.path().join("notes.sqlite3")).unwrap();
    assert_eq!(db.load().unwrap().notes[0].markdown, "edited \n");
}
#[test]
fn latest_revision_and_save_preserves_newer_draft() {
    let (_dir, mut db) = store();
    db.checkpoint("compose", "newer", 3).unwrap();
    db.checkpoint("compose", "older", 2).unwrap();
    let s = db.save(None, "saved", "compose", 2).unwrap();
    assert_eq!(s.drafts[0].markdown, "newer");
}
#[test]
fn delete_undo_after_reopen() {
    let (dir, mut db) = store();
    let s = db.save(None, "a", "compose", 1).unwrap();
    let id = &s.notes[0].id;
    db.delete(id).unwrap();
    drop(db);
    let mut db = Store::open(&dir.path().join("notes.sqlite3")).unwrap();
    assert!(db.load().unwrap().undo_delete_id.is_some());
    assert_eq!(db.undo().unwrap().notes[0].deleted_at, None);
}
#[test]
fn atomic_failure_rolls_back() {
    let (_dir, mut db) = store();
    let before = db.load().unwrap();
    assert!(db.save(None, " ", "compose", 1).is_err());
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
    let s = db.save(None, &source, "compose", 1).unwrap();
    assert!(db
        .save(None, &"x".repeat(MAX_SOURCE + 1), "compose", 2)
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
    let s = db.save(None, "committed", "compose", 1).unwrap();
    assert!(db
        .replace_with_failure(&WorkspaceSnapshot::default(), true)
        .is_err());
    assert_eq!(db.load().unwrap(), s);
}
#[test]
fn monotonic_timestamp_under_backward_clock() {
    let (_dir, mut db) = store();
    let mut s = db.save(None, "a", "compose", 1).unwrap();
    s.notes[0].updated_at += 1_000_000;
    let old = s.notes[0].updated_at;
    db.replace(&s).unwrap();
    let s = db.save(Some(&s.notes[0].id), "b", "compose", 2).unwrap();
    assert_eq!(s.notes[0].updated_at, old + 1);
}
#[test]
fn full_note_draft_count_boundary_roundtrips() {
    let (_dir, mut db) = store();
    let mut s = WorkspaceSnapshot::default();
    for i in 0..10000 {
        let id = uuid::Uuid::from_u128(i + 1).to_string();
        s.notes.push(Note {
            id: id.clone(),
            markdown: "x".into(),
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
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
    assert!(db.save(None, "one over", "compose", 1).is_err());
    assert_eq!(db.load().unwrap(), committed);
}
#[test]
fn compact_envelope_exact_limit_includes_drafts_and_metadata() {
    let (_dir, mut db) = store();
    let mut s = WorkspaceSnapshot::default();
    for i in 0..9 {
        s.notes.push(Note {
            id: uuid::Uuid::from_u128(i + 1).to_string(),
            markdown: "x".repeat(MAX_SOURCE),
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
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
