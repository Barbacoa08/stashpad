use stashpad_alpha_kit::{backup, model::*, store::Store};
fn snapshot() -> WorkspaceSnapshot {
    let id = "11111111-1111-4111-8111-111111111111".to_string();
    WorkspaceSnapshot {
        notes: vec![Note {
            id: id.clone(),
            markdown: "α **source**  \n```js\nlet a='*';\n```\n".into(),
            created_at: 1,
            updated_at: 2,
            deleted_at: None,
        }],
        drafts: vec![Draft {
            key: id,
            markdown: "unfinished  \n".into(),
            revision: 4,
            updated_at: 5,
        }],
        undo_delete_id: None,
    }
}
#[test]
fn complete_backup_preserves_exact_fields() {
    let s = snapshot();
    assert_eq!(
        backup::validate(&backup::encode(&s).unwrap())
            .unwrap()
            .workspace,
        s
    );
}
#[test]
fn malformed_types_duplicate_future_dangling_missing_nullable() {
    let s = snapshot();
    let valid: serde_json::Value = serde_json::from_slice(&backup::encode(&s).unwrap()).unwrap();
    for case in [
        "future",
        "duplicate",
        "dangling",
        "missingUndo",
        "missingDeleted",
        "type",
        "time",
        "extra",
        "negative",
        "draftDuplicate",
    ] {
        let mut v = valid.clone();
        match case {
            "future" => v["version"] = 2.into(),
            "duplicate" => {
                let n = v["workspace"]["notes"][0].clone();
                v["workspace"]["notes"].as_array_mut().unwrap().push(n)
            }
            "dangling" => {
                v["workspace"]["drafts"][0]["key"] = "33333333-3333-4333-8333-333333333333".into()
            }
            "missingUndo" => {
                v["workspace"]
                    .as_object_mut()
                    .unwrap()
                    .remove("undoDeleteId");
            }
            "missingDeleted" => {
                v["workspace"]["notes"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("deletedAt");
            }
            "type" => v["workspace"]["notes"][0]["createdAt"] = "1".into(),
            "time" => v["exportedAt"] = "2026-02-30T00:00:00.000Z".into(),
            "extra" => v["machinePath"] = "/private".into(),
            "negative" => v["workspace"]["notes"][0]["createdAt"] = (-1).into(),
            "draftDuplicate" => {
                let d = v["workspace"]["drafts"][0].clone();
                v["workspace"]["drafts"].as_array_mut().unwrap().push(d)
            }
            _ => {}
        }
        assert!(
            backup::validate(&serde_json::to_vec(&v).unwrap()).is_err(),
            "accepted {case}"
        );
    }
    assert!(backup::validate(b"{").is_err());
    assert!(backup::validate(&vec![b' '; MAX_ENVELOPE + 1]).is_err());
}
#[test]
fn oversized_source_and_unicode_timestamp_are_safe() {
    let mut s = snapshot();
    s.notes[0].markdown = "x".repeat(MAX_SOURCE + 1);
    assert!(backup::encode(&s).is_err());
    let mut v: serde_json::Value =
        serde_json::from_slice(&backup::encode(&snapshot()).unwrap()).unwrap();
    v["exportedAt"] = "🦀🦀🦀🦀🦀🦀".into();
    assert!(backup::validate(&serde_json::to_vec(&v).unwrap()).is_err());
}
#[test]
fn separate_store_roundtrip_and_safety_backup() {
    let dir = tempfile::tempdir().unwrap();
    let mut first = Store::open(&dir.path().join("first.sqlite3")).unwrap();
    let created = first.save(None, "deleted source", "compose", 1).unwrap();
    let id = created.notes[0].id.clone();
    first.checkpoint("compose", "new draft", 8).unwrap();
    let before = first.delete(&id).unwrap();
    let encoded = backup::encode(&before).unwrap();
    let staged = backup::validate(&encoded).unwrap();
    let mut second = Store::open(&dir.path().join("second.sqlite3")).unwrap();
    let safety = dir.path().join("safety.json");
    let restored = second
        .restore_with_safety(&staged.workspace, &safety, false)
        .unwrap();
    assert_eq!(restored, before);
    assert!(backup::validate(&std::fs::read(safety).unwrap())
        .unwrap()
        .workspace
        .notes
        .is_empty());
}
#[test]
fn failed_safety_write_or_transaction_keeps_previous_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Store::open(&dir.path().join("notes.sqlite3")).unwrap();
    let before = db.save(None, "previous", "compose", 1).unwrap();
    let next = snapshot();
    assert!(db
        .restore_with_safety(&next, &dir.path().join("missing/safety.json"), false)
        .is_err());
    assert_eq!(db.load().unwrap(), before);
    assert!(db
        .restore_with_safety(&next, &dir.path().join("safety.json"), true)
        .is_err());
    assert_eq!(db.load().unwrap(), before);
    let safety = backup::validate(&std::fs::read(dir.path().join("safety.json")).unwrap()).unwrap();
    assert_eq!(safety.workspace, before);
    db.restore_with_safety(&next, &dir.path().join("retry.json"), false)
        .unwrap();
    assert_eq!(db.load().unwrap(), next);
}
#[test]
fn atomic_export_failure_retains_destination() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("backup.json");
    backup::atomic_write(&p, b"previous").unwrap();
    assert!(backup::atomic_write(&dir.path().join("missing/backup.json"), b"next").is_err());
    assert_eq!(std::fs::read(&p).unwrap(), b"previous");
}

