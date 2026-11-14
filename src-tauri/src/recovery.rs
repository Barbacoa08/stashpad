use crate::model::{error, storage_error, Result};
use std::{fs::File, io::Write, path::PathBuf, sync::Mutex};

pub const MAX_CHUNK: usize = 1024 * 1024;
struct PendingExport {
    id: String,
    path: PathBuf,
    temporary: PathBuf,
    file: Option<File>,
    next_index: u64,
    previous: Option<String>,
}
impl Drop for PendingExport {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.temporary);
    }
}
#[derive(Default)]
pub struct RecoveryExports {
    current: Mutex<Option<PendingExport>>,
}
fn inactive() -> crate::model::AppError {
    error("file_error", "The recovery export changed. Start it again.")
}
impl RecoveryExports {
    pub fn begin(&self, path: PathBuf) -> Result<String> {
        let mut current = self.current.lock().map_err(storage_error)?;
        if current.is_some() {
            return Err(error(
                "file_error",
                "Another recovery export is still running. If it was interrupted, choose Scratchtree → Quit, reopen the app, and export again.",
            ));
        }
        if path.file_name().is_none() {
            return Err(error("file_error", "Choose a destination file."));
        }
        let parent = path
            .parent()
            .ok_or_else(|| error("file_error", "Choose a local destination folder."))?;
        let id = uuid::Uuid::new_v4().to_string();
        let temporary = parent.join(format!(".scratchtree-recovery-{id}.tmp"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&temporary).map_err(storage_error)?;
        *current = Some(PendingExport {
            id: id.clone(),
            path,
            temporary,
            file: Some(file),
            next_index: 0,
            previous: None,
        });
        Ok(id)
    }
    pub fn append(&self, id: &str, index: u64, chunk: &str) -> Result<()> {
        if chunk.len() > MAX_CHUNK {
            return Err(error(
                "file_error",
                "The recovery export could not continue. Try exporting again.",
            ));
        }
        let mut current = self.current.lock().map_err(storage_error)?;
        let pending = current
            .as_mut()
            .filter(|pending| pending.id == id)
            .ok_or_else(inactive)?;
        if pending.next_index > 0
            && index == pending.next_index - 1
            && pending.previous.as_deref() == Some(chunk)
        {
            return Ok(());
        }
        if index != pending.next_index {
            return Err(inactive());
        }
        let next_index = pending.next_index.checked_add(1).ok_or_else(inactive)?;
        if let Err(cause) = pending
            .file
            .as_mut()
            .ok_or_else(inactive)?
            .write_all(chunk.as_bytes())
        {
            current.take();
            return Err(storage_error(cause));
        }
        pending.next_index = next_index;
        pending.previous = Some(chunk.to_owned());
        Ok(())
    }
    pub fn finish(&self, id: &str) -> Result<PathBuf> {
        let mut current = self.current.lock().map_err(storage_error)?;
        if current.as_ref().is_none_or(|pending| pending.id != id) {
            return Err(inactive());
        }
        let mut pending = current.take().ok_or_else(inactive)?;
        let file = pending.file.take().ok_or_else(inactive)?;
        file.sync_all().map_err(storage_error)?;
        drop(file);
        std::fs::rename(&pending.temporary, &pending.path).map_err(storage_error)?;
        Ok(pending.path.clone())
    }
    pub fn abort(&self, id: &str) -> Result<()> {
        let mut current = self.current.lock().map_err(storage_error)?;
        if current.as_ref().is_none_or(|pending| pending.id != id) {
            return Err(inactive());
        }
        current.take();
        Ok(())
    }
}
