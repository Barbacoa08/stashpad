//! Native window preferences, deliberately independent of notes and backups.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, Window, WindowEvent};

const FILE_NAME: &str = "window-geometry.json";
const MAX_BYTES: usize = 4096;
const MAX_COORDINATE: f64 = 100_000.0;
const MAX_SIZE: f64 = 32_768.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedGeometry {
    version: u8,
    frame: Frame,
}

fn valid_frame(frame: Frame) -> bool {
    [frame.x, frame.y, frame.width, frame.height]
        .iter()
        .all(|value| value.is_finite())
        && frame.x.abs() <= MAX_COORDINATE
        && frame.y.abs() <= MAX_COORDINATE
        && (100.0..=MAX_SIZE).contains(&frame.width)
        && (80.0..=MAX_SIZE).contains(&frame.height)
}

fn decode(bytes: &[u8]) -> Option<Frame> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    let saved: SavedGeometry = serde_json::from_slice(bytes).ok()?;
    (saved.version == 1 && valid_frame(saved.frame)).then_some(saved.frame)
}

fn load(path: &Path) -> Option<Frame> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    decode(&bytes)
}

fn save(path: &Path, frame: Frame) -> io::Result<()> {
    if !valid_frame(frame) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid window frame",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "Missing preferences directory")
    })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".window-geometry-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let bytes = serde_json::to_vec(&SavedGeometry { version: 1, frame })?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn intersection(a: Frame, b: Frame) -> f64 {
    ((a.x + a.width).min(b.x + b.width) - a.x.max(b.x)).max(0.0)
        * ((a.y + a.height).min(b.y + b.height) - a.y.max(b.y)).max(0.0)
}

// A normal frame remains useful if a contiguous 160-by-32-point titlebar
// strip is reachable on one monitor (the whole width for narrower windows).
// Keep such frames exact, including spanning or intentionally partial-offscreen
// placement. Otherwise bring the whole window into an available work area.
fn fit(frame: Frame, areas: &[Frame], fallback: Frame) -> Frame {
    let titlebar_width = frame.width.min(160.0);
    if areas
        .iter()
        .copied()
        .filter(|area| valid_frame(*area))
        .any(|area| {
            let visible_width =
                (frame.x + frame.width).min(area.x + area.width) - frame.x.max(area.x);
            visible_width >= titlebar_width
                && frame.y >= area.y
                && frame.y + 32.0 <= area.y + area.height
        })
    {
        return frame;
    }
    let area = areas
        .iter()
        .copied()
        .filter(|area| valid_frame(*area))
        .filter(|area| intersection(frame, *area) > 0.0)
        .max_by(|a, b| intersection(frame, *a).total_cmp(&intersection(frame, *b)))
        .unwrap_or(fallback);
    let width = frame.width.min(area.width);
    let height = frame.height.min(area.height);
    Frame {
        x: frame.x.clamp(area.x, area.x + area.width - width),
        y: frame.y.clamp(area.y, area.y + area.height - height),
        width,
        height,
    }
}

// Tauri 2.12.5/Tao 0.37.2 exposes the full NSView as inner_size in Overlay,
// but set_size calls NSWindow.setContentSize. inner_position still describes
// contentRectForFrameRect. Include that offset so every reopen preserves the
// outer frame rather than adding a titlebar. All arguments here are physical;
// the requested frame and result are logical points.
fn content_size(
    frame: Frame,
    outer: (f64, f64),
    inner: (f64, f64),
    offset: (f64, f64),
    scale: f64,
) -> Option<(f64, f64)> {
    if !scale.is_finite() || scale <= 0.0 || !valid_frame(frame) {
        return None;
    }
    if ![outer.0, outer.1, inner.0, inner.1, offset.0, offset.1]
        .iter()
        .all(|v| v.is_finite())
    {
        return None;
    }
    let horizontal = (outer.0 - inner.0).max(2.0 * offset.0).max(0.0) / scale;
    let vertical = (outer.1 - inner.1)
        .max(offset.1 + horizontal * scale / 2.0)
        .max(0.0)
        / scale;
    let size = (frame.width - horizontal, frame.height - vertical);
    (size.0 >= 1.0 && size.1 >= 1.0).then_some(size)
}

struct Preferences {
    path: Option<PathBuf>,
    latest: Option<Frame>,
    phase: Phase,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    AwaitingPage,
    Restoring,
    Active,
}

