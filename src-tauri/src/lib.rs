pub mod backup;
mod external;
pub mod files;
pub mod model;
pub mod recovery;
pub mod store;
mod window_geometry;
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
                .ok_or_else(|| error("storage_error", "Library folder unavailable."))?;
            std::fs::create_dir_all(parent).map_err(storage_error)?;
            inner.store = Some(store::Store::open(&self.path)?);
        }
        f(&mut inner)
    }
}
fn fail_operation(operation: &str) -> Result<()> {
    #[cfg(debug_assertions)]
    {
        if let Ok(path) = std::env::var("SCRATCHTREE_ALPHA_TEST_FAILURE_FILE") {
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
async fn mutate<T: Send + 'static>(
    state: State<'_, NativeState>,
    f: impl FnOnce(&mut store::Store) -> Result<T> + Send + 'static,
) -> Result<T> {
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
async fn item_save_source(
    state: State<'_, NativeState>,
    id: String,
    markdown: String,
    draft: DraftAck,
) -> Result<WorkspaceSnapshot> {
    fail_operation("save")?;
    mutate(state, move |s| s.save_source(&id, &markdown, &draft)).await
}
#[tauri::command]
async fn item_capture(
    state: State<'_, NativeState>,
    request: CaptureItem,
) -> Result<WorkspaceSnapshot> {
    fail_operation("save")?;
    mutate(state, move |s| s.capture(&request)).await
}
#[tauri::command]
async fn item_create_child_tree(
    state: State<'_, NativeState>,
    request: CreateChildTree,
) -> Result<WorkspaceSnapshot> {
    mutate(state, move |s| s.create_child_tree(&request)).await
}
#[tauri::command]
async fn item_promote(state: State<'_, NativeState>, id: String) -> Result<WorkspaceSnapshot> {
    mutate(state, move |s| s.promote(&id)).await
}
#[tauri::command]
async fn item_set_done(
    state: State<'_, NativeState>,
    id: String,
    done: bool,
) -> Result<WorkspaceSnapshot> {
    fail_operation("completion")?;
    mutate(state, move |s| s.set_done(&id, done)).await
}
#[tauri::command]
async fn item_set_color(
    state: State<'_, NativeState>,
    id: String,
    color: Option<ColorToken>,
) -> Result<WorkspaceSnapshot> {
    mutate(state, move |s| s.set_color(&id, color)).await
}
#[tauri::command]
async fn item_reorder(
    state: State<'_, NativeState>,
    request: ReorderItem,
) -> Result<WorkspaceSnapshot> {
    mutate(state, move |s| s.reorder(&request)).await
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
async fn item_delete(
    state: State<'_, NativeState>,
    id: String,
    leave: Option<Location>,
) -> Result<WorkspaceSnapshot> {
    mutate(state, move |s| s.delete_leaving(&id, leave.as_ref())).await
}
#[tauri::command]
async fn item_undo_delete(
    state: State<'_, NativeState>,
    request: UndoDeleteRequest,
) -> Result<WorkspaceSnapshot> {
    mutate(state, move |s| s.undo(&request)).await
}
#[tauri::command]
async fn item_restore(state: State<'_, NativeState>, id: String) -> Result<WorkspaceSnapshot> {
    mutate(state, move |s| s.restore(&id)).await
}
#[tauri::command]
async fn item_purge(state: State<'_, NativeState>, request: PurgeItem) -> Result<PurgeResult> {
    fail_operation("purge")?;
    mutate(state, move |s| s.purge(&request)).await
}
#[tauri::command]
async fn workspace_transition(
    state: State<'_, NativeState>,
    request: TransitionLocation,
) -> Result<WorkspaceSnapshot> {
    fail_operation("navigate")?;
    mutate(state, move |s| s.transition(&request)).await
}
#[tauri::command]
async fn items_move(
    state: State<'_, NativeState>,
    request: MoveItems,
) -> Result<WorkspaceSnapshot> {
    fail_operation("move")?;
    mutate(state, move |s| s.move_items(&request)).await
}
#[derive(serde::Serialize)]
struct Preview {
    token: String,
    notes: usize,
    drafts: usize,
    trees: usize,
    warning: String,
}
impl Preview {
    fn new(token: String, library: &WorkspaceSnapshot) -> Self {
        Self {
            token,
            notes: library.items.len(),
            drafts: library.drafts.len(),
            trees: library
                .items
                .iter()
                .filter(|x| x.kind == Kind::Tree)
                .count(),
            warning:
                "Replace the entire local library, including Trash and drafts. A safety backup will be written first."
                    .into(),
        }
    }
}

#[cfg(test)]
mod preview_tests {
    use super::*;
    #[test]
    fn all_source_bearing_notes_are_counted_once_including_trash() {
        let backup =
            backup::validate(include_bytes!("../../tests/fixtures/valid-v7.json")).unwrap();
        let preview = Preview::new("captured-token".into(), &backup.library);
        assert_eq!(preview.notes, 5);
        assert_eq!(preview.trees, 2);
        assert_eq!(preview.drafts, 3);
        assert_eq!(preview.token, "captured-token");
    }
}

#[tauri::command]
async fn backup_read_text(app: tauri::AppHandle) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .dialog()
            .file()
            .add_filter("Scratchtree backup", &["json"])
            .blocking_pick_file();
        let Some(path) = path else { return Ok(None) };
        let path = path.into_path().map_err(storage_error)?;
        files::read_text(&path).map(Some)
    })
    .await
    .map_err(storage_error)?
}

#[tauri::command]
async fn backup_write_text(app: tauri::AppHandle, text: String) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .dialog()
            .file()
            .add_filter("Scratchtree backup", &["json"])
            .set_file_name("scratchtree-backup.json")
            .blocking_save_file();
        let Some(path) = path else { return Ok(None) };
        let path = path.into_path().map_err(storage_error)?;
        files::write_text(&path, &text)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(storage_error)?
}

