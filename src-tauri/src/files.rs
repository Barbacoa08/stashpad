use crate::model::{error, storage_error, Result, MAX_ENVELOPE};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

fn check_capacity(bytes: usize) -> Result<()> {
    if bytes > MAX_ENVELOPE {
        return Err(error("file_error", "Backup exceeds the 10 MiB file limit."));
    }
    Ok(())
}

pub fn read_text(path: &Path) -> Result<String> {
    let file = std::fs::File::open(path).map_err(storage_error)?;
    let mut bytes = Vec::new();
    file.take((MAX_ENVELOPE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(storage_error)?;
    check_capacity(bytes.len())?;
    String::from_utf8(bytes).map_err(|_| error("file_error", "Backup text must be valid UTF-8."))
}

pub fn write_text(path: &Path, text: &str) -> Result<()> {
    check_capacity(text.len())?;
    atomic_write(path, text.as_bytes())
}

pub fn safety_text(folder: &Path, text: &str) -> Result<PathBuf> {
    check_capacity(text.len())?;
    std::fs::create_dir_all(folder).map_err(storage_error)?;
    let path = folder.join(format!("safety-{}.json", uuid::Uuid::new_v4()));
    atomic_write_mode(&path, text.as_bytes(), WriteMode::Fresh)?;
    Ok(path)
}

enum WriteMode {
    Replace,
    Fresh,
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    atomic_write_mode(path, bytes, WriteMode::Replace)
}

fn atomic_write_mode(path: &Path, bytes: &[u8], mode: WriteMode) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error("file_error", "Choose a local destination folder."))?;
    let tmp = parent.join(format!(".scratchtree-{}.tmp", uuid::Uuid::new_v4()));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(storage_error)?;
    let result = (|| {
        f.write_all(bytes).map_err(storage_error)?;
        f.sync_all().map_err(storage_error)?;
        match mode {
            WriteMode::Replace => std::fs::rename(&tmp, path).map_err(storage_error)?,
            // Linking the complete temporary file publishes it without replacing
            // any existing safety file, even if the generated UUID collides.
            WriteMode::Fresh => std::fs::hard_link(&tmp, path).map_err(storage_error)?,
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_write_collision_preserves_previous_safety_and_removes_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("safety-existing.json");
        std::fs::write(&path, "previous").unwrap();
        assert!(atomic_write_mode(&path, b"next", WriteMode::Fresh).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"previous");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