pub(crate) struct GeometryState(Mutex<Preferences>);

impl GeometryState {
    pub(crate) fn new(directory: Option<PathBuf>) -> Self {
        let path = directory.map(|directory| directory.join(FILE_NAME));
        let latest = path.as_deref().and_then(load);
        Self(Mutex::new(Preferences {
            path,
            latest,
            phase: Phase::AwaitingPage,
        }))
    }

    fn begin_restore(&self) -> Option<Option<Frame>> {
        let mut state = self.0.lock().ok()?;
        if state.phase != Phase::AwaitingPage {
            return None;
        }
        state.phase = Phase::Restoring;
        Some(state.latest)
    }

    fn finish_restore(&self, frame: Option<Frame>) {
        if let Ok(mut state) = self.0.lock() {
            state.latest = frame;
            state.phase = Phase::Active;
        }
    }

    fn active(&self) -> bool {
        self.0
            .lock()
            .is_ok_and(|state| state.phase == Phase::Active)
    }

    fn record(&self, frame: Frame) {
        if let Ok(mut state) = self.0.lock() {
            if state.phase == Phase::Active {
                state.latest = Some(frame);
            }
        }
    }

    fn persist(&self) {
        // No window calls or filesystem I/O while holding this mutex: platform
        // setters may synchronously deliver more window events.
        let snapshot = self.0.lock().ok().and_then(|state| {
            if state.phase != Phase::Active {
                return None;
            }
            Some((state.path.clone()?, state.latest?))
        });
        if let Some((path, frame)) = snapshot {
            if let Err(error) = save(&path, frame) {
                eprintln!("Cannot save window geometry: {error}");
            }
        }
    }
}