#[tauri::command]
async fn backup_safety_text(app: tauri::AppHandle, text: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = app
            .path()
            .app_data_dir()
            .map_err(storage_error)?
            .join("backups");
        files::safety_text(&folder, &text)?;
        Ok(())
    })
    .await
    .map_err(storage_error)?
}

#[tauri::command]
async fn recovery_begin(
    app: tauri::AppHandle,
    state: State<'_, Arc<recovery::RecoveryExports>>,
) -> Result<Option<String>> {
    let exports = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .dialog()
            .file()
            .add_filter("Scratchtree recovery archive", &["json"])
            .set_file_name("scratchtree-recovery.json")
            .blocking_save_file();
        let Some(path) = path else { return Ok(None) };
        exports
            .begin(path.into_path().map_err(storage_error)?)
            .map(Some)
    })
    .await
    .map_err(storage_error)?
}

#[tauri::command]
async fn recovery_append(
    state: State<'_, Arc<recovery::RecoveryExports>>,
    id: String,
    index: u64,
    chunk: String,
) -> Result<()> {
    let exports = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || exports.append(&id, index, &chunk))
        .await
        .map_err(storage_error)?
}

#[tauri::command]
async fn recovery_finish(
    state: State<'_, Arc<recovery::RecoveryExports>>,
    id: String,
) -> Result<String> {
    let exports = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        exports
            .finish(&id)
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(storage_error)?
}

#[tauri::command]
async fn recovery_abort(
    state: State<'_, Arc<recovery::RecoveryExports>>,
    id: String,
) -> Result<()> {
    let exports = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || exports.abort(&id))
        .await
        .map_err(storage_error)?
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
            .add_filter("Scratchtree backup", &["json"])
            .set_file_name("scratchtree-backup.json")
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
            .add_filter("Scratchtree backup", &["json"])
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
        let result = Preview::new(token.clone(), &b.library);
        inner.lock().map_err(storage_error)?.preview = Some((token, b.library));
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
            app.manage(window_geometry::GeometryState::new(
                app.path().app_config_dir().ok(),
            ));
            app.manage(Arc::new(recovery::RecoveryExports::default()));
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
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                window_geometry::restore(&webview.window());
            }
        })
        .on_window_event(window_geometry::event)
        .invoke_handler(tauri::generate_handler![
            workspace_load,
            draft_checkpoint,
            draft_discard,
            external_open_url,
            clipboard_write_text,
            item_save_source,
            item_capture,
            item_create_child_tree,
            item_promote,
            item_set_done,
            item_set_color,
            item_reorder,
            item_delete,
            item_purge,
            workspace_transition,
            items_move,
            item_restore,
            item_undo_delete,
            backup_read_text,
            backup_write_text,
            backup_safety_text,
            recovery_begin,
            recovery_append,
            recovery_finish,
            recovery_abort,
            backup_export,
            backup_preview_restore,
            backup_confirm_restore
        ])
        .build(tauri::generate_context!())
        .expect("Cannot start local library")
        .run(|app, event| {
            // Reuse the hidden webview: rebuilding it would lose session/editor state.
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                let _ = app.show();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                window_geometry::exiting(app);
            }
        });
}
