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
pub fn validate_snapshot(s: &V5Workspace) -> Result<()> {
    let current = true;
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
                if index.get(parent).is_none_or(|p| p.kind != V5Kind::Stash) {
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
                    .is_none_or(|p| !current && p.kind != V5Kind::Stash)
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
                .is_some_and(|x| current || x.kind == V5Kind::Stash)
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
pub fn validate(bytes: &[u8]) -> Result<BackupV5> {
    if bytes.len() > MAX_ENVELOPE {
        return Err(invalid());
    }
    let b: BackupV5 = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if b.format != "stashpad-alpha" || b.version != 5 || !timestamp(&b.exported_at) {
        return Err(invalid());
    }
    validate_snapshot(&b.workspace)?;
    Ok(b)
}
