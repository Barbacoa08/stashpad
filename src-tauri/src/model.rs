use serde::{Deserialize, Serialize};
pub const MAX_SOURCE: usize = 1024 * 1024;
pub const MAX_ENVELOPE: usize = 10 * 1024 * 1024;
pub const MAX_SAFE: i64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Note {
    pub id: String,
    pub markdown: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(deserialize_with = "required_nullable")]
    pub deleted_at: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub key: String,
    pub markdown: String,
    pub revision: i64,
    pub updated_at: i64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSnapshot {
    pub notes: Vec<Note>,
    pub drafts: Vec<Draft>,
    #[serde(deserialize_with = "required_nullable")]
    pub undo_delete_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupV1 {
    pub format: String,
    pub version: i64,
    pub exported_at: String,
    pub workspace: WorkspaceSnapshot,
}
#[derive(Clone, Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, AppError>;
pub fn error(code: &str, message: &str) -> AppError {
    AppError {
        code: code.into(),
        message: message.into(),
    }
}
pub fn storage_error(_: impl std::fmt::Display) -> AppError {
    error(
        "storage_error",
        "Local storage could not complete the operation. Your prior workspace is retained; retry.",
    )
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(MAX_SAFE as u128) as i64
}

fn required_nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
