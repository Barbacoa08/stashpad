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
    if s.notes.len() > 10000 || s.drafts.len() > 10001 {
        return Err(invalid());
    }
    let mut ids = HashMap::new();
    for n in &s.notes {
        if !uuid(&n.id)
            || ids.insert(n.id.to_lowercase(), n).is_some()
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
        if (d.key != "compose" && !uuid(&d.key))
            || !keys.insert(d.key.to_lowercase())
            || d.markdown.len() > MAX_SOURCE
            || d.revision < 0
            || d.revision > MAX_SAFE
            || d.updated_at < 0
            || d.updated_at > MAX_SAFE
            || (d.key != "compose"
                && !ids
                    .get(&d.key.to_lowercase())
                    .is_some_and(|n| n.id == d.key && n.deleted_at.is_none()))
        {
            return Err(invalid());
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
pub fn encode(s: &WorkspaceSnapshot) -> Result<Vec<u8>> {
    validate_snapshot(s)?;
    let b = BackupV1 {
        format: "stashpad-alpha".into(),
        version: 1,
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
pub fn validate(bytes: &[u8]) -> Result<BackupV1> {
    if bytes.len() > MAX_ENVELOPE {
        return Err(invalid());
    }
    let b: BackupV1 = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if b.format != "stashpad-alpha" || b.version != 1 || !timestamp(&b.exported_at) {
        return Err(invalid());
    }
    validate_snapshot(&b.workspace)?;
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
