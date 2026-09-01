//! The Capacity Dock: a slim quota rail docked to the right screen edge, the Windows twin of
//! the macOS Capacity Dock. The window is created on demand and closed again when the dock is
//! switched off, so a disabled dock leaves no webview resident.

use std::fs;
use std::path::PathBuf;

use anyhow::Result;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const DOCK_LABEL: &str = "dock";

/// Whole-point metrics at the macOS dock's default 0.6 scale: its 88pt rail lands on 53, which
/// `layout.activityBarWidth` in tokens.json already rounds to 56 for this frontend. Fractional
/// sizes cost the mac app 5-7% idle CPU by making the hosting view re-lay itself out forever,
/// so every value here stays an integer.
const RAIL_WIDTH: f64 = 56.0;
const ROW_HEIGHT: f64 = 50.0;
const ROW_SPACING: f64 = 7.0;
const RAIL_PAD: f64 = 12.0;
const DETAIL_WIDTH: f64 = 300.0;

fn state_path() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".config/codeburn"))
        .unwrap_or_else(|| PathBuf::from(".codeburn"))
        .join("windows-dock.json")
}

pub fn is_enabled() -> bool {
    fs::read(state_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("enabled").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

pub fn set_enabled(enabled: bool) -> Result<()> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_vec_pretty(&serde_json::json!({ "enabled": enabled }))?;
    fs::write(&path, body)?;
    Ok(())
}

fn logical_height(rows: u32) -> f64 {
    let rows = rows.max(1) as f64;
    RAIL_PAD * 2.0 + rows * ROW_HEIGHT + (rows - 1.0) * ROW_SPACING
}

/// Right edge, vertically centred, sized to the provider count. Expanding keeps the right edge
/// flush and grows leftwards, so the rail never moves under the pointer.
pub fn apply_layout(window: &tauri::WebviewWindow, rows: u32, expanded: bool) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let width = if expanded {
        RAIL_WIDTH + DETAIL_WIDTH
    } else {
        RAIL_WIDTH
    };
    let w = (width * scale).round() as i32;
    let h = (logical_height(rows) * scale).round() as i32;

    let area = monitor.work_area();
    let x = area.position.x + area.size.width as i32 - w;
    let y = area.position.y + ((area.size.height as i32 - h) / 2).max(0);

    #[cfg(debug_assertions)]
    eprintln!(
        "codeburn dock: scale={scale} work_area={},{} {}x{} -> pos {x},{y} size {w}x{h}",
        area.position.x, area.position.y, area.size.width, area.size.height
    );
    let _ = window.set_size(tauri::PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

pub fn show(app: &AppHandle) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(DOCK_LABEL) {
        existing.show()?;
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(app, DOCK_LABEL, WebviewUrl::default())
        .title("CodeBurn Capacity Dock")
        .inner_size(RAIL_WIDTH, logical_height(1))
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .shadow(false)
        .visible(false);

    // The page draws its own rounded card, so the window behind it has to be see-through.
    // `transparent` is only compiled in off macOS, where it needs the private-API feature.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);

    let window = builder.build()?;

    apply_layout(&window, 1, false);
    window.show()?;
    #[cfg(debug_assertions)]
    eprintln!("codeburn dock: window created and shown");
    Ok(())
}

/// Closing rather than hiding is deliberate: a hidden webview keeps rendering, which is what
/// cost the macOS popover 6% idle CPU.
pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(DOCK_LABEL) {
        let _ = window.close();
    }
}