#[test]
fn public_reusable_fixtures() {
    assert!(backup::validate(include_bytes!("../../tests/fixtures/valid-v1.json")).is_ok());
    assert!(backup::validate(include_bytes!("../../tests/fixtures/invalid-future.json")).is_err());
}

#[test]
fn uppercase_reference_spelling_and_actual_file_restore_recovery() {
    let active = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA".to_string();
    let deleted = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB".to_string();
    let s = WorkspaceSnapshot {
        notes: vec![
            Note {
                id: active.clone(),
                markdown: "saved uppercase".into(),
                created_at: 1,
                updated_at: 2,
                deleted_at: None,
            },
            Note {
                id: deleted.clone(),
                markdown: "deleted uppercase".into(),
                created_at: 1,
                updated_at: 2,
                deleted_at: Some(3),
            },
        ],
        drafts: vec![Draft {
            key: active.clone(),
            markdown: "unfinished uppercase".into(),
            revision: 4,
            updated_at: 5,
        }],
        undo_delete_id: Some(deleted.clone()),
    };
    let bytes = backup::encode(&s).unwrap();
    let staged = backup::validate(&bytes).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("uppercase.sqlite3");
    let mut db = Store::open(&path).unwrap();
    let original = db.save(None, "previous workspace", "compose", 1).unwrap();
    for kind in ["draft", "undo", "duplicate"] {
        let mut malformed = staged.workspace.clone();
        match kind {
            "draft" => malformed.drafts[0].key = active.to_lowercase(),
            "undo" => malformed.undo_delete_id = Some(deleted.to_lowercase()),
            _ => {
                let mut duplicate = malformed.notes[0].clone();
                duplicate.id = active.to_lowercase();
                malformed.notes.push(duplicate)
            }
        }
        let v = serde_json::json!({"format":"stashpad-alpha","version":1,"exportedAt":"2026-11-10T00:00:00.000Z","workspace":malformed});
        assert!(
            backup::validate(&serde_json::to_vec(&v).unwrap()).is_err(),
            "accepted {kind}"
        );
        assert!(db
            .restore_with_safety(&malformed, &dir.path().join("rejected-safety.json"), false)
            .is_err());
        assert_eq!(db.load().unwrap(), original);
    }
    db.restore_with_safety(&staged.workspace, &dir.path().join("safety.json"), false)
        .unwrap();
    drop(db);
    let mut db = Store::open(&path).unwrap();
    let restored = db.load().unwrap();
    assert_eq!(restored, s);
    assert_eq!(
        restored
            .drafts
            .iter()
            .find(|d| d.key == active)
            .unwrap()
            .markdown,
        "unfinished uppercase"
    );
    assert_eq!(
        backup::validate(&backup::encode(&restored).unwrap())
            .unwrap()
            .workspace,
        s
    );
    let undone = db.undo().unwrap();
    assert!(undone
        .notes
        .iter()
        .find(|n| n.id == deleted)
        .unwrap()
        .deleted_at
        .is_none());
}
