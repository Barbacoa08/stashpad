use serde::{Deserialize, Serialize};
pub const MAX_SOURCE: usize = 1024 * 1024;
pub const MAX_ENVELOPE: usize = 10 * 1024 * 1024;
pub const MAX_SAFE: i64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3Note {
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
pub struct LegacyStash {
    pub id: String,
    pub name: String,
    #[serde(deserialize_with = "required_nullable")]
    pub parent_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3Workspace {
    pub stashes: Vec<LegacyStash>,
    pub notes: Vec<V3Note>,
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
    pub workspace: V3Workspace,
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
    pub stashes: Vec<LegacyStash>,
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
            workspace: V3Workspace {
                stashes: b.workspace.stashes,
                drafts: b.workspace.drafts,
                undo_delete_id: b.workspace.undo_delete_id,
                notes: b
                    .workspace
                    .notes
                    .into_iter()
                    .map(|n| V3Note {
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
            workspace: V3Workspace {
                stashes: Vec::new(),
                drafts: b.workspace.drafts,
                undo_delete_id: b.workspace.undo_delete_id,
                notes: b
                    .workspace
                    .notes
                    .into_iter()
                    .map(|n| V3Note {
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
pub fn ecma_trim(source: &str) -> &str {
    source.trim_matches(|c:char| matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub fn stash_name(name: &str) -> Result<String> {
    // ECMAScript trim whitespace keeps command validation identical to the frontend.
    let trimmed = ecma_trim(name);
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Note,
    Stash,
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
// Version-4 enums and fields are frozen independently of current Item.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum V4Kind {
    Note,
    Stash,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum V4ColorToken {
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
impl From<V4Kind> for Kind {
    fn from(x: V4Kind) -> Self {
        match x {
            V4Kind::Note => Self::Note,
            V4Kind::Stash => Self::Stash,
        }
    }
}
impl From<V4ColorToken> for ColorToken {
    fn from(x: V4ColorToken) -> Self {
        match x {
            V4ColorToken::Red => Self::Red,
            V4ColorToken::Orange => Self::Orange,
            V4ColorToken::Yellow => Self::Yellow,
            V4ColorToken::Green => Self::Green,
            V4ColorToken::Teal => Self::Teal,
            V4ColorToken::Blue => Self::Blue,
            V4ColorToken::Purple => Self::Purple,
            V4ColorToken::Pink => Self::Pink,
            V4ColorToken::Gray => Self::Gray,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V4Item {
    pub id: String,
    #[serde(deserialize_with = "required_nullable")]
    pub parent_id: Option<String>,
    pub kind: V4Kind,
    pub markdown: String,
    pub done: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub color: Option<V4ColorToken>,
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
pub struct V4Workspace {
    pub items: Vec<V4Item>,
    pub drafts: Vec<Draft>,
    #[serde(deserialize_with = "required_nullable")]
    pub undo_delete_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupV4 {
    pub format: String,
    pub version: i64,
    pub exported_at: String,
    pub workspace: V4Workspace,
}
impl From<V4Workspace> for WorkspaceSnapshot {
    fn from(s: V4Workspace) -> Self {
        Self {
            items: s
                .items
                .into_iter()
                .map(|x| Item {
                    id: x.id,
                    parent_id: x.parent_id,
                    kind: x.kind.into(),
                    markdown: x.markdown,
                    done: x.done,
                    color: x.color.map(Into::into),
                    position: x.position,
                    created_at: x.created_at,
                    updated_at: x.updated_at,
                    deleted_at: x.deleted_at,
                    restore_parent_id: x.restore_parent_id,
                    restore_index: x.restore_index,
                })
                .collect(),
            drafts: s.drafts,
            undo_delete_id: s.undo_delete_id,
        }
    }
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
    #[serde(deserialize_with = "required_nullable")]
    pub undo_delete_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupV5 {
    pub format: String,
    pub version: i64,
    pub exported_at: String,
    pub workspace: WorkspaceSnapshot,
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
pub struct CreateChildStash {
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
    pub ids: Vec<String>,
    pub from: Location,
    pub to: Location,
    pub before_from: Vec<String>,
    pub before_to: Vec<String>,
    pub after_from: Vec<String>,
    pub after_to: Vec<String>,
}