fn capture(window: &Window) -> Option<Frame> {
    // Keep the last normal frame when minimized, maximized, or fullscreen.
    // Startup never restores hidden/minimized state.
    if window.is_minimized().ok()? || window.is_maximized().ok()? || window.is_fullscreen().ok()? {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.outer_size().ok()?.to_logical::<f64>(scale);
    let frame = Frame {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    valid_frame(frame).then_some(frame)
}

fn work_area(monitor: tauri::Monitor) -> Option<Frame> {
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let area = monitor.work_area();
    let position = area.position.to_logical::<f64>(scale);
    let size = area.size.to_logical::<f64>(scale);
    let frame = Frame {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    valid_frame(frame).then_some(frame)
}

pub(crate) fn restore(window: &Window) {
    if window.label() != "main" {
        return;
    }
    let Some(state) = window.try_state::<GeometryState>() else {
        return;
    };
    let Some(saved) = state.begin_restore() else {
        return;
    };
    let initial = capture(window);
    let applied = saved.and_then(|saved| {
        let areas: Vec<Frame> = window
            .available_monitors()
            .ok()?
            .into_iter()
            .filter_map(work_area)
            .collect();
        let fallback = window
            .current_monitor()
            .ok()
            .flatten()
            .and_then(work_area)
            .or_else(|| areas.first().copied())?;
        let frame = fit(saved, &areas, fallback);
        let scale = window.scale_factor().ok()?;
        let outer = window.outer_size().ok()?;
        let inner = window.inner_size().ok()?;
        let outer_position = window.outer_position().ok()?;
        let inner_position = window.inner_position().ok()?;
        let size = content_size(
            frame,
            (outer.width as f64, outer.height as f64),
            (inner.width as f64, inner.height as f64),
            (
                (inner_position.x as f64) - (outer_position.x as f64),
                (inner_position.y as f64) - (outer_position.y as f64),
            ),
            scale,
        )?;
        window
            .set_size(tauri::LogicalSize::new(size.0, size.1))
            .ok()?;
        window
            .set_position(tauri::LogicalPosition::new(frame.x, frame.y))
            .ok()?;
        Some(frame)
    });
    // Setters may queue native work. Cache the requested frame until the ensuing
    // move/resize events provide the actual applied frame, rather than capturing
    // the pre-restore position immediately after requesting it.
    state.finish_restore(applied.or(initial));
}

pub(crate) fn event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let Some(state) = window.try_state::<GeometryState>() else {
        return;
    };
    if !state.active() {
        return;
    }
    match event {
        WindowEvent::Moved(_)
        | WindowEvent::Resized(_)
        | WindowEvent::ScaleFactorChanged { .. } => {
            if let Some(frame) = capture(window) {
                state.record(frame);
            }
        }
        WindowEvent::CloseRequested { .. } => {
            if let Some(frame) = capture(window) {
                state.record(frame);
            }
            state.persist();
        }
        WindowEvent::Destroyed => state.persist(),
        _ => {}
    }
}

pub(crate) fn exiting(app: &tauri::AppHandle) {
    if !app
        .try_state::<GeometryState>()
        .is_some_and(|state| state.active())
    {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Some(frame) = capture(&window.as_ref().window()) {
            if let Some(state) = app.try_state::<GeometryState>() {
                state.record(frame);
            }
        }
    }
    if let Some(state) = app.try_state::<GeometryState>() {
        state.persist();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn normal() -> Frame {
        Frame {
            x: 125.5,
            y: 70.0,
            width: 1100.0,
            height: 760.0,
        }
    }
    fn area() -> Frame {
        Frame {
            x: 0.0,
            y: 25.0,
            width: 1440.0,
            height: 875.0,
        }
    }

    #[test]
    fn startup_events_cannot_replace_saved_bounds_and_restore_runs_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        save(&path, normal()).unwrap();
        let state = GeometryState::new(Some(dir.path().to_owned()));
        let startup = Frame {
            x: 0.0,
            y: 0.0,
            width: 500.0,
            height: 500.0,
        };
        state.record(startup);
        state.persist();
        assert_eq!(load(&path), Some(normal()));
        assert_eq!(state.begin_restore(), Some(Some(normal())));
        state.record(startup);
        assert_eq!(state.begin_restore(), None);
        state.finish_restore(Some(normal()));
        assert!(state.active());
        assert_eq!(state.begin_restore(), None);
        state.persist();
        assert_eq!(load(&path), Some(normal()));
        let moved = Frame {
            x: 200.0,
            y: 100.0,
            ..normal()
        };
        state.record(moved);
        state.persist();
        assert_eq!(load(&path), Some(moved));
    }

    #[test]
    fn saved_frame_roundtrips_without_changing_fractional_or_negative_coordinates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window.json");
        let frame = Frame {
            x: -1300.5,
            y: 55.5,
            ..normal()
        };
        save(&path, frame).unwrap();
        assert_eq!(load(&path), Some(frame));
    }

    #[test]
    fn missing_corrupt_unknown_and_oversized_preferences_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window.json");
        assert_eq!(load(&path), None);
        for bytes in [
            b"oops".as_slice(),
            br#"{"version":2,"frame":{"x":0,"y":0,"width":1100,"height":760}}"#,
            br#"{"version":1,"frame":{"x":0,"y":0,"width":1100,"height":760},"other":true}"#,
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(load(&path), None);
        }
        let mut bytes =
            br#"{"version":1,"frame":{"x":0,"y":0,"width":1100,"height":760}}"#.to_vec();
        bytes.resize(8192, b' ');
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(load(&path), None);
        assert_eq!(
            decode(br#"{"version":1,"frame":{"x":0,"y":0,"width":1100,"height":760}}"#),
            Some(Frame {
                x: 0.0,
                y: 0.0,
                ..normal()
            })
        );
    }

    #[test]
    fn invalid_nonfinite_or_unreasonable_bounds_are_never_saved() {
        assert!(valid_frame(normal()));
        for frame in [
            Frame {
                width: 0.0,
                ..normal()
            },
            Frame {
                height: -1.0,
                ..normal()
            },
            Frame {
                x: f64::NAN,
                ..normal()
            },
            Frame {
                y: f64::INFINITY,
                ..normal()
            },
            Frame {
                width: 1e12,
                ..normal()
            },
            Frame {
                x: 1e12,
                ..normal()
            },
        ] {
            assert!(!valid_frame(frame));
        }
        assert_eq!(
            decode(br#"{"version":1,"frame":{"x":0,"y":0,"width":0,"height":760}}"#),
            None
        );
    }

    #[test]
    fn unchanged_display_preserves_the_exact_outer_frame() {
        assert_eq!(fit(normal(), &[area()], area()), normal());
        let left = Frame {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let saved = Frame {
            x: -1800.0,
            y: 100.0,
            ..normal()
        };
        assert_eq!(fit(saved, &[area(), left], area()), saved);
    }

    #[test]
    fn spanning_present_monitors_preserves_exact_bounds_when_titlebar_is_reachable() {
        let right = Frame {
            x: 1440.0,
            y: 25.0,
            width: 1920.0,
            height: 1055.0,
        };
        let spanning = Frame {
            x: 900.0,
            y: 70.0,
            width: 1800.0,
            height: 760.0,
        };
        assert_eq!(fit(spanning, &[area(), right], area()), spanning);
    }

    #[test]
    fn partial_offscreen_bounds_need_a_useful_titlebar_strip_to_remain_exact() {
        let reachable = Frame {
            x: 1280.0,
            y: 70.0,
            ..normal()
        };
        assert_eq!(fit(reachable, &[area()], area()), reachable);
        // A 159-point sliver is below the recovery threshold; the whole frame
        // comes back into view rather than relying on a barely reachable edge.
        assert_eq!(
            fit(
                Frame {
                    x: 1281.0,
                    ..reachable
                },
                &[area()],
                area()
            ),
            Frame {
                x: 340.0,
                y: 70.0,
                ..normal()
            }
        );
        // A visible body without the whole 32-point titlebar strip is unsafe.
        assert_eq!(
            fit(
                Frame {
                    y: 24.0,
                    ..normal()
                },
                &[area()],
                area()
            ),
            Frame {
                y: 25.0,
                ..normal()
            }
        );
        assert_eq!(
            fit(
                Frame {
                    y: 869.0,
                    ..normal()
                },
                &[area()],
                area()
            ),
            Frame {
                y: 140.0,
                ..normal()
            }
        );
        let narrow = Frame {
            x: 1340.0,
            y: 70.0,
            width: 100.0,
            height: 300.0,
        };
        assert_eq!(fit(narrow, &[area()], area()), narrow);
    }

    #[test]
    fn removed_or_smaller_display_clamps_to_reachable_work_area() {
        assert_eq!(
            fit(
                Frame {
                    x: -2000.0,
                    y: -1000.0,
                    ..normal()
                },
                &[area()],
                area()
            ),
            Frame {
                x: 0.0,
                y: 25.0,
                ..normal()
            }
        );
        let small = Frame {
            x: 0.0,
            y: 25.0,
            width: 800.0,
            height: 575.0,
        };
        assert_eq!(
            fit(
                Frame {
                    x: 1000.0,
                    y: 500.0,
                    ..normal()
                },
                &[small],
                small
            ),
            Frame {
                x: 0.0,
                y: 25.0,
                width: 800.0,
                height: 575.0
            }
        );
        assert_eq!(
            fit(
                Frame {
                    x: 800.0,
                    y: 800.0,
                    ..normal()
                },
                &[area()],
                area()
            ),
            Frame {
                x: 800.0,
                y: 800.0,
                ..normal()
            }
        );
    }

    #[test]
    fn overlay_titlebar_uses_content_rect_offset_instead_of_webview_size() {
        // Overlay makes the webview as tall as the outer frame. set_size still
        // takes the native content rect, which excludes the 28-point titlebar.
        for scale in [1.0, 2.0] {
            let mut frame = normal();
            for _ in 0..5 {
                let size = content_size(
                    frame,
                    (1100.0 * scale, 760.0 * scale),
                    (1100.0 * scale, 760.0 * scale),
                    (0.0, 28.0 * scale),
                    scale,
                )
                .unwrap();
                assert_eq!(size, (1100.0, 732.0));
                frame.height = size.1 + 28.0;
            }
            assert_eq!(frame.height, 760.0);
        }
        assert_eq!(
            content_size(
                normal(),
                (2200.0, 1520.0),
                (2168.0, 1442.0),
                (16.0, 62.0),
                2.0
            ),
            Some((1084.0, 721.0))
        );
        assert_eq!(
            content_size(normal(), (1100.0, 760.0), (1100.0, 760.0), (0.0, 28.0), 0.0),
            None
        );
    }

    #[test]
    fn failed_atomic_write_keeps_the_prior_preference() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window.json");
        save(&path, normal()).unwrap();
        // Invalid input cannot replace a valid preference.
        assert!(save(
            &path,
            Frame {
                width: f64::NAN,
                ..normal()
            }
        )
        .is_err());
        assert_eq!(load(&path), Some(normal()));
        // A destination that cannot be replaced must remain untouched.
        let directory = dir.path().join("occupied");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("keep"), b"prior").unwrap();
        assert!(save(&directory, normal()).is_err());
        assert_eq!(std::fs::read(directory.join("keep")).unwrap(), b"prior");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
}
