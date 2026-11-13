mod common;
use common::*;
use scratchtree_lib::{backup, model::*, store::Store};
fn snapshot() -> WorkspaceSnapshot {
    let id = "11111111-1111-4111-8111-111111111111".to_string();
    WorkspaceSnapshot {
        items: vec![Item {
            parent_id: None,
            id: id.clone(),
            markdown: "α **source**  \n```js\nlet a='*';\n```\n".into(),
            created_at: 1,
            updated_at: 2,
            done: false,
            deleted_at: None,
            ..item()
        }],
        drafts: vec![Draft {
            key: id,
            markdown: "unfinished  \n".into(),
            revision: 4,
            updated_at: 5,
        }],
        undo_delete_ids: vec![],
    }
}
#[test]
fn complete_backup_preserves_exact_fields() {
    let s = snapshot();
    assert_eq!(
        backup::validate(&backup::encode(&s).unwrap())
            .unwrap()
            .library,
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
            "future" => v["version"] = 8.into(),
            "duplicate" => {
                let n = v["library"]["items"][0].clone();
                v["library"]["items"].as_array_mut().unwrap().push(n)
            }
            "dangling" => {
                v["library"]["drafts"][0]["key"] = "33333333-3333-4333-8333-333333333333".into()
            }
            "missingUndo" => {
                v["library"]
                    .as_object_mut()
                    .unwrap()
                    .remove("undoDeleteIds");
            }
            "missingDeleted" => {
                v["library"]["items"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("deletedAt");
            }
            "type" => v["library"]["items"][0]["createdAt"] = "1".into(),
            "time" => v["exportedAt"] = "2026-02-30T00:00:00.000Z".into(),
            "extra" => v["machinePath"] = "/private".into(),
            "negative" => v["library"]["items"][0]["createdAt"] = (-1).into(),
            "draftDuplicate" => {
                let d = v["library"]["drafts"][0].clone();
                v["library"]["drafts"].as_array_mut().unwrap().push(d)
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
    s.items[0].markdown = "x".repeat(MAX_SOURCE + 1);
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
    let created = first
        .save(None, "deleted source", "compose", 1, None)
        .unwrap();
    let id = created.items[0].id.clone();
    first.set_done(&id, true).unwrap();
    first.checkpoint("compose", "new draft", 8).unwrap();
    let before = first.delete(&id).unwrap();
    let encoded = backup::encode(&before).unwrap();
    let staged = backup::validate(&encoded).unwrap();
    let mut second = Store::open(&dir.path().join("second.sqlite3")).unwrap();
    let safety = dir.path().join("safety.json");
    let restored = second
        .restore_with_safety(&staged.library, &safety, false)
        .unwrap();
    assert_eq!(restored, before);
    assert!(backup::validate(&std::fs::read(safety).unwrap())
        .unwrap()
        .library
        .items
        .is_empty());
}
#[test]
fn failed_safety_write_or_transaction_keeps_previous_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Store::open(&dir.path().join("notes.sqlite3")).unwrap();
    let before = db.save(None, "previous", "compose", 1, None).unwrap();
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
    assert_eq!(safety.library, before);
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
    assert!(backup::validate(include_bytes!("../../tests/fixtures/valid-v7.json")).is_ok());
    assert!(backup::validate(b"{\"version\":99}").is_err());
}

#[test]
fn uppercase_reference_spelling_and_actual_file_restore_recovery() {
    let active = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA".to_string();
    let deleted = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB".to_string();
    let s = WorkspaceSnapshot {
        items: vec![
            Item {
                parent_id: None,
                id: active.clone(),
                markdown: "saved uppercase".into(),
                created_at: 1,
                updated_at: 2,
                done: false,
                deleted_at: None,
                ..item()
            },
            Item {
                parent_id: None,
                id: deleted.clone(),
                markdown: "deleted uppercase".into(),
                created_at: 1,
                updated_at: 2,
                done: false,
                deleted_at: Some(3),
                ..item()
            },
        ],
        drafts: vec![Draft {
            key: active.clone(),
            markdown: "unfinished uppercase".into(),
            revision: 4,
            updated_at: 5,
        }],
        undo_delete_ids: vec![deleted.clone()],
    };
    let bytes = backup::encode(&s).unwrap();
    let staged = backup::validate(&bytes).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("uppercase.sqlite3");
    let mut db = Store::open(&path).unwrap();
    let original = db
        .save(None, "previous workspace", "compose", 1, None)
        .unwrap();
    for kind in ["draft", "undo", "duplicate"] {
        let mut malformed = staged.library.clone();
        match kind {
            "draft" => malformed.drafts[0].key = active.to_lowercase(),
            "undo" => malformed.undo_delete_ids = vec![deleted.to_lowercase()],
            _ => {
                let mut duplicate = malformed.items[0].clone();
                duplicate.id = active.to_lowercase();
                malformed.items.push(duplicate)
            }
        }
        let v = serde_json::json!({"format":"scratchtree-alpha","version":7,"exportedAt":"2026-11-10T00:00:00.000Z","library":malformed});
        assert!(
            backup::validate(&serde_json::to_vec(&v).unwrap()).is_err(),
            "accepted {kind}"
        );
        assert!(db
            .restore_with_safety(&malformed, &dir.path().join("rejected-safety.json"), false)
            .is_err());
        assert_eq!(db.load().unwrap(), original);
    }
    db.restore_with_safety(&staged.library, &dir.path().join("safety.json"), false)
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
            .library,
        s
    );
    let undone = {
        let r = scratchtree_lib::store::capture_undo(&db.load().unwrap()).unwrap();
        db.undo(&r)
    }
    .unwrap();
    assert!(undone
        .items
        .iter()
        .find(|n| n.id == deleted)
        .unwrap()
        .deleted_at
        .is_none());
}

#[test]
fn scratchtree_contract_is_version_seven_library_and_accepts_tree() {
    let mut s = snapshot();
    let mut value: serde_json::Value =
        serde_json::from_slice(&backup::encode(&s).unwrap()).unwrap();
    assert_eq!(value["format"], "scratchtree-alpha");
    assert_eq!(value["version"], 7);
    assert_eq!(value["library"], serde_json::to_value(&s).unwrap());
    value["library"]["items"][0]["kind"] = "tree".into();
    assert!(backup::validate(&serde_json::to_vec(&value).unwrap()).is_ok());
    s.items[0].done = true;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&backup::encode(&s).unwrap()).unwrap()
            ["library"]["items"][0]["done"],
        true
    );
}

