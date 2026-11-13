use serde::{Deserialize, Serialize};
pub const MAX_SOURCE: usize = 1024 * 1024;
pub const MAX_ENVELOPE: usize = 10 * 1024 * 1024;
pub const MAX_SAFE: i64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub key: String,
    pub markdown: String,
    pub revision: i64,
    pub updated_at: i64,
}
pub fn compose_key(owner_id: Option<&str>) -> String {
    owner_id.map_or_else(|| "compose".into(), |id| format!("compose:{id}"))
}
pub fn ecma_trim(source: &str) -> &str {
    source.trim_matches(|c:char| matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Note,
    Tree,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Live,
    Trash,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ColorToken {
    Red,
    Orange,
    Yellow,
    Green,
    Teal,
    Blue,
    Purple,
    Pink,
    Gray,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    pub id: String,
    #[serde(deserialize_with = "required_nullable")]
    pub parent_id: Option<String>,
    pub kind: Kind,
    pub markdown: String,
    pub done: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub color: Option<ColorToken>,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(deserialize_with = "required_nullable")]
    pub deleted_at: Option<i64>,
    #[serde(deserialize_with = "required_nullable")]
    pub restore_parent_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub restore_index: Option<i64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSnapshot {
    pub items: Vec<Item>,
    pub drafts: Vec<Draft>,
    pub undo_delete_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Location {
    pub scope: Scope,
    #[serde(deserialize_with = "required_nullable")]
    pub item_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftAck {
    pub key: String,
    pub revision: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureItem {
    pub id: String,
    pub location: Location,
    pub markdown: String,
    pub draft: DraftAck,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateChildTree {
    pub id: String,
    pub parent: Location,
    pub leave: Option<Location>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReorderItem {
    pub id: String,
    pub group: Location,
    pub to_index: i64,
}
impl Location {
    pub fn compose_key(&self) -> String {
        self.item_id.as_ref().map_or_else(
            || {
                if self.scope == Scope::Trash {
                    "compose:trash".into()
                } else {
                    "compose".into()
                }
            },
            |id| format!("compose:{id}"),
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeItem {
    pub id: String,
    pub location: Location,
    pub expected_subtree_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeResult {
    pub workspace: WorkspaceSnapshot,
    pub removed_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransitionLocation {
    pub from: Location,
    pub to: Location,
    pub promote_destination: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveItems {
    pub proof: Option<StructuralProof>,
    pub deleted_at: Option<i64>,
    pub ids: Vec<String>,
    pub from: Location,
    pub to: Location,
    pub before_from: Vec<String>,
    pub before_to: Vec<String>,
    pub after_from: Vec<String>,
    pub after_to: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupV7 {
    pub format: String,
    pub version: i64,
    pub exported_at: String,
    pub library: WorkspaceSnapshot,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructuralItem {
    pub id: String,
    #[serde(deserialize_with = "required_nullable")]
    pub parent_id: Option<String>,
    pub kind: Kind,
    pub position: i64,
    #[serde(deserialize_with = "required_nullable")]
    pub deleted_at: Option<i64>,
    #[serde(deserialize_with = "required_nullable")]
    pub restore_parent_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub restore_index: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructuralProof {
    pub before: Vec<StructuralItem>,
    pub after: Vec<StructuralItem>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoDeleteRequest {
    pub ids: Vec<String>,
    pub proof: StructuralProof,
}
