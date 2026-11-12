use crate::model::*;
use std::collections::{HashMap, HashSet};
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
pub fn validate_snapshot(s: &V3Workspace) -> Result<()> {
    if s.notes.len() > 10000 || s.stashes.len() > 10000 || s.drafts.len() > 20001 {
        return Err(invalid());
    }
    let mut stashes = HashMap::new();
    let mut all_ids = HashSet::new();
    for stash in &s.stashes {
        if !uuid(&stash.id)
            || !all_ids.insert(stash.id.to_lowercase())
            || stash_name(&stash.name).as_ref().ok() != Some(&stash.name)
            || !(0..=MAX_SAFE).contains(&stash.created_at)
            || !(stash.created_at..=MAX_SAFE).contains(&stash.updated_at)
        {
            return Err(invalid());
        }
        stashes.insert(stash.id.as_str(), stash);
    }
    let mut done = HashSet::new();
    for stash in &s.stashes {
        let mut id = Some(stash.id.as_str());
        let mut pending = HashSet::new();
        while let Some(key) = id {
            if done.contains(key) {
                break;
            }
            if !pending.insert(key) {
                return Err(invalid());
            }
            let current = stashes.get(key).ok_or_else(invalid)?;
            id = current.parent_id.as_deref();
        }
        done.extend(pending);
    }
    let mut ids = HashMap::new();
    for n in &s.notes {
        if !uuid(&n.id)
            || !all_ids.insert(n.id.to_lowercase())
            || ids.insert(n.id.to_lowercase(), n).is_some()
            || n.stash_id
                .as_ref()
                .is_some_and(|id| !stashes.contains_key(id.as_str()))
            || n.markdown.len() > MAX_SOURCE
            || n.created_at < 0
            || n.created_at > MAX_SAFE
            || n.updated_at < 0
            || n.updated_at > MAX_SAFE
            || n.updated_at < n.created_at
            || n.deleted_at.is_some_and(|t| !(0..=MAX_SAFE).contains(&t))
        {
            return Err(invalid());
        }
    }
    let mut keys = HashSet::new();
    for d in &s.drafts {
        if (compose_owner(&d.key).is_none() && !uuid(&d.key))
            || !keys.insert(d.key.to_lowercase())
            || d.markdown.len() > MAX_SOURCE
            || d.revision < 0
            || d.revision > MAX_SAFE
            || d.updated_at < 0
            || d.updated_at > MAX_SAFE
            || (compose_owner(&d.key).is_none()
                && !ids
                    .get(&d.key.to_lowercase())
                    .is_some_and(|n| n.id == d.key && n.deleted_at.is_none()))
        {
            return Err(invalid());
        }
        if let Some(Some(id)) = compose_owner(&d.key) {
            if !stashes.contains_key(id) {
                return Err(invalid());
            }
        }
    }
    if let Some(id) = &s.undo_delete_id {
        if !uuid(id)
            || !ids
                .get(&id.to_lowercase())
                .is_some_and(|n| n.id == *id && n.deleted_at.is_some())
        {
            return Err(invalid());
        }
    }
    Ok(())
}
pub fn encode(s: &V3Workspace) -> Result<Vec<u8>> {
    validate_snapshot(s)?;
    let b = BackupV3 {
        format: "stashpad-alpha".into(),
        version: 3,
        exported_at: crate::backup::iso_now(),
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
pub fn validate(bytes: &[u8]) -> Result<BackupV3> {
    if bytes.len() > MAX_ENVELOPE {
        return Err(invalid());
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let b: BackupV3 = match value.get("version").and_then(|v| v.as_i64()) {
        Some(1) => {
            let legacy: BackupV1 = serde_json::from_value(value).map_err(|_| invalid())?;
            if legacy.version != 1 || legacy.workspace.drafts.len() > 10001 {
                return Err(invalid());
            }
            legacy.into()
        }
        Some(2) => {
            let legacy: BackupV2 = serde_json::from_value(value).map_err(|_| invalid())?;
            legacy.into()
        }
        Some(3) => serde_json::from_value(value).map_err(|_| invalid())?,
        _ => return Err(invalid()),
    };
    if b.format != "stashpad-alpha" || !timestamp(&b.exported_at) {
        return Err(invalid());
    }
    validate_snapshot(&b.workspace)?;
    encode(&b.workspace).map_err(|_| error("invalid_backup", "Converted backup exceeds the 10 MiB capacity. The original backup is retained; recover using a compatible app or a verified smaller copy."))?;
    Ok(b)
}
