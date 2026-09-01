//! The Capacity Dock: a slim quota rail docked to the right screen edge, the Windows twin of
//! the macOS Capacity Dock. The window is created on demand and closed again when the dock is
//! switched off, so a disabled dock leaves no webview resident.
//!
//! One window hosts both the rail and the hover bubble. This module owns the geometry the mac
//! app splits across CapacityDockPlacement and CapacityDockController: it turns a row count,
//! the hover state and the measured bubble height into a window rectangle plus the
//! window-relative frames the page paints into.

use std::fs;
use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const DOCK_LABEL: &str = "dock";

/// Whole-point metrics at the macOS dock's default 0.6 scale, the same numbers as
/// `src/dockGeometry.ts`. Fractional sizes cost the mac app 5-7% idle CPU by making the
/// hosting view re-lay itself out forever, so every value here stays an integer.
const RAIL_WIDTH: i32 = 53;
const ROW_HEIGHT: i32 = 50;
const ROW_SPACING: i32 = 7;
/// 12 of padding plus 60% of the 31 shoulder depth, so content never crowds the concave flare.
const RAIL_ALONG_PAD: i32 = 31;
const DETAIL_WIDTH: i32 = 315;
const DETAIL_GAP: i32 = 10;
const DETAIL_INSET: i32 = 8;
/// The rail's resting top edge sits this far below the top of the work area.
const DEFAULT_TOP_OFFSET: i32 = 156;
const VERTICAL_INSET: i32 = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn right(&self) -> i32 {
        self.x + self.w
    }
    fn bottom(&self) -> i32 {
        self.y + self.h
    }
    fn union(&self, other: &Rect) -> Rect {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Rect {
            x,
            y,
            w: self.right().max(other.right()) - x,
            h: self.bottom().max(other.bottom()) - y,
        }
    }
    fn offset(&self, dx: i32, dy: i32) -> Rect {
        Rect {
            x: self.x + dx,
            y: self.y + dy,
            ..*self
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailRequest {
    /// Index of the hovered row, counted from the top of the rail.
    pub row: u32,
    pub height: i32,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRequest {
    pub rows: u32,
    pub expanded: bool,
    pub detail: Option<DetailRequest>,
}

/// Which end of the rail stays put while it grows: the resting rail keeps its top and grows
/// downward unless there is more room above it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Anchor {
    Start,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailFrame {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// Where the tail points, in the bubble's own coordinates.
    pub tail_y: i32,
}

/// Everything the page needs to paint: frames are relative to the window's top-left corner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockFrame {
    #[serde(skip)]
    pub window: Rect,
    pub rail: Rect,
    pub anchor: Anchor,
    pub detail: Option<DetailFrame>,
}

fn rail_height(rows: u32) -> i32 {
    let rows = rows.max(1) as i32;
    RAIL_ALONG_PAD * 2 + rows * ROW_HEIGHT + (rows - 1) * ROW_SPACING
}

/// Pure layout in logical pixels. `area` is the monitor work area.
pub fn layout(area: Rect, request: &LayoutRequest) -> DockFrame {
    let rest_h = rail_height(1);
    let rail_h = if request.expanded {
        rail_height(request.rows)
    } else {
        rest_h
    };
    let lowest_top = area.y + VERTICAL_INSET;
    let clamp_top = |top: i32, h: i32| top.clamp(lowest_top, (area.bottom() - VERTICAL_INSET - h).max(lowest_top));

    let rest_top = clamp_top(area.y + DEFAULT_TOP_OFFSET, rest_h);
    let room_below = area.bottom() - (rest_top + rest_h);
    let room_above = rest_top - area.y;
    let anchor = if room_below >= room_above {
        Anchor::Start
    } else {
        Anchor::End
    };
    let rail_top = match anchor {
        Anchor::Start => clamp_top(rest_top, rail_h),
        Anchor::End => clamp_top(rest_top + rest_h - rail_h, rail_h),
    };
    let rail = Rect {
        x: area.right() - RAIL_WIDTH,
        y: rail_top,
        w: RAIL_WIDTH,
        h: rail_h,
    };

    let detail = request.detail.map(|d| {
        let w = DETAIL_WIDTH.min((area.w - DETAIL_INSET * 2).max(0));
        let h = d.height.max(1).min((area.h - DETAIL_INSET * 2).max(1));
        let row_mid = rail.y + RAIL_ALONG_PAD + d.row as i32 * (ROW_HEIGHT + ROW_SPACING) + ROW_HEIGHT / 2;
        let min_x = area.x + DETAIL_INSET;
        let max_x = (area.right() - DETAIL_INSET - w).max(min_x);
        let min_y = area.y + DETAIL_INSET;
        let max_y = (area.bottom() - DETAIL_INSET - h).max(min_y);
        let x = (rail.x - DETAIL_GAP - w).clamp(min_x, max_x);
        let y = (row_mid - h / 2).clamp(min_y, max_y);
        (Rect { x, y, w, h }, row_mid - y)
    });

    let window = match &detail {
        Some((rect, _)) => rail.union(rect),
        None => rail,
    };
    DockFrame {
        window,
        rail: rail.offset(-window.x, -window.y),
        anchor,
        detail: detail.map(|(rect, tail_y)| {
            let local = rect.offset(-window.x, -window.y);
            DetailFrame {
                x: local.x,
                y: local.y,
                w: local.w,
                h: local.h,
                tail_y,
            }
        }),
    }
}

fn state_path() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".config/codeburn"))
        .unwrap_or_else(|| PathBuf::from(".codeburn"))
        .join("windows-dock.json")
}

