use crate::model::*;
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::Path,
};
fn invalid() -> AppError {
    error(
        "invalid_backup",
        "Invalid or unsupported backup. No workspace data were replaced.",
    )
}
fn uuid(s: &str) -> bool {
    s.len() == 36 && uuid::Uuid::parse_str(s).is_ok()
}
fn timestamp(s: &str) -> bool {
    // Fixed UTC millisecond form shared with JavaScript's Date.toISOString.
    if !s.is_ascii()
        || s.len() != 24
        || &s[4..5] != "-"
        || &s[7..8] != "-"
        || &s[10..11] != "T"
        || &s[13..14] != ":"
        || &s[16..17] != ":"
        || &s[19..20] != "."
        || &s[23..] != "Z"
    {
        return false;
    }
    let part = |a: usize, b: usize| s.get(a..b).and_then(|x| x.parse::<u32>().ok());
    let (Some(y), Some(m), Some(d), Some(h), Some(mi), Some(sec), Some(_ms)) = (
        part(0, 4),
        part(5, 7),
        part(8, 10),
        part(11, 13),
        part(14, 16),
        part(17, 19),
        part(20, 23),
    ) else {
        return false;
    };
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = match m {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    d >= 1 && d <= days && h < 24 && mi < 60 && sec < 60
}
pub fn iso_now() -> String {
    let ms = now();
    let seconds = ms / 1000;
    let days = seconds / 86400;
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds / 3600 % 24,
        seconds / 60 % 60,
        seconds % 60,
        ms % 1000
    )
}
pub fn validate_snapshot(s: &WorkspaceSnapshot) -> Result<()> {
    validate_version_snapshot(s, true)
}
pub fn validate_v4_snapshot(s: &WorkspaceSnapshot) -> Result<()> {
    let _: V4Workspace = serde_json::from_value(serde_json::to_value(s).map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    validate_version_snapshot(s, false)
}
fn validate_version_snapshot(s: &WorkspaceSnapshot, current: bool) -> Result<()> {
    if s.items.len() > 20000 || s.drafts.len() > 40002 {
        return Err(invalid());
    }
    let mut index = HashMap::new();
    let mut ids = HashSet::new();
    for x in &s.items {
        if !uuid(&x.id)
            || !ids.insert(x.id.to_lowercase())
            || x.markdown.len() > MAX_SOURCE
            || !(0..=MAX_SAFE).contains(&x.position)
            || !(0..=MAX_SAFE).contains(&x.created_at)
            || !(x.created_at..=MAX_SAFE).contains(&x.updated_at)
            || x.deleted_at.is_some_and(|t| !(0..=MAX_SAFE).contains(&t))
            || x.restore_index
                .is_some_and(|t| !(0..=MAX_SAFE).contains(&t))
        {
            return Err(invalid());
        }
        index.insert(x.id.as_str(), x);
    }
    let mut done = HashSet::new();
    for x in &s.items {
        let mut id = Some(x.id.as_str());
        let mut pending = HashSet::new();
        while let Some(key) = id {
            if done.contains(key) {
                break;
            }
            if !pending.insert(key) {
                return Err(invalid());
            }
            let current = index.get(key).ok_or_else(invalid)?;
            if let Some(parent) = current.parent_id.as_deref() {
                if index.get(parent).is_none_or(|p| p.kind != Kind::Stash) {
                    return Err(invalid());
                }
            }
            id = current.parent_id.as_deref();
        }
        done.extend(pending);
    }
    let mut scopes: HashMap<&str, bool> = HashMap::new();
    for x in &s.items {
        let mut current = Some(x.id.as_str());
        let mut pending = Vec::new();
        while let Some(id) = current {
            if scopes.contains_key(id) {
                break;
            }
            let node = index[id];
            pending.push(id);
            if node.deleted_at.is_some() {
                scopes.insert(id, true);
                break;
            }
            current = node.parent_id.as_deref();
        }
        let trash = current.is_some_and(|id| scopes.get(id).copied().unwrap_or(false));
        for id in pending {
            scopes.insert(id, trash);
        }
    }
    let mut ranks = HashSet::new();
    for x in &s.items {
        if x.deleted_at.is_some() {
            if x.parent_id
                .as_deref()
                .is_some_and(|parent| !current || !scopes[parent])
            {
                return Err(invalid());
            }
        } else if x.restore_parent_id.is_some() || x.restore_index.is_some() {
            return Err(invalid());
        }
        if let Some(parent) = x.restore_parent_id.as_deref() {
            if x.restore_index.is_none()
                || index
                    .get(parent)
                    .is_none_or(|p| !current && p.kind != Kind::Stash)
            {
                return Err(invalid());
            }
        }
        if !ranks.insert((
            x.parent_id.as_deref(),
            x.parent_id.is_none() && x.deleted_at.is_some(),
            x.position,
        )) {
            return Err(invalid());
        }
    }
    let mut keys = HashSet::new();
    for d in &s.drafts {
        let valid_key = if d.key == "compose" || d.key == "compose:trash" {
            true
        } else if let Some(id) = d.key.strip_prefix("compose:") {
            index
                .get(id)
                .is_some_and(|x| current || x.kind == Kind::Stash)
        } else {
            uuid(&d.key) && index.contains_key(d.key.as_str())
        };
        if !valid_key
            || !keys.insert(d.key.to_lowercase())
            || d.markdown.len() > MAX_SOURCE
            || !(0..=MAX_SAFE).contains(&d.revision)
            || !(0..=MAX_SAFE).contains(&d.updated_at)
        {
            return Err(invalid());
        }
    }
    if s.undo_delete_id.as_ref().is_some_and(|id| {
        index
            .get(id.as_str())
            .is_none_or(|x| x.deleted_at.is_none())
    }) {
        return Err(invalid());
    }
    Ok(())
}
pub fn convert_legacy(s: V3Workspace) -> WorkspaceSnapshot {
    let mut items: Vec<Item> = s
        .stashes
        .into_iter()
        .map(|x| Item {
            id: x.id,
            parent_id: x.parent_id,
            kind: Kind::Stash,
            markdown: x.name,
            done: false,
            color: None,
            position: 0,
            created_at: x.created_at,
            updated_at: x.updated_at,
            deleted_at: None,
            restore_parent_id: None,
            restore_index: None,
        })
        .collect();
    for x in s.notes {
        items.push(Item {
            id: x.id,
            parent_id: if x.deleted_at.is_some() {
                None
            } else {
                x.stash_id.clone()
            },
            kind: Kind::Note,
            markdown: x.markdown,
            done: x.done,
            color: None,
            position: 0,
            created_at: x.created_at,
            updated_at: x.updated_at,
            deleted_at: x.deleted_at,
            restore_parent_id: if x.deleted_at.is_some() {
                x.stash_id
            } else {
                None
            },
            restore_index: x.deleted_at.map(|_| 0),
        });
    }
    let mut ordered: Vec<usize> = (0..items.len()).collect();
    ordered.sort_by(|&a, &b| {
        items[a]
            .created_at
            .cmp(&items[b].created_at)
            .then_with(|| items[a].id.cmp(&items[b].id))
    });
    let mut groups: HashMap<(Option<String>, bool), i64> = HashMap::new();
    for &i in &ordered {
        let x = &mut items[i];
        let pos = groups
            .entry((x.parent_id.clone(), x.deleted_at.is_some()))
            .or_default();
        x.position = *pos;
        *pos += 1;
    }
    for &i in &ordered {
        if items[i].deleted_at.is_some() {
            let x = &items[i];
            let rank = items
                .iter()
                .filter(|y| {
                    y.deleted_at.is_none()
                        && y.parent_id == x.restore_parent_id
                        && (y.created_at < x.created_at
                            || (y.created_at == x.created_at && y.id < x.id))
                })
                .count() as i64;
            items[i].restore_index = Some(rank);
        }
    }
    WorkspaceSnapshot {
        items,
        drafts: s.drafts,
        undo_delete_id: s.undo_delete_id,
    }
}
pub fn encode(s: &WorkspaceSnapshot) -> Result<Vec<u8>> {
    validate_snapshot(s)?;
    let b = BackupV5 {
        format: "stashpad-alpha".into(),
        version: 5,
        exported_at: iso_now(),
        workspace: s.clone(),
    };
    let bytes = serde_json::to_vec(&b).map_err(storage_error)?;
    if bytes.len() > MAX_ENVELOPE {
        return Err(error(
            "capacity_exceeded",
            "The workspace exceeds the 10 MiB backup capacity. Input and saved data are retained.",
        ));
    }
    Ok(bytes)
}
pub fn validate(bytes: &[u8]) -> Result<BackupV5> {
    if bytes.len() > MAX_ENVELOPE {
        return Err(invalid());
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let b: BackupV5 = match value.get("version").and_then(|x| x.as_i64()) {
        Some(5) => serde_json::from_value(value).map_err(|_| invalid())?,
        Some(4) => {
            let old: BackupV4 = serde_json::from_value(value).map_err(|_| invalid())?;
            if old.format != "stashpad-alpha" || !timestamp(&old.exported_at) {
                return Err(invalid());
            }
            let workspace: WorkspaceSnapshot = old.workspace.into();
            validate_v4_snapshot(&workspace)?;
            BackupV5 {
                format: old.format,
                version: 5,
                exported_at: old.exported_at,
                workspace,
            }
        }
        _ => {
            let old = crate::legacy_backup::validate(bytes)?;
            BackupV5 {
                format: old.format,
                version: 5,
                exported_at: old.exported_at,
                workspace: convert_legacy(old.workspace),
            }
        }
    };
    if b.format != "stashpad-alpha" || b.version != 5 || !timestamp(&b.exported_at) {
        return Err(invalid());
    }
    validate_snapshot(&b.workspace)?;
    encode(&b.workspace).map_err(|_|error("invalid_backup","Converted backup exceeds the 10 MiB capacity. The original is retained; recover using a compatible app or verified smaller copy."))?;
    Ok(b)
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error("file_error", "Choose a local destination folder."))?;
    let tmp = parent.join(format!(".stashpad-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(storage_error)?;
        f.write_all(bytes).map_err(storage_error)?;
        f.sync_all().map_err(storage_error)?;
        std::fs::rename(&tmp, path).map_err(storage_error)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}
