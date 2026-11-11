use serde::{Deserialize, Serialize};
pub const MAX_SOURCE: usize = 1024 * 1024;
pub const MAX_ENVELOPE: usize = 10 * 1024 * 1024;
pub const MAX_SAFE: i64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Note {
    pub done: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub stash_id: Option<String>,
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
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stash {
    pub id: String,
    pub name: String,
    #[serde(deserialize_with = "required_nullable")]
    pub parent_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSnapshot {
    pub stashes: Vec<Stash>,
    pub notes: Vec<Note>,
    pub drafts: Vec<Draft>,
    #[serde(deserialize_with = "required_nullable")]
    pub undo_delete_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupV3 {
    pub format: String,
    pub version: i64,
    pub exported_at: String,
    pub workspace: WorkspaceSnapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyNote {
    pub id: String,
    pub markdown: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(deserialize_with = "required_nullable")]
    pub deleted_at: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyWorkspace {
    pub notes: Vec<LegacyNote>,
    pub drafts: Vec<Draft>,
    #[serde(deserialize_with = "required_nullable")]
    pub undo_delete_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupV1 {
    pub format: String,
    pub version: i64,
    pub exported_at: String,
    pub workspace: LegacyWorkspace,
}
// Frozen version-2 wire fields; current Note must never be used here.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V2Note {
    #[serde(deserialize_with = "required_nullable")]
    pub stash_id: Option<String>,
    pub id: String,
    pub markdown: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(deserialize_with = "required_nullable")]
    pub deleted_at: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V2Workspace {
    pub stashes: Vec<Stash>,
    pub notes: Vec<V2Note>,
    pub drafts: Vec<Draft>,
    #[serde(deserialize_with = "required_nullable")]
    pub undo_delete_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupV2 {
    pub format: String,
    pub version: i64,
    pub exported_at: String,
    pub workspace: V2Workspace,
}
impl From<BackupV2> for BackupV3 {
    fn from(b: BackupV2) -> Self {
        Self {
            format: b.format,
            version: 3,
            exported_at: b.exported_at,
            workspace: WorkspaceSnapshot {
                stashes: b.workspace.stashes,
                drafts: b.workspace.drafts,
                undo_delete_id: b.workspace.undo_delete_id,
                notes: b
                    .workspace
                    .notes
                    .into_iter()
                    .map(|n| Note {
                        done: false,
                        id: n.id,
                        stash_id: n.stash_id,
                        markdown: n.markdown,
                        created_at: n.created_at,
                        updated_at: n.updated_at,
                        deleted_at: n.deleted_at,
                    })
                    .collect(),
            },
        }
    }
}
impl From<BackupV1> for BackupV3 {
    fn from(b: BackupV1) -> Self {
        Self {
            format: b.format,
            version: 3,
            exported_at: b.exported_at,
            workspace: WorkspaceSnapshot {
                stashes: Vec::new(),
                drafts: b.workspace.drafts,
                undo_delete_id: b.workspace.undo_delete_id,
                notes: b
                    .workspace
                    .notes
                    .into_iter()
                    .map(|n| Note {
                        done: false,
                        id: n.id,
                        stash_id: None,
                        markdown: n.markdown,
                        created_at: n.created_at,
                        updated_at: n.updated_at,
                        deleted_at: n.deleted_at,
                    })
                    .collect(),
            },
        }
    }
}
pub fn compose_key(stash_id: Option<&str>) -> String {
    stash_id.map_or_else(|| "compose".into(), |id| format!("compose:{id}"))
}
pub fn compose_owner(key: &str) -> Option<Option<&str>> {
    if key == "compose" {
        Some(None)
    } else {
        key.strip_prefix("compose:").map(Some)
    }
}
pub fn stash_name(name: &str) -> Result<String> {
    // ECMAScript trim whitespace keeps command validation identical to the frontend.
    let trimmed=name.trim_matches(|c:char| matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'));
    if trimmed.is_empty() || trimmed.chars().count() > 200 {
        return Err(error(
            "invalid_name",
            "Use a stash name with 1 to 200 characters.",
        ));
    }
    Ok(trimmed.into())
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