#[test]
fn current_library_rejects_corrupt_graph_metadata_and_group_undo_before_replacement() {
    let valid: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../tests/fixtures/valid-v7.json")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut db = Store::open(&dir.path().join("library.sqlite3")).unwrap();
    let before = db
        .save(None, "existing **source**\r\n", "compose", 1, None)
        .unwrap();
    for case in [
        "format",
        "version",
        "kind",
        "cycle",
        "dangling",
        "parentNote",
        "rank",
        "duplicateCase",
        "restoreMissing",
        "restoreIndex",
        "liveRestore",
        "undoLive",
        "undoDuplicate",
        "undoCase",
        "draftCase",
        "unknownItem",
        "unknownLibrary",
        "missingColor",
        "invalidDone",
        "negativeRevision",
    ] {
        let mut v = valid.clone();
        let first = v["library"]["items"][0]["id"].as_str().unwrap().to_owned();
        let second = v["library"]["items"][1]["id"].as_str().unwrap().to_owned();
        match case {
            "format" => v["format"] = "unrecognized-alpha".into(),
            "version" => v["version"] = 8.into(),
            "kind" => v["library"]["items"][0]["kind"] = "branch".into(),
            "cycle" => v["library"]["items"][0]["parentId"] = first.clone().into(),
            "dangling" => {
                v["library"]["items"][1]["parentId"] = "99999999-9999-4999-8999-999999999999".into()
            }
            "parentNote" => v["library"]["items"][0]["parentId"] = second.clone().into(),
            "rank" => v["library"]["items"][4]["position"] = 0.into(),
            "duplicateCase" => {
                let mut x = v["library"]["items"][0].clone();
                x["id"] = first.to_uppercase().into();
                v["library"]["items"].as_array_mut().unwrap().push(x);
            }
            "restoreMissing" => {
                v["library"]["items"][2]["restoreParentId"] =
                    "99999999-9999-4999-8999-999999999999".into()
            }
            "restoreIndex" => {
                v["library"]["items"][2]["restoreParentId"] = first.into();
                v["library"]["items"][2]["restoreIndex"] = serde_json::Value::Null;
            }
            "liveRestore" => v["library"]["items"][0]["restoreIndex"] = 0.into(),
            "undoLive" => v["library"]["undoDeleteIds"] = serde_json::json!([first]),
            "undoDuplicate" => {
                let x = v["library"]["undoDeleteIds"][0].clone();
                v["library"]["undoDeleteIds"]
                    .as_array_mut()
                    .unwrap()
                    .push(x);
            }
            "undoCase" => {
                v["library"]["undoDeleteIds"] =
                    serde_json::json!(["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"])
            }
            "draftCase" => {
                v["library"]["drafts"][0]["key"] = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA".into()
            }
            "unknownItem" => v["library"]["items"][0]["unknown"] = true.into(),
            "unknownLibrary" => v["library"]["unknown"] = true.into(),
            "missingColor" => {
                v["library"]["items"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("color");
            }
            "invalidDone" => v["library"]["items"][0]["done"] = 0.into(),
            "negativeRevision" => v["library"]["drafts"][0]["revision"] = (-1).into(),
            _ => unreachable!(),
        }
        assert!(
            backup::validate(&serde_json::to_vec(&v).unwrap()).is_err(),
            "accepted {case}"
        );
        // Typed invalid graphs must also be refused by the actual replacement transaction.
        if let Ok(invalid) = serde_json::from_value::<WorkspaceSnapshot>(v["library"].clone()) {
            if case != "format"
                && case != "version"
                && case != "unknownLibrary"
                && case != "unknownItem"
            {
                assert!(db.replace(&invalid).is_err(), "replaced {case}");
            }
        }
        assert_eq!(
            db.load().unwrap(),
            before,
            "changed prior library for {case}"
        );
    }
}

#[test]
fn repeated_envelope_fields_use_the_last_value_like_javascript() {
    let bytes=br#"{"format":"discarded","format":"scratchtree-alpha","version":0,"version":7,"exportedAt":"2026-11-13T00:00:00.000Z","library":{"items":[],"drafts":[],"undoDeleteIds":[]}}"#;
    let checked = backup::validate(bytes).unwrap();
    assert_eq!(checked.format, "scratchtree-alpha");
    assert_eq!(checked.version, 7);
    assert_eq!(checked.library, WorkspaceSnapshot::default());
    let invalid_last=br#"{"format":"scratchtree-alpha","format":"discarded","version":7,"exportedAt":"2026-11-13T00:00:00.000Z","library":{"items":[],"drafts":[],"undoDeleteIds":[]}}"#;
    assert!(backup::validate(invalid_last).is_err());
}
#[test]
fn repeated_nested_fields_use_the_last_value_before_strict_validation() {
    let bytes=br#"{"format":"scratchtree-alpha","version":7,"exportedAt":"2026-11-13T00:00:00.000Z","library":{"items":[{"id":"11111111-1111-4111-8111-111111111111","parentId":null,"kind":"note","kind":"tree","markdown":"discarded","markdown":"**kept**\r\nline\n","done":false,"done":true,"color":null,"position":0,"createdAt":1,"updatedAt":2,"deletedAt":null,"restoreParentId":null,"restoreIndex":null}],"drafts":[],"undoDeleteIds":[]}}"#;
    let checked = backup::validate(bytes).unwrap();
    assert_eq!(checked.library.items[0].kind, Kind::Tree);
    assert_eq!(checked.library.items[0].markdown, "**kept**\r\nline\n");
    assert!(checked.library.items[0].done);
    let invalid_last = std::str::from_utf8(bytes)
        .unwrap()
        .replace("\"done\":false,\"done\":true", "\"done\":true,\"done\":0");
    assert!(backup::validate(invalid_last.as_bytes()).is_err());
}
