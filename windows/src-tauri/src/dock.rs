//! The Capacity Dock: a slim quota rail docked to a screen edge, the Windows twin of the macOS
//! Capacity Dock. The window is created on demand and closed again when the dock is switched
//! off, so a disabled dock leaves no webview resident.
//!
//! One transparent window hosts both the rail and the hover bubble, sized once per placement
//! for the fully expanded rail plus the bubble's reach. Hovering never moves or resizes it:
//! WebView2 presents one stale frame at every window change, which read as the rail jumping.
//! Pointer tracking (a 60 Hz cursor poll, the counterpart of the mac's global event monitor)
//! makes the window click-through everywhere but the painted shapes, synthesizes hover for the
//! page, and drives dragging: the rail follows the pointer, and on release snaps to whichever
//! edge is within reach or stays floating. This module owns all of that geometry; the page only
//! paints into the frames it is handed.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const DOCK_LABEL: &str = "dock";

/// Whole-point metrics at the macOS dock's default 0.6 scale, the same numbers as
/// `src/dockGeometry.ts`. Fractional sizes cost the mac app 5-7% idle CPU by making the
/// hosting view re-lay itself out forever, so every value here stays an integer.
const RAIL_WIDTH: i32 = 53;
/// Horizontal rails stack the ring above its label, so their cross-extent needs more room.
const HORIZONTAL_RAIL_WIDTH: i32 = 64;
const ROW_HEIGHT: i32 = 50;
const ROW_SPACING: i32 = 7;
const RAIL_ALONG_PAD: i32 = 12;
/// 60% of the 31 shoulder depth: a docked rail pads its ends so content never crowds the flare.
const FLARE_COMPENSATION: i32 = 19;
const DETAIL_WIDTH: i32 = 315;
/// The mac caps its bubble at 470 points times the 0.9 detail scale.
const DETAIL_MAX_HEIGHT: i32 = 423;
const DETAIL_GAP: i32 = 10;
/// How far past either end of the rail a bubble centred on an end row can reach.
const DETAIL_OVERHANG: i32 = 160;
/// The rail's resting top edge sits this far below the top of the work area.
const DEFAULT_TOP_OFFSET: i32 = 156;
const EDGE_INSET: i32 = 12;
const DOCK_SNAP_DISTANCE: i32 = 44;
const POLL_INTERVAL_MS: u64 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

impl Edge {
    pub fn is_vertical(self) -> bool {
        matches!(self, Edge::Left | Edge::Right)
    }
    pub fn opposite(self) -> Edge {
        match self {
            Edge::Left => Edge::Right,
            Edge::Right => Edge::Left,
            Edge::Top => Edge::Bottom,
            Edge::Bottom => Edge::Top,
        }
    }
}

/// Where the rail lives. `attachment` is the orientation edge, kept while floating so a rail
/// dragged off the right edge stays vertical. Offsets are normalized over the travel range so
/// they survive a resolution change; `None` means the mac defaults.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub docked: Option<Edge>,
    pub attachment: Edge,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