fn read_state() -> serde_json::Map<String, serde_json::Value> {
    fs::read(state_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn write_state(state: &serde_json::Map<String, serde_json::Value>) -> Result<()> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_vec_pretty(state)?)?;
    Ok(())
}

pub fn is_enabled() -> bool {
    read_state()
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

pub fn set_enabled(enabled: bool) -> Result<()> {
    let mut state = read_state();
    state.insert("enabled".into(), serde_json::Value::Bool(enabled));
    write_state(&state)
}

/// The provider the resting rail shows. A click on another row makes it the preferred one,
/// as on the mac.
pub fn preferred_provider() -> Option<String> {
    read_state()
        .get("preferred")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

pub fn set_preferred_provider(id: &str) -> Result<()> {
    let mut state = read_state();
    state.insert("preferred".into(), serde_json::Value::String(id.to_owned()));
    write_state(&state)
}

/// Sizes and moves the window in one step and returns the frames the page paints into.
pub fn apply_layout(window: &tauri::WebviewWindow, request: &LayoutRequest) -> Option<DockFrame> {
    let monitor = window.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let logical = |v: i32| (v as f64 / scale).round() as i32;
    let area = Rect {
        x: logical(area.position.x),
        y: logical(area.position.y),
        w: logical(area.size.width as i32),
        h: logical(area.size.height as i32),
    };
    let frame = layout(area, request);
    let physical = |v: i32| (v as f64 * scale).round() as i32;
    let target = Rect {
        x: physical(frame.window.x),
        y: physical(frame.window.y),
        w: physical(frame.window.w).max(1),
        h: physical(frame.window.h).max(1),
    };

    #[cfg(debug_assertions)]
    eprintln!(
        "codeburn dock: scale={scale} work_area={},{} {}x{} -> pos {},{} size {}x{}",
        area.x, area.y, area.w, area.h, target.x, target.y, target.w, target.h
    );
    move_and_resize(window, target);
    Some(frame)
}

/// Size and position change together: two separate calls repaint twice, and between them the
/// rail would flash at the wrong offset inside the window.
#[cfg(target_os = "windows")]
fn move_and_resize(window: &tauri::WebviewWindow, target: Rect) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        SetWindowPos(
            hwnd.0 as _,
            std::ptr::null_mut(),
            target.x,
            target.y,
            target.w,
            target.h,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn move_and_resize(window: &tauri::WebviewWindow, target: Rect) {
    let _ = window.set_size(tauri::PhysicalSize::new(target.w as u32, target.h as u32));
    let _ = window.set_position(tauri::PhysicalPosition::new(target.x, target.y));
}

pub fn show(app: &AppHandle) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(DOCK_LABEL) {
        existing.show()?;
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(app, DOCK_LABEL, WebviewUrl::default())
        .title("CodeBurn Capacity Dock")
        .inner_size(RAIL_WIDTH as f64, rail_height(1) as f64)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .shadow(false)
        .visible(false);

    // The page draws its own card shapes, so the window behind them has to be see-through.
    // `transparent` is only compiled in off macOS, where it needs the private-API feature.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);

    let window = builder.build()?;

    apply_layout(
        &window,
        &LayoutRequest {
            rows: 1,
            expanded: false,
            detail: None,
        },
    );
    window.show()?;
    #[cfg(debug_assertions)]
    {
        eprintln!("codeburn dock: window created and shown");
        if std::env::var_os("CODEBURN_DOCK_DEVTOOLS").is_some() {
            window.open_devtools();
        }
    }
    Ok(())
}

/// Closing rather than hiding is deliberate: a hidden webview keeps rendering, which is what
/// cost the macOS popover 6% idle CPU.
pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(DOCK_LABEL) {
        let _ = window.close();
    }
}

/// The rail's right-click menu, the mac dock's context menu minus the edge choices v1 does
/// not offer. Menu events arrive in `lib.rs` under the `dock_` ids.
pub fn popup_context_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{ContextMenu, Menu, MenuItem};
    let Some(window) = app.get_webview_window(DOCK_LABEL) else {
        return Ok(());
    };
    let refresh = MenuItem::with_id(app, "dock_refresh", "Refresh", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "dock_hide", "Hide Capacity Dock", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&refresh, &hide])?;
    menu.popup(window.as_ref().window())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect { x: 0, y: 0, w: 1600, h: 852 };

    fn request(rows: u32, expanded: bool, detail: Option<DetailRequest>) -> LayoutRequest {
        LayoutRequest { rows, expanded, detail }
    }

    #[test]
    fn resting_rail_hugs_the_right_edge_below_the_default_offset() {
        let frame = layout(AREA, &request(1, false, None));
        assert_eq!(frame.window, Rect { x: 1600 - RAIL_WIDTH, y: 156, w: RAIL_WIDTH, h: 112 });
        assert_eq!(frame.rail, Rect { x: 0, y: 0, w: RAIL_WIDTH, h: 112 });
        assert_eq!(frame.anchor, Anchor::Start);
        assert!(frame.detail.is_none());
    }

    #[test]
    fn expansion_keeps_the_top_and_grows_downward() {
        let rest = layout(AREA, &request(1, false, None));
        let expanded = layout(AREA, &request(3, true, None));
        assert_eq!(expanded.window.y, rest.window.y);
        assert_eq!(expanded.window.h, 31 * 2 + 3 * 50 + 2 * 7);
    }

    #[test]
    fn a_short_work_area_anchors_at_the_end_and_grows_upward() {
        let area = Rect { x: 0, y: 0, w: 1280, h: 400 };
        let rest = layout(area, &request(1, false, None));
        let expanded = layout(area, &request(3, true, None));
        assert_eq!(rest.anchor, Anchor::End);
        assert_eq!(expanded.window.bottom(), rest.window.bottom());
        assert!(expanded.window.y >= area.y + VERTICAL_INSET);
        // A rail taller than the room above it is pushed down rather than off the screen.
        let oversized = layout(area, &request(6, true, None));
        assert_eq!(oversized.window.y, area.y + VERTICAL_INSET);
    }

    #[test]
    fn detail_sits_left_of_the_rail_centred_on_its_row() {
        let frame = layout(AREA, &request(2, true, Some(DetailRequest { row: 1, height: 160 })));
        let detail = frame.detail.expect("detail frame");
        let rail_x = 1600 - RAIL_WIDTH;
        assert_eq!(frame.window.x, rail_x - DETAIL_GAP - DETAIL_WIDTH);
        assert_eq!(detail.w, DETAIL_WIDTH);
        assert_eq!(detail.h, 160);
        let row_mid = RAIL_ALONG_PAD + (ROW_HEIGHT + ROW_SPACING) + ROW_HEIGHT / 2;
        assert_eq!(detail.tail_y, row_mid - (detail.y - frame.rail.y));
        assert_eq!(frame.rail.x, DETAIL_WIDTH + DETAIL_GAP);
    }

    #[test]
    fn detail_is_clamped_inside_the_work_area() {
        let frame = layout(AREA, &request(1, true, Some(DetailRequest { row: 0, height: 900 })));
        let detail = frame.detail.expect("detail frame");
        assert_eq!(detail.h, AREA.h - DETAIL_INSET * 2);
        assert_eq!(frame.window.y + detail.y, DETAIL_INSET);
    }
}
