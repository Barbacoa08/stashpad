use scratchtree_lib::{
    files,
    model::MAX_ENVELOPE,
    recovery::{RecoveryExports, MAX_CHUNK},
};
use std::fs;

#[test]
fn large_recovery_is_atomic_and_does_not_raise_normal_backup_limits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recovery.json");
    fs::write(&path, "prior export").unwrap();
    let writer = RecoveryExports::default();
    let id = writer.begin(path.clone()).unwrap();
    let chunk = "x".repeat(MAX_CHUNK);
    let mut expected = Vec::new();
    for index in 0..11 {
        writer.append(&id, index, &chunk).unwrap();
        expected.extend_from_slice(chunk.as_bytes());
        assert_eq!(fs::read(&path).unwrap(), b"prior export");
    }
    let unicode = "α🦀\r\n\\ud800";
    writer.append(&id, 11, unicode).unwrap();
    expected.extend_from_slice(unicode.as_bytes());
    assert_eq!(writer.finish(&id).unwrap(), path);
    assert!(expected.len() > MAX_ENVELOPE);
    assert_eq!(fs::read(&path).unwrap(), expected);
    assert!(files::read_text(&path).is_err());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn duplicate_chunk_is_neutral_and_out_of_order_or_conflicting_chunk_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recovery.json");
    let writer = RecoveryExports::default();
    let id = writer.begin(path.clone()).unwrap();
    writer.append(&id, 0, "α").unwrap();
    writer.append(&id, 0, "α").unwrap();
    assert!(writer.append(&id, 0, "different").is_err());
    assert!(writer.append(&id, 2, "late").is_err());
    writer.append(&id, 1, "🦀\r\n").unwrap();
    writer.finish(&id).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "α🦀\r\n");
}

#[test]
fn invalid_session_and_oversized_chunk_do_not_consume_or_replace_the_current_export() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recovery.json");
    fs::write(&path, "prior").unwrap();
    let writer = RecoveryExports::default();
    let id = writer.begin(path.clone()).unwrap();
    assert!(writer.append("not the session", 0, "wrong").is_err());
    assert!(writer.finish("not the session").is_err());
    assert!(writer.abort("not the session").is_err());
    assert!(writer.append(&id, 0, &"x".repeat(MAX_CHUNK + 1)).is_err());
    writer.append(&id, 0, "valid").unwrap();
    writer.abort(&id).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"prior");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn concurrent_begin_and_stale_abort_never_delete_the_newer_export() {
    let dir = tempfile::tempdir().unwrap();
    let writer = RecoveryExports::default();
    let first = writer.begin(dir.path().join("first.json")).unwrap();
    assert!(writer.begin(dir.path().join("second.json")).is_err());
    writer.abort(&first).unwrap();
    let second = writer.begin(dir.path().join("second.json")).unwrap();
    assert!(writer.abort(&first).is_err());
    writer.append(&second, 0, "second").unwrap();
    writer.finish(&second).unwrap();
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    assert_eq!(
        fs::read_to_string(dir.path().join("second.json")).unwrap(),
        "second"
    );
}

#[test]
fn failed_publish_cleans_only_its_temporary_file_and_allows_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("existing-directory");
    fs::create_dir(&path).unwrap();
    fs::write(path.join("keep"), "retained").unwrap();
    let writer = RecoveryExports::default();
    let id = writer.begin(path.clone()).unwrap();
    writer.append(&id, 0, "next").unwrap();
    assert!(writer.finish(&id).is_err());
    assert_eq!(fs::read_to_string(path.join("keep")).unwrap(), "retained");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    let retry = writer.begin(dir.path().join("valid.json")).unwrap();
    writer.append(&retry, 0, "retry").unwrap();
    writer.finish(&retry).unwrap();
}

#[test]
fn dropping_an_unfinished_writer_removes_only_its_owned_temporary_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recovery.json");
    fs::write(&path, "prior").unwrap();
    {
        let writer = RecoveryExports::default();
        let id = writer.begin(path.clone()).unwrap();
        writer.append(&id, 0, "unfinished").unwrap();
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), "prior");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}