impl Default for Placement {
    fn default() -> Self {
        Placement {
            docked: Some(Edge::Right),
            attachment: Edge::Right,
            x: None,
            y: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
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
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
    fn offset(&self, dx: i32, dy: i32) -> Rect {
        Rect {
            x: self.x + dx,
            y: self.y + dy,
            ..*self
        }
    }
    /// Shrinks to fit inside `bounds`, then clamps the origin into it.
    fn fit_within(&self, bounds: &Rect) -> Rect {
        let w = self.w.min(bounds.w).max(1);
        let h = self.h.min(bounds.h).max(1);
        Rect {
            x: self.x.clamp(bounds.x, (bounds.right() - w).max(bounds.x)),
            y: self.y.clamp(bounds.y, (bounds.bottom() - h).max(bounds.y)),
            w,
            h,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailRequest {
    /// Index of the hovered row, counted from the rail's start (top or left).
    pub row: u32,
    pub height: i32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRequest {
    /// Rows the page is showing right now.
    pub rows: u32,
    /// Rows the fully expanded rail holds; the window is sized for these.
    pub total_rows: u32,
    pub expanded: bool,
    pub detail: Option<DetailRequest>,
}

/// Which end of the rail stays put while it grows.
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
    /// Where the tail points along the bubble's tail edge, in the bubble's own coordinates.
    pub tail: i32,
}

/// Everything the page needs to paint: frames are relative to the window's top-left corner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockFrame {
    #[serde(skip)]
    pub window: Rect,
    /// Screen-space start of the first row along the rail, for hit-testing.
    #[serde(skip)]
    rows_start: i32,
    #[serde(skip)]
    rows: u32,
    pub rail: Rect,
    pub edge: Edge,
    pub vertical: bool,
    pub docked: bool,
    pub along_pad: i32,
    pub anchor: Anchor,
    pub bubble_side: Edge,
    pub detail: Option<DetailFrame>,
    /// Hover comes from the cursor poll rather than DOM events when this is set.
    pub native_pointer: bool,
}

fn rail_length(rows: u32, pad: i32) -> i32 {
    let rows = rows.max(1) as i32;
    pad * 2 + rows * ROW_HEIGHT + (rows - 1) * ROW_SPACING
}

fn rows_extent(rows: u32) -> i32 {
    let rows = rows.max(1) as i32;
    rows * ROW_HEIGHT + (rows - 1) * ROW_SPACING
}

fn denormalize(norm: Option<f64>, low: i32, high: i32, fallback: i32) -> i32 {
    let high = high.max(low);
    match norm {
        Some(n) => low + ((high - low) as f64 * n.clamp(0.0, 1.0)).round() as i32,
        None => fallback.clamp(low, high),
    }
}

fn normalize(value: i32, low: i32, high: i32) -> f64 {
    if high <= low {
        0.0
    } else {
        ((value - low) as f64 / (high - low) as f64).clamp(0.0, 1.0)
    }
}

/// Pure layout in logical pixels. `area` is the monitor work area.
pub fn layout(area: Rect, placement: &Placement, request: &LayoutRequest) -> DockFrame {
    let edge = placement.attachment;
    let vertical = edge.is_vertical();
    let docked = placement.docked.is_some();
    let pad = RAIL_ALONG_PAD + if docked { FLARE_COMPENSATION } else { 0 };
    let cross = if vertical { RAIL_WIDTH } else { HORIZONTAL_RAIL_WIDTH };
    let rest_len = rail_length(1, pad);

    // Along axis: y for vertical rails, x for horizontal ones. Cross axis is the other.
    let (area_along, area_along_len, area_cross, area_cross_len) = if vertical {
        (area.y, area.h, area.x, area.w)
    } else {
        (area.x, area.w, area.y, area.h)
    };
    let along_low = area_along + EDGE_INSET;
    let cross_pos = match placement.docked {
        Some(Edge::Left) | Some(Edge::Top) => area_cross,
        Some(Edge::Right) | Some(Edge::Bottom) => area_cross + area_cross_len - cross,
        None => {
            let low = area_cross + EDGE_INSET;
            let high = area_cross + area_cross_len - EDGE_INSET - cross;
            let norm = if vertical { placement.x } else { placement.y };
            denormalize(norm, low, high, if vertical { high } else { low })
        }
    };
    let along_norm = if vertical { placement.y } else { placement.x };
    let rest_high = area_along + area_along_len - EDGE_INSET - rest_len;
    let rest_fallback = if vertical {
        area_along + DEFAULT_TOP_OFFSET
    } else {
        area_along + (area_along_len - rest_len) / 2
    };
    let rest_start = denormalize(along_norm, along_low, rest_high, rest_fallback);

    let room_after = area_along + area_along_len - (rest_start + rest_len);
    let room_before = rest_start - area_along;
    let anchor = if room_after >= room_before {
        Anchor::Start
    } else {
        Anchor::End
    };
    let rail_along = |rows: u32| -> (i32, i32) {
        let len = rail_length(rows, pad);
        let high = (area_along + area_along_len - EDGE_INSET - len).max(along_low);
        let start = match anchor {
            Anchor::Start => rest_start,
            Anchor::End => rest_start + rest_len - len,
        };
        (start.clamp(along_low, high), len)
    };
    let make_rect = |along: i32, len: i32| -> Rect {
        if vertical {
            Rect { x: cross_pos, y: along, w: cross, h: len }
        } else {
            Rect { x: along, y: cross_pos, w: len, h: cross }
        }
    };

    let shown_rows = if request.expanded { request.rows } else { 1 };
    let (rail_start, rail_len) = rail_along(shown_rows);
    let rail = make_rect(rail_start, rail_len);
    let (full_start, full_len) = rail_along(request.total_rows.max(request.rows));
    let full = make_rect(full_start, full_len);

    let bubble_side = match placement.docked {
        Some(edge) => edge.opposite(),
        None if vertical => {
            let room_left = full.x - area.x;
            let room_right = area.right() - full.right();
            if room_right >= room_left { Edge::Right } else { Edge::Left }
        }
        None => {
            let room_above = full.y - area.y;
            let room_below = area.bottom() - full.bottom();
            if room_above >= room_below { Edge::Top } else { Edge::Bottom }
        }
    };

    // The window: the fully expanded rail, plus the bubble's reach on its side and past both
    // ends. Everything outside the painted shapes is click-through.
    let reach = DETAIL_GAP + if vertical { DETAIL_WIDTH } else { DETAIL_MAX_HEIGHT };
    let mut window = if vertical {
        Rect { x: full.x, y: full.y - DETAIL_OVERHANG, w: full.w, h: full.h + DETAIL_OVERHANG * 2 }
    } else {
        Rect { x: full.x - DETAIL_OVERHANG, y: full.y, w: full.w + DETAIL_OVERHANG * 2, h: full.h }
    };
    match bubble_side {
        Edge::Left => {
            window.x -= reach;
            window.w += reach;
        }
        Edge::Right => window.w += reach,
        Edge::Top => {
            window.y -= reach;
            window.h += reach;
        }
        Edge::Bottom => window.h += reach,
    }
    let window = window.fit_within(&area);

    let rows_start = match anchor {
        Anchor::Start => rail_start + pad,
        Anchor::End => rail_start + rail_len - pad - rows_extent(shown_rows),
    };
    let detail = request.detail.map(|d| {
        let w = DETAIL_WIDTH.min(window.w);
        let h = d.height.clamp(1, DETAIL_MAX_HEIGHT).min(window.h);
        let row_mid = rows_start + d.row as i32 * (ROW_HEIGHT + ROW_SPACING) + ROW_HEIGHT / 2;
        let desired = match bubble_side {
            Edge::Left => Rect { x: rail.x - DETAIL_GAP - w, y: row_mid - h / 2, w, h },
            Edge::Right => Rect { x: rail.right() + DETAIL_GAP, y: row_mid - h / 2, w, h },
            Edge::Top => Rect { x: row_mid - w / 2, y: rail.y - DETAIL_GAP - h, w, h },
            Edge::Bottom => Rect { x: row_mid - w / 2, y: rail.bottom() + DETAIL_GAP, w, h },
        };
        let placed = desired.fit_within(&window);
        let tail = if vertical { row_mid - placed.y } else { row_mid - placed.x };
        (placed, tail)
    });

    DockFrame {
        window,
        rows_start,
        rows: shown_rows,
        rail: rail.offset(-window.x, -window.y),
        edge,
        vertical,
        docked,
        along_pad: pad,
        anchor,
        bubble_side,
        detail: detail.map(|(rect, tail)| {
            let local = rect.offset(-window.x, -window.y);
            DetailFrame { x: local.x, y: local.y, w: local.w, h: local.h, tail }
        }),
        native_pointer: cfg!(target_os = "windows"),
    }
}

/// The edge a rail this close to would snap to, and how far along the snap it is.
fn attachment_candidate(rail: &Rect, area: &Rect) -> Option<(Edge, f64)> {
    let distances = [
        (Edge::Left, (rail.x - area.x).abs()),
        (Edge::Right, (area.right() - rail.right()).abs()),
        (Edge::Top, (rail.y - area.y).abs()),
        (Edge::Bottom, (area.bottom() - rail.bottom()).abs()),
    ];
    let (edge, distance) = distances.into_iter().min_by_key(|(_, d)| *d)?;
    if distance > DOCK_SNAP_DISTANCE {
        return None;
    }
    Some((edge, (1.0 - distance as f64 / DOCK_SNAP_DISTANCE as f64).clamp(0.0, 1.0)))
}

/// Placement for a rail released at `rail`: docked when an edge is in reach, else floating
/// where it was dropped.
fn placement_for_drop(rail: &Rect, area: &Rect, current: &Placement) -> Placement {
    let docked = attachment_candidate(rail, area).map(|(edge, _)| edge);
    let attachment = docked.unwrap_or(current.attachment);
    let x_low = area.x + EDGE_INSET;
    let x_high = area.right() - EDGE_INSET - rail.w;
    let y_low = area.y + EDGE_INSET;
    let y_high = area.bottom() - EDGE_INSET - rail.h;
    Placement {
        docked,
        attachment,
        x: Some(normalize(rail.x, x_low, x_high)),
        y: Some(normalize(rail.y, y_low, y_high)),
    }
}

// Persistence -------------------------------------------------------------------------------

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

/// The dock's own preferences, which the settings window edits and the rail renders from.
/// `placement` is in here too, but it is written by dragging rather than by the settings, so
/// the settings window simply leaves the key alone.
pub fn read_prefs() -> serde_json::Map<String, serde_json::Value> {
    read_state()
}

pub fn patch_prefs(
    values: serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Map<String, serde_json::Value>> {
    let mut state = read_state();
    for (key, value) in values {
        if value.is_null() {
            state.remove(&key);
        } else {
            state.insert(key, value);
        }
    }
    write_state(&state)?;
    Ok(state)
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

/// The provider the resting rail shows. A click on another row makes it the preferred one.
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

fn load_placement() -> Placement {
    read_state()
        .get("placement")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

fn save_placement(placement: &Placement) -> Result<()> {
    let mut state = read_state();
    state.insert("placement".into(), serde_json::to_value(placement)?);
    write_state(&state)
}

// Live state --------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pointer {
    rail_hovered: bool,
    row: Option<u32>,
    detail_hovered: bool,
}

#[derive(Clone, Copy, Debug)]
struct Drag {
    /// Cursor offset from the window origin at grab time, logical pixels.
    anchor: (i32, i32),
    last: Option<(Edge, f64)>,
}

#[derive(Default)]
struct DockState {
    placement: Option<Placement>,
    request: LayoutRequest,
    frame: Option<DockFrame>,
    area: Rect,
    scale: f64,
    pointer: Pointer,
    ignoring: Option<bool>,
    drag: Option<Drag>,
}

static STATE: Mutex<DockState> = Mutex::new(DockState {
    placement: None,
    request: LayoutRequest { rows: 1, total_rows: 1, expanded: false, detail: None },
    frame: None,
    area: Rect { x: 0, y: 0, w: 0, h: 0 },
    scale: 1.0,
    pointer: Pointer { rail_hovered: false, row: None, detail_hovered: false },
    ignoring: None,
    drag: None,
});

fn lock() -> std::sync::MutexGuard<'static, DockState> {
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettledEvent {
    /// Where the rail was when the move began, relative to the new window.
    from: Rect,
    frame: DockFrame,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DragEvent {
    attachment: f64,
    edge: Option<Edge>,
}

fn work_area(window: &tauri::WebviewWindow) -> Option<(Rect, f64)> {
    let monitor = window.current_monitor().ok().flatten().or(window.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let logical = |v: i32| (v as f64 / scale).round() as i32;
    Some((
        Rect {
            x: logical(area.position.x),
            y: logical(area.position.y),
            w: logical(area.size.width as i32),
            h: logical(area.size.height as i32),
        },
        scale,
    ))
}

/// Size and position change together: two separate calls repaint twice, and between them the
/// rail would flash at the wrong offset inside the window.
#[cfg(target_os = "windows")]
fn move_window(window: &tauri::WebviewWindow, target: Rect, scale: f64) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
    let Ok(hwnd) = window.hwnd() else { return };
    let physical = |v: i32| (v as f64 * scale).round() as i32;
    unsafe {
        SetWindowPos(
            hwnd.0 as _,
            std::ptr::null_mut(),
            physical(target.x),
            physical(target.y),
            physical(target.w).max(1),
            physical(target.h).max(1),
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn move_window(window: &tauri::WebviewWindow, target: Rect, scale: f64) {
    let physical = |v: i32| (v as f64 * scale).round() as i32;
    let _ = window.set_size(tauri::PhysicalSize::new(physical(target.w).max(1) as u32, physical(target.h).max(1) as u32));
    let _ = window.set_position(tauri::PhysicalPosition::new(physical(target.x), physical(target.y)));
}

/// Recomputes the layout from the stored placement and request, moving the window only when
/// its rectangle actually changes.
fn relayout(window: &tauri::WebviewWindow) -> Option<DockFrame> {
    let (area, scale) = work_area(window)?;
    let mut state = lock();
    let placement = *state.placement.get_or_insert_with(load_placement);
    let frame = layout(area, &placement, &state.request);
    #[cfg(debug_assertions)]
    let (request_rows, request_total, request_expanded) = (state.request.rows, state.request.total_rows, state.request.expanded);
    let moved = state.frame.map(|f| f.window) != Some(frame.window);
    state.area = area;
    state.scale = scale;
    state.frame = Some(frame);
    drop(state);
    if moved {
        #[cfg(debug_assertions)]
        eprintln!(
            "codeburn dock: work_area={},{} {}x{} rows={} total={} expanded={} placement={:?} -> window {},{} {}x{}",
            area.x, area.y, area.w, area.h, request_rows, request_total, request_expanded, placement,
            frame.window.x, frame.window.y, frame.window.w, frame.window.h
        );
        move_window(window, frame.window, scale);
    }
    Some(frame)
}

/// Stores the page's request and returns the frames it paints into.
pub fn apply_layout(window: &tauri::WebviewWindow, request: LayoutRequest) -> Option<DockFrame> {
    lock().request = request;
    relayout(window)
}

/// Re-homes the rail after a drop or a menu choice and tells the page where it came from so
/// it can glide into place.
fn settle(app: &AppHandle, window: &tauri::WebviewWindow, placement: Placement, from_rail: Rect) {
    let _ = save_placement(&placement);
    {
        let mut state = lock();
        state.placement = Some(placement);
        state.request.detail = None;
        state.drag = None;
    }
    if let Some(frame) = relayout(window) {
        let event = SettledEvent {
            from: from_rail.offset(-frame.window.x, -frame.window.y),
            frame,
        };
        let _ = app.emit_to(DOCK_LABEL, "codeburn://dock-settled", event);
    }
}

fn current_rail_screen(state: &DockState) -> Option<Rect> {
    let frame = state.frame?;
    Some(frame.rail.offset(frame.window.x, frame.window.y))
}

/// Context-menu docking: keeps the along-axis offset, moves to the chosen edge.
pub fn dock_to(app: &AppHandle, edge: Edge) {
    let Some(window) = app.get_webview_window(DOCK_LABEL) else { return };
    let (placement, from) = {
        let state = lock();
        let Some(from) = current_rail_screen(&state) else { return };
        let current = state.placement.unwrap_or_default();
        (
            Placement {
                docked: Some(edge),
                attachment: edge,
                ..current
            },
            from,
        )
    };
    settle(app, &window, placement, from);
}

/// Starts following the cursor. The page calls this once its own drag threshold is passed,
/// with the press point in window coordinates so the rail stays exactly where it was grabbed.
pub fn begin_drag(app: &AppHandle, anchor: (i32, i32)) {
    let Some(window) = app.get_webview_window(DOCK_LABEL) else { return };
    let mut state = lock();
    let Some(frame) = state.frame else { return };
    state.drag = Some(Drag { anchor, last: None });
    state.request.detail = None;
    drop(state);
    let _ = window.set_ignore_cursor_events(false);
    let _ = app.emit_to(DOCK_LABEL, "codeburn://dock-drag", DragEvent { attachment: if frame.docked { 1.0 } else { 0.0 }, edge: None });
}

#[cfg(target_os = "windows")]
fn cursor_position() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
}

#[cfg(not(target_os = "windows"))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}

#[cfg(target_os = "windows")]
fn primary_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    (unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16) & 0x8000 != 0
}

#[cfg(not(target_os = "windows"))]
fn primary_button_down() -> bool {
    false
}

/// One tick of pointer tracking: drives a drag in progress, else hit-tests the painted
/// shapes for hover and click-through.
fn pointer_tick(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Some((cx, cy)) = cursor_position() else { return };
    let mut state = lock();
    let scale = state.scale;
    let cursor = ((cx as f64 / scale).round() as i32, (cy as f64 / scale).round() as i32);
    let Some(frame) = state.frame else { return };
    let area = state.area;

    if let Some(drag) = state.drag {
        if !primary_button_down() {
            let rail = frame.rail.offset(frame.window.x, frame.window.y);
            let placement = placement_for_drop(&rail, &area, &state.placement.unwrap_or_default());
            drop(state);
            settle(app, window, placement, rail);
            return;
        }
        // The rail, not the window, is what stays on screen.
        let mut origin = (cursor.0 - drag.anchor.0, cursor.1 - drag.anchor.1);
        let rail_x = (origin.0 + frame.rail.x).clamp(area.x, area.right() - frame.rail.w);
        let rail_y = (origin.1 + frame.rail.y).clamp(area.y, area.bottom() - frame.rail.h);
        origin = (rail_x - frame.rail.x, rail_y - frame.rail.y);
        let rail = Rect { x: rail_x, y: rail_y, w: frame.rail.w, h: frame.rail.h };
        let candidate = attachment_candidate(&rail, &area);
        let progress = candidate.map(|(_, p)| p).unwrap_or(0.0);
        let key = candidate.map(|(edge, p)| (edge, (p * 100.0).round() / 100.0));
        let moved = (origin.0, origin.1) != (frame.window.x, frame.window.y);
        if moved {
            let mut next = frame;
            next.window.x = origin.0;
            next.window.y = origin.1;
            state.frame = Some(next);
        }
        let changed = key != drag.last;
        if changed {
            state.drag = Some(Drag { last: key, ..drag });
        }
        drop(state);
        if moved {
            move_window(window, Rect { x: origin.0, y: origin.1, ..frame.window }, scale);
        }
        if changed {
            let _ = app.emit_to(
                DOCK_LABEL,
                "codeburn://dock-drag",
                DragEvent { attachment: progress, edge: candidate.map(|(e, _)| e) },
            );
        }
        return;
    }

    let rail = frame.rail.offset(frame.window.x, frame.window.y);
    let rail_hovered = rail.contains(cursor.0, cursor.1);
    let row = rail_hovered.then(|| {
        let along = if frame.vertical { cursor.1 } else { cursor.0 } - frame.rows_start;
        if along < 0 {
            return None;
        }
        let period = ROW_HEIGHT + ROW_SPACING;
        let slot = along / period;
        (slot < frame.rows as i32 && along - slot * period < ROW_HEIGHT).then_some(slot as u32)
    }).flatten();
    let detail_hovered = frame
        .detail
        .map(|d| Rect { x: d.x, y: d.y, w: d.w, h: d.h }.offset(frame.window.x, frame.window.y).contains(cursor.0, cursor.1))
        .unwrap_or(false);
    let pointer = Pointer { rail_hovered, row, detail_hovered };
    let pointer_changed = pointer != state.pointer;
    state.pointer = pointer;
    // A press that began on the rail keeps the window's input while the button is held, so
    // the page sees the moves that decide whether it became a drag.
    let ignore = !(rail_hovered || detail_hovered) && !primary_button_down();
    let ignore_changed = state.ignoring != Some(ignore);
    state.ignoring = Some(ignore);
    drop(state);

    if ignore_changed {
        let _ = window.set_ignore_cursor_events(ignore);
    }
    if pointer_changed {
        let _ = app.emit_to(DOCK_LABEL, "codeburn://dock-pointer", pointer);
    }
}

/// Runs until the dock window is gone. Sixty reads of the cursor a second cost nothing
/// measurable, and they replace the DOM hover the click-through style would starve.
#[cfg(target_os = "windows")]
fn spawn_pointer_tracking(app: AppHandle) {
    std::thread::Builder::new()
        .name("codeburn-dock-pointer".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
            let Some(window) = app.get_webview_window(DOCK_LABEL) else { break };
            pointer_tick(&app, &window);
        })
        .ok();
}

pub fn show(app: &AppHandle) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(DOCK_LABEL) {
        existing.show()?;
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(app, DOCK_LABEL, WebviewUrl::default())
        .title("CodeBurn Capacity Dock")
        .inner_size(RAIL_WIDTH as f64, rail_length(1, RAIL_ALONG_PAD + FLARE_COMPENSATION) as f64)
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

    {
        let mut state = lock();
        *state = DockState::default();
        state.request = LayoutRequest { rows: 1, total_rows: 1, expanded: false, detail: None };
        state.scale = 1.0;
    }
    relayout(&window);
    window.show()?;
    #[cfg(target_os = "windows")]
    spawn_pointer_tracking(app.clone());
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

/// The rail's right-click menu, the mac dock's context menu. Menu events arrive in `lib.rs`
/// under the `dock_` ids.
pub fn popup_context_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{ContextMenu, Menu, MenuItem, Submenu};
    let Some(window) = app.get_webview_window(DOCK_LABEL) else {
        return Ok(());
    };
    let refresh = MenuItem::with_id(app, "dock_refresh", "Refresh", true, None::<&str>)?;
    let left = MenuItem::with_id(app, "dock_left", "Left", true, None::<&str>)?;
    let right = MenuItem::with_id(app, "dock_right", "Right", true, None::<&str>)?;
    let top = MenuItem::with_id(app, "dock_top", "Top", true, None::<&str>)?;
    let bottom = MenuItem::with_id(app, "dock_bottom", "Bottom", true, None::<&str>)?;
    let edges = Submenu::with_items(app, "Dock to Edge", true, &[&left, &right, &top, &bottom])?;
    let hide = MenuItem::with_id(app, "dock_hide", "Hide Capacity Dock", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&refresh, &edges, &hide])?;
    menu.popup(window.as_ref().window())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect { x: 0, y: 0, w: 1600, h: 852 };

    fn request(rows: u32, expanded: bool, detail: Option<DetailRequest>) -> LayoutRequest {
        LayoutRequest { rows, total_rows: rows, expanded, detail }
    }

    fn rail_on_screen(frame: &DockFrame) -> Rect {
        frame.rail.offset(frame.window.x, frame.window.y)
    }

    #[test]
    fn resting_rail_hugs_the_right_edge_below_the_default_offset() {
        let frame = layout(AREA, &Placement::default(), &request(1, false, None));
        assert_eq!(rail_on_screen(&frame), Rect { x: 1600 - RAIL_WIDTH, y: 156, w: RAIL_WIDTH, h: 112 });
        assert_eq!(frame.anchor, Anchor::Start);
        assert_eq!(frame.bubble_side, Edge::Left);
        assert!(frame.docked && frame.vertical);
        assert_eq!(frame.along_pad, 31);
        assert!(frame.detail.is_none());
    }

    #[test]
    fn the_window_is_sized_for_the_full_rail_and_the_bubble_and_does_not_move_on_hover() {
        let rest = layout(AREA, &Placement::default(), &LayoutRequest { rows: 1, total_rows: 3, expanded: false, detail: None });
        let expanded = layout(AREA, &Placement::default(), &LayoutRequest { rows: 3, total_rows: 3, expanded: true, detail: Some(DetailRequest { row: 0, height: 200 }) });
        assert_eq!(rest.window, expanded.window);
        assert_eq!(rest.window.right(), 1600);
        assert_eq!(rest.window.w, DETAIL_WIDTH + DETAIL_GAP + RAIL_WIDTH);
        // The overhang above the rail is cut by the top of the work area.
        assert_eq!(rest.window.y, 0);
        assert_eq!(rest.rail.y, 156);
        assert_eq!(rest.window.h, expanded.rail.h + DETAIL_OVERHANG * 2);
        assert_eq!(expanded.rail.h, 31 * 2 + 3 * 50 + 2 * 7);
    }

    #[test]
    fn a_short_work_area_anchors_at_the_end_and_grows_upward() {
        let area = Rect { x: 0, y: 0, w: 1280, h: 400 };
        let rest = layout(area, &Placement::default(), &request(1, false, None));
        let expanded = layout(area, &Placement::default(), &request(3, true, None));
        assert_eq!(rest.anchor, Anchor::End);
        assert_eq!(rail_on_screen(&expanded).bottom(), rail_on_screen(&rest).bottom());
        // A rail taller than the room above it is pushed down rather than off the screen.
        let oversized = layout(area, &Placement::default(), &request(6, true, None));
        assert_eq!(rail_on_screen(&oversized).y, area.y + EDGE_INSET);
    }

    #[test]
    fn detail_sits_left_of_the_rail_centred_on_its_row() {
        let frame = layout(AREA, &Placement::default(), &request(2, true, Some(DetailRequest { row: 1, height: 160 })));
        let detail = frame.detail.expect("detail frame");
        assert_eq!(detail.w, DETAIL_WIDTH);
        assert_eq!(detail.h, 160);
        assert_eq!(detail.x + detail.w + DETAIL_GAP, frame.rail.x);
        let row_mid = frame.rail.y + 31 + (ROW_HEIGHT + ROW_SPACING) + ROW_HEIGHT / 2;
        assert_eq!(detail.y + detail.h / 2, row_mid);
        assert_eq!(detail.tail, row_mid - detail.y);
    }

    #[test]
    fn a_top_docked_rail_is_horizontal_with_the_bubble_below() {
        let placement = Placement { docked: Some(Edge::Top), attachment: Edge::Top, x: None, y: None };
        let frame = layout(AREA, &placement, &request(2, true, Some(DetailRequest { row: 1, height: 120 })));
        assert!(!frame.vertical);
        assert_eq!(rail_on_screen(&frame).y, 0);
        assert_eq!(frame.rail.h, HORIZONTAL_RAIL_WIDTH);
        assert_eq!(frame.rail.w, 31 * 2 + 2 * 50 + 7);
        assert_eq!(frame.bubble_side, Edge::Bottom);
        let detail = frame.detail.expect("detail frame");
        assert_eq!(detail.y, frame.rail.y + frame.rail.h + DETAIL_GAP);
        let row_mid = frame.rail.x + 31 + (ROW_HEIGHT + ROW_SPACING) + ROW_HEIGHT / 2;
        assert_eq!(detail.x + detail.w / 2, row_mid);
    }

    #[test]
    fn a_top_rail_in_the_corner_keeps_its_window_inside_the_work_area() {
        let placement = Placement { docked: Some(Edge::Top), attachment: Edge::Top, x: Some(0.986), y: Some(0.0) };
        for expanded in [false, true] {
            let frame = layout(AREA, &placement, &LayoutRequest { rows: 1, total_rows: 1, expanded, detail: None });
            let rail = rail_on_screen(&frame);
            assert_eq!(rail, Rect { x: 1456, y: 0, w: 112, h: HORIZONTAL_RAIL_WIDTH });
            assert_eq!(frame.window.right(), 1600);
            assert_eq!(frame.window.x, 1600 - (112 + DETAIL_OVERHANG * 2));
            assert!(frame.rail.x + frame.rail.w <= frame.window.w);
        }
    }

    #[test]
    fn a_floating_rail_keeps_its_orientation_and_the_short_padding() {
        let placement = Placement { docked: None, attachment: Edge::Right, x: Some(0.5), y: Some(0.5) };
        let frame = layout(AREA, &placement, &request(1, false, None));
        assert!(frame.vertical && !frame.docked);
        assert_eq!(frame.along_pad, 12);
        assert_eq!(frame.rail.h, 12 * 2 + 50);
        let rail = rail_on_screen(&frame);
        assert!(rail.x > 100 && rail.right() < 1500);
    }

    #[test]
    fn a_drop_near_an_edge_docks_and_elsewhere_floats() {
        let current = Placement::default();
        let near_left = placement_for_drop(&Rect { x: 20, y: 300, w: 53, h: 112 }, &AREA, &current);
        assert_eq!(near_left.docked, Some(Edge::Left));
        assert_eq!(near_left.attachment, Edge::Left);
        let near_top = placement_for_drop(&Rect { x: 700, y: 10, w: 53, h: 112 }, &AREA, &current);
        assert_eq!(near_top.docked, Some(Edge::Top));
        let middle = placement_for_drop(&Rect { x: 700, y: 300, w: 53, h: 112 }, &AREA, &current);
        assert_eq!(middle.docked, None);
        assert_eq!(middle.attachment, Edge::Right);
        assert!((middle.x.unwrap() - 0.45).abs() < 0.05);
    }

    #[test]
    fn attachment_progress_rises_as_the_edge_nears() {
        let far = attachment_candidate(&Rect { x: 700, y: 300, w: 53, h: 112 }, &AREA);
        assert!(far.is_none());
        let (edge, progress) = attachment_candidate(&Rect { x: 1600 - 53 - 22, y: 300, w: 53, h: 112 }, &AREA).unwrap();
        assert_eq!(edge, Edge::Right);
        assert!((progress - 0.5).abs() < 0.01);
    }
}
