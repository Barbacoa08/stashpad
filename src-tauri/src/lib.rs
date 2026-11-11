pub mod backup;
mod external;
pub mod model;
pub mod store;
use model::*;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
struct Inner {
    store: Option<store::Store>,
    preview: Option<(String, WorkspaceSnapshot)>,
}
struct NativeState {
    path: PathBuf,
    inner: Arc<Mutex<Inner>>,
}
impl NativeState {
    fn access<T>(&self, f: impl FnOnce(&mut Inner) -> Result<T>) -> Result<T> {
        let mut inner = self.inner.lock().map_err(storage_error)?;
        if inner.store.is_none() {
            let parent = self
                .path
                .parent()
                .ok_or_else(|| error("storage_error", "Workspace folder unavailable."))?;
            std::fs::create_dir_all(parent).map_err(storage_error)?;
            inner.store = Some(store::Store::open(&self.path)?);
        }
        f(&mut inner)
    }
}
fn fail_operation(operation: &str) -> Result<()> {
    #[cfg(debug_assertions)]
    {
        if let Ok(path) = std::env::var("STASHPAD_ALPHA_TEST_FAILURE_FILE") {
            if std::fs::read_to_string(path).is_ok_and(|value| value.trim() == operation) {
                return Err(error(
                    "synthetic_failure",
                    "Synthetic native failure. Saved data and input are retained; retry.",
                ));
            }
        }
    }
    let _ = operation;
    Ok(())
}
async fn mutate(
    state: State<'_, NativeState>,
    f: impl FnOnce(&mut store::Store) -> Result<WorkspaceSnapshot> + Send + 'static,
) -> Result<WorkspaceSnapshot> {
    let inner = state.inner.clone();
    let path = state.path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = NativeState { path, inner };
        state.access(|s| f(s.store.as_mut().expect("initialized store")))
    })
    .await
    .map_err(storage_error)?
}
#[tauri::command]
async fn workspace_load(state: State<'_, NativeState>) -> Result<WorkspaceSnapshot> {
    {
        fail_operation("load")?;
        mutate(state, |s| s.load()).await
    }
}
#[tauri::command]
async fn draft_checkpoint(
    state: State<'_, NativeState>,
    key: String,
    markdown: String,
    revision: i64,
) -> Result<WorkspaceSnapshot> {
    fail_operation("checkpoint")?;
    mutate(state, move |s| s.checkpoint(&key, &markdown, revision)).await
}
#[tauri::command]
async fn note_save(
    state: State<'_, NativeState>,
    id: Option<String>,
    markdown: String,
    draft_key: String,
    draft_revision: i64,
    stash_id: Option<String>,
) -> Result<WorkspaceSnapshot> {
    fail_operation("save")?;
    mutate(state, move |s| {
        s.save(
            id.as_deref(),
            &markdown,
            &draft_key,
            draft_revision,
            stash_id.as_deref(),
        )
    })
    .await
}
#[tauri::command]
async fn note_set_done(
    state: State<'_, NativeState>,
    id: String,
    done: bool,
) -> Result<WorkspaceSnapshot> {
    fail_operation("completion")?;
    mutate(state, move |s| s.set_done(&id, done)).await
}
#[tauri::command]
async fn stash_create(
    state: State<'_, NativeState>,
    name: String,
    parent_id: Option<String>,
) -> Result<WorkspaceSnapshot> {
    mutate(state, move |s| s.create_stash(&name, parent_id.as_deref())).await
}
#[tauri::command]
async fn stash_rename(
    state: State<'_, NativeState>,
    id: String,
    name: String,
) -> Result<WorkspaceSnapshot> {
    mutate(state, move |s| s.rename_stash(&id, &name)).await
}
#[tauri::command]
async fn draft_discard(state: State<'_, NativeState>, key: String) -> Result<WorkspaceSnapshot> {
    mutate(state, move |s| s.discard_draft(&key)).await
}
#[tauri::command]
fn external_open_url(app: tauri::AppHandle, url: String) -> Result<()> {
    external::validate_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(storage_error)
}
#[tauri::command]
fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<()> {
    app.clipboard().write_text(text).map_err(storage_error)
}
#[tauri::command]
async fn note_delete(state: State<'_, NativeState>, id: String) -> Result<WorkspaceSnapshot> {
    mutate(state, move |s| s.delete(&id)).await
}
#[tauri::command]
async fn note_undo_delete(state: State<'_, NativeState>) -> Result<WorkspaceSnapshot> {
    mutate(state, |s| s.undo()).await
}
#[derive(serde::Serialize)]
struct Preview {
    token: String,
    notes: usize,
    drafts: usize,
    stashes: usize,
    warning: String,
}
#[tauri::command]
async fn backup_export(
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<Option<String>> {
    let snapshot = {
        fail_operation("load")?;
        mutate(state, |s| s.load()).await
    }?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .dialog()
            .file()
            .add_filter("Stashpad backup", &["json"])
            .set_file_name("stashpad-backup.json")
            .blocking_save_file();
        let Some(path) = path else { return Ok(None) };
        let path = path.into_path().map_err(storage_error)?;
        backup::atomic_write(&path, &backup::encode(&snapshot)?)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(storage_error)?
}
#[tauri::command]
async fn backup_preview_restore(
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<Option<Preview>> {
    let inner = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .dialog()
            .file()
            .add_filter("Stashpad backup", &["json"])
            .blocking_pick_file();
        let Some(path) = path else { return Ok(None) };
        let path = path.into_path().map_err(storage_error)?;
        let file = std::fs::File::open(path).map_err(storage_error)?;
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take((MAX_ENVELOPE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(storage_error)?;
        let b = backup::validate(&bytes)?;
        let token = uuid::Uuid::new_v4().to_string();
        let result = Preview {
            token: token.clone(),
            notes: b.workspace.notes.len(),
            drafts: b.workspace.drafts.len(),
            stashes: b.workspace.stashes.len(),
            warning: "Replace all local notes, stashes, and drafts. A safety backup will be written first."
                .into(),
        };
        inner.lock().map_err(storage_error)?.preview = Some((token, b.workspace));
        Ok(Some(result))
    })
    .await
    .map_err(storage_error)?
}
#[tauri::command]
async fn backup_confirm_restore(
    state: State<'_, NativeState>,
    token: String,
    confirm: bool,
) -> Result<Option<WorkspaceSnapshot>> {
    let inner = state.inner.clone();
    let path = state.path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = NativeState { path, inner };
        state.access(|inner| {
            let (staged_token, snapshot) = inner
                .preview
                .as_ref()
                .ok_or_else(|| error("restore_expired", "Choose and preview the backup again."))?;
            if staged_token != &token {
                return Err(error(
                    "restore_expired",
                    "The restore preview has changed. Review it again.",
                ));
            }
            if !confirm {
                inner.preview = None;
                return Ok(None);
            }
            let folder = state
                .path
                .parent()
                .expect("app data parent")
                .join("backups");
            std::fs::create_dir_all(&folder).map_err(storage_error)?;
            let destination = folder.join(format!("safety-{}.json", uuid::Uuid::new_v4()));
            let result = inner
                .store
                .as_mut()
                .expect("initialized store")
                .restore_with_safety(snapshot, &destination, false)?;
            inner.preview = None;
            Ok(Some(result))
        })
    })
    .await
    .map_err(storage_error)?
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("notes.sqlite3");
            app.manage(NativeState {
                path,
                inner: Arc::new(Mutex::new(Inner {
                    store: None,
                    preview: None,
                })),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace_load,
            draft_checkpoint,
            draft_discard,
            external_open_url,
            clipboard_write_text,
            note_save,
            note_set_done,
            stash_create,
            stash_rename,
            note_delete,
            note_undo_delete,
            backup_export,
            backup_preview_restore,
            backup_confirm_restore
        ])
        .run(tauri::generate_context!())
        .expect("Cannot start local workspace");
}
