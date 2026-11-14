use scratchtree_lib::{files, model::MAX_ENVELOPE};
use std::{fs, path::Path};

fn entries(path: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn text_roundtrip_preserves_unicode_crlf_and_unparsed_text() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("backup.json");
    let source = "not JSON: α🦀 **source**\r\nline\n\r\n\0";
    files::write_text(&path, source).unwrap();
    assert_eq!(fs::read(&path).unwrap(), source.as_bytes());
    assert_eq!(files::read_text(&path).unwrap(), source);
}

#[test]
fn invalid_utf8_is_rejected_without_lossy_conversion() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("invalid.json");
    fs::write(&path, [b'a', 0xf0, 0x28, 0x8c, 0x28]).unwrap();
    assert!(files::read_text(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), [b'a', 0xf0, 0x28, 0x8c, 0x28]);
}

#[test]
fn text_capacity_uses_utf8_bytes_and_preserves_destination_on_rejection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("backup.json");
    let exact = "🦀".repeat(MAX_ENVELOPE / 4);
    files::write_text(&path, &exact).unwrap();
    assert_eq!(files::read_text(&path).unwrap(), exact);
    let oversized = format!("{exact}x");
    assert!(files::write_text(&path, &oversized).is_err());
    assert_eq!(fs::read(&path).unwrap(), exact.as_bytes());
    assert_eq!(entries(dir.path()), ["backup.json"]);
    fs::write(&path, oversized.as_bytes()).unwrap();
    assert!(files::read_text(&path).is_err());
    assert_eq!(
        fs::metadata(&path).unwrap().len(),
        (MAX_ENVELOPE + 1) as u64
    );
}

#[test]
fn replacing_an_existing_destination_leaves_only_the_complete_new_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("backup.json");
    fs::write(&path, "previous longer source").unwrap();
    files::write_text(&path, "new\r\n🦀").unwrap();
    assert_eq!(fs::read(&path).unwrap(), "new\r\n🦀".as_bytes());
    assert_eq!(entries(dir.path()), ["backup.json"]);
}

#[test]
fn failed_temp_creation_preserves_existing_files() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("backup.json");
    fs::write(&file, "previous").unwrap();
    assert!(files::write_text(&file.join("impossible.json"), "next").is_err());
    assert_eq!(fs::read(&file).unwrap(), b"previous");
    assert_eq!(entries(dir.path()), ["backup.json"]);
}

#[test]
fn failed_rename_preserves_the_destination_and_removes_temporary_file() {
    let dir = tempfile::tempdir().unwrap();
    let occupied = dir.path().join("backup.json");
    fs::create_dir(&occupied).unwrap();
    fs::write(occupied.join("existing"), "previous").unwrap();
    assert!(files::write_text(&occupied, "next").is_err());
    assert_eq!(fs::read(occupied.join("existing")).unwrap(), b"previous");
    assert_eq!(entries(dir.path()), ["backup.json"]);
    assert_eq!(entries(&occupied), ["existing"]);
}

#[test]
fn safety_files_create_folder_use_unique_names_and_retain_previous_backup() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("backups");
    let first = files::safety_text(&folder, "first\r\n🦀").unwrap();
    let second = files::safety_text(&folder, "second\nα").unwrap();
    assert_ne!(first, second);
    for path in [&first, &second] {
        assert_eq!(path.parent(), Some(folder.as_path()));
        let name = path.file_name().unwrap().to_str().unwrap();
        let id = name
            .strip_prefix("safety-")
            .unwrap()
            .strip_suffix(".json")
            .unwrap();
        assert!(uuid::Uuid::parse_str(id).is_ok());
    }
    assert_eq!(fs::read(&first).unwrap(), "first\r\n🦀".as_bytes());
    assert_eq!(fs::read(&second).unwrap(), "second\nα".as_bytes());
    assert_eq!(entries(&folder).len(), 2);
}

#[test]
fn oversized_safety_text_fails_before_creating_folder_or_writing() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("backups");
    let oversized = "x".repeat(MAX_ENVELOPE + 1);
    assert!(files::safety_text(&folder, &oversized).is_err());
    assert!(!folder.exists());
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("previous.json"), "previous").unwrap();
    assert!(files::safety_text(&folder, &oversized).is_err());
    assert_eq!(entries(&folder), ["previous.json"]);
    assert_eq!(fs::read(folder.join("previous.json")).unwrap(), b"previous");
}
