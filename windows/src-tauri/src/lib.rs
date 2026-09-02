mod autostart;
mod cli;
mod config;
mod dock;
mod fx;
mod plan;
mod settings;
/// The spend-in-the-tray badge is a second tray icon, which only the Tauri tray backend
/// provides; Linux runs its own SNI tray (`tray_linux`) and has no equivalent, so the
/// whole module is compiled out there rather than sitting unused.
#[cfg(not(target_os = "linux"))]
mod tray_badge;
#[cfg(target_os = "linux")]
mod tray_linux;
mod tray_status;

use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};

static LAST_HIDDEN_MS: AtomicI64 = AtomicI64::new(0);

use tauri::{AppHandle, Emitter, Manager, WindowEvent};
#[cfg(target_os = "linux")]
use tauri::Listener;

#[cfg(not(target_os = "linux"))]
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[cfg(not(target_os = "linux"))]
static DOCK_MENU_ITEM: std::sync::OnceLock<CheckMenuItem<tauri::Wry>> = std::sync::OnceLock::new();
#[cfg(not(target_os = "linux"))]
static USAGE_MENU_ITEM: std::sync::OnceLock<MenuItem<tauri::Wry>> = std::sync::OnceLock::new();

use crate::cli::CodeburnCli;
use crate::config::CurrencyConfig;
use crate::fx::FxCache;

#[cfg(not(target_os = "linux"))]
const TRAY_ID: &str = "codeburn-tray";
/// Second tray icon that carries today's spend as text, sitting next to the logo. The
/// closest the Windows notification area gets to the macOS menubar title.
#[cfg(not(target_os = "linux"))]
const BADGE_TRAY_ID: &str = "codeburn-badge";
const POPOVER_LABEL: &str = "popover";

/// Shared application state. Wraps the CLI handle + currency config + FX cache so every
/// Tauri command sees the same instances. Interior Mutex keeps things simple; the state is
/// touched from the main thread (UI) and the Tokio runtime (CLI spawn, HTTP), both of
/// which go through `#[tauri::command]` async functions that acquire the lock briefly.
pub struct AppState {
    pub cli: Mutex<CodeburnCli>,
    pub config: Mutex<CurrencyConfig>,
    pub fx: FxCache,
    pub plan: plan::PlanClient,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered before any other plugin so it can intercept a second launch.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_popover(app, None);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(AppState {
                cli: Mutex::new(CodeburnCli::resolve()),
                config: Mutex::new(CurrencyConfig::load_or_default()),
                fx: FxCache::new(),
                plan: plan::PlanClient::new(),
            });

            #[cfg(all(debug_assertions, target_os = "windows"))]
            warn_if_window_station_hidden();

            #[cfg(not(target_os = "linux"))]
            {
                build_tray_tauri(app.handle())?;
                restore_tray_status(app.handle());
            }

            #[cfg(target_os = "linux")]
            init_tray_linux(app.handle().clone(), tray_linux::LinuxTrayHandle::empty());

            if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
                let _ = window.hide();
                #[cfg(target_os = "windows")]
                strip_window_frame(&window);
            }

            if dock::is_enabled() {
                if let Err(err) = dock::show(app.handle()) {
                    eprintln!("codeburn: failed to show the Capacity Dock: {err}");
                }
            }

            Ok(())
        })
        // The dock's right-click menu pops up from `dock::popup_context_menu`; its items report
        // here rather than to the tray handler.
        .on_menu_event(|app, event| match event.id.as_ref() {
            "dock_refresh" => {
                if let Some(window) = app.get_webview_window(dock::DOCK_LABEL) {
                    let _ = window.emit("codeburn://dock-refresh", ());
                }
            }
            "dock_hide" => set_dock_enabled(app, false),
            "dock_left" => dock::dock_to(app, dock::Edge::Left),
            "dock_right" => dock::dock_to(app, dock::Edge::Right),
            "dock_top" => dock::dock_to(app, dock::Edge::Top),
            "dock_bottom" => dock::dock_to(app, dock::Edge::Bottom),
            _ => {}
        })
        .on_window_event(|window, event| {
            // The dock is a persistent rail: it owns its own lifecycle and must survive both
            // the hide-on-blur and the hide-on-close that keep the popover alive. The
            // settings window is an ordinary window: it stays put when it loses focus, and
            // closing it destroys it rather than parking a webview nobody can see.
            if window.label() == dock::DOCK_LABEL || window.label() == settings::SETTINGS_LABEL {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    mark_hidden(window.app_handle());
                }
                WindowEvent::Focused(false) => {
                    let _ = window.hide();
                    mark_hidden(window.app_handle());
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::fetch_payload,
            commands::cli_status,
            commands::daily_budget,
            commands::currency,
            commands::set_currency,
            commands::open_terminal_command,
            commands::open_claude_login,
            commands::quit_app,
            commands::hide_popover,
            commands::set_tray_tooltip,
            commands::set_tray_badge,
            commands::set_tray_severity,
            commands::set_tray_usage,
            commands::app_version,
            commands::plan_usage,
            commands::launch_at_login,
            commands::set_launch_at_login,
            commands::dock_quota,
            commands::dock_set_layout,
            commands::dock_preferred,
            commands::dock_set_preferred,
            commands::dock_context_menu,
            commands::dock_begin_drag,
            commands::dock_prefs,
            commands::set_dock_prefs,
            commands::open_settings_window,
            commands::settings_section,
            commands::settings_load,
            commands::settings_patch,
            commands::claude_config_dirs,
            commands::set_claude_config_dirs,
            commands::daily_budgets,
            commands::set_daily_budget,
            commands::provider_key_providers,
            commands::set_provider_key,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // `code` is `None` only when the last window closed on its own; an explicit
            // `app.exit(..)` (tray Quit, `commands::quit_app`) always carries `Some(_)` and
            // must be allowed through, or Quit does nothing.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(not(target_os = "linux"))]
fn build_tray_tauri(app: &AppHandle) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };

    // Disabled by design: the mac's menu opens with what today cost, which is the one thing
    // worth knowing without opening anything. The frontend fills it in on every refresh.
    let usage = MenuItem::with_id(app, "usage", "Today", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open CodeBurn", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
    let theme = MenuItem::with_id(app, "toggle_theme", "Toggle Dark/Light", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let dock_settings = MenuItem::with_id(
        app,
        "dock_settings",
        "Capacity Dock Settings...",
        true,
        None::<&str>,
    )?;
    let capacity_dock = CheckMenuItem::with_id(
        app,
        "toggle_dock",
        "Show Capacity Dock",
        true,
        dock::is_enabled(),
        None::<&str>,
    )?;
    let report = MenuItem::with_id(app, "report", "Open Full Report", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "About CodeBurn", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit CodeBurn", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &usage,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &refresh,
            &theme,
            &settings,
            &dock_settings,
            &capacity_dock,
            &report,
            &PredefinedMenuItem::separator(app)?,
            &about,
            &quit,
        ],
    )?;
    // Both tray icons share one menu, so the handler needs the items themselves to keep the
    // checkmark in step with the persisted state and the usage row in step with the payload.
    let _ = DOCK_MENU_ITEM.set(capacity_dock);
    let _ = USAGE_MENU_ITEM.set(usage);

    tray.set_menu(Some(menu.clone()))?;
    tray.set_show_menu_on_left_click(false)?;
    let _ = tray.set_tooltip(Some("CodeBurn"));
    tray.on_menu_event(on_tray_menu_event);
    tray.on_tray_icon_event(on_tray_icon_event);

    // The badge icon starts fully transparent and hidden; the frontend shows it once it has
    // today's spend. Registering it right after the logo puts it beside the logo in the tray.
    let blank = tauri::image::Image::new_owned(
        vec![0u8; (BLANK_ICON_SIZE * BLANK_ICON_SIZE * 4) as usize],
        BLANK_ICON_SIZE,
        BLANK_ICON_SIZE,
    );
    TrayIconBuilder::with_id(BADGE_TRAY_ID)
        .icon(blank)
        .tooltip("CodeBurn")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_tray_menu_event)
        .on_tray_icon_event(on_tray_icon_event)
        .build(app)?
        .set_visible(false)?;

    Ok(())
}

#[cfg(not(target_os = "linux"))]
const BLANK_ICON_SIZE: u32 = 16;

#[cfg(not(target_os = "linux"))]
fn on_tray_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        "quit" => app.exit(0),
        "open" => show_popover(app, None),
        "refresh" => {
            if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
                let _ = window.emit("codeburn://refresh", ());
            }
        }
        "toggle_theme" => {
            if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
                let _ = window.emit("codeburn://toggle-theme", ());
            }
        }
        "toggle_dock" => set_dock_enabled(app, !dock::is_enabled()),
        // Deep links into the settings window: General, General scrolled to its Capacity
        // Dock section, and About, exactly as the mac's three menu items land.
        "settings" => open_settings(app, "general"),
        "dock_settings" => open_settings(app, "general#dock"),
        "about" => open_settings(app, "about"),
        "report" => {
            let _ = cli::spawn_in_terminal(app, &["report"]);
        }
        _ => {}
    }
}

/// Opens the settings window on a named pane. The popover is left alone: it hides itself on
/// blur, so the settings window taking focus is what closes it.
fn open_settings(app: &AppHandle, section: &str) {
    if let Err(err) = settings::open(app, Some(section)) {
        eprintln!("codeburn: failed to open the settings window: {err}");
    }
}

#[cfg(not(target_os = "linux"))]
fn on_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            position,
            ..
        }
        | TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            position,
            ..
        } => {
            toggle_popover(tray.app_handle(), Some((position.x as i32, position.y as i32)));
        }
        _ => {}
    }
}

#[cfg(target_os = "linux")]
fn init_tray_linux(app: AppHandle, handle: tray_linux::LinuxTrayHandle) {
    // Spawn the SNI tray on the Tokio runtime that Tauri already owns.
    let spawn_app = app.clone();
    let spawn_handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = tray_linux::spawn(spawn_app, spawn_handle).await {
            eprintln!("codeburn: failed to spawn Linux tray: {err}");
        }
    });

    // Left-click on the tray: show popover anchored to the click coordinates.
    let activate_app = app.clone();
    app.listen_any("codeburn://tray-activate", move |event| {
        let anchor = parse_click(event.payload());
        toggle_popover(&activate_app, anchor);
    });

    // Right-click / middle-click: same as left for now. Quit lives in the popover footer.
    let secondary_app = app.clone();
    app.listen_any("codeburn://tray-secondary", move |event| {
        let anchor = parse_click(event.payload());
        toggle_popover(&secondary_app, anchor);
    });
}

#[cfg(target_os = "linux")]
fn parse_click(payload: &str) -> Option<(i32, i32)> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let x = value.get("x")?.as_i64()? as i32;
    let y = value.get("y")?.as_i64()? as i32;
    Some((x, y))
}

/// A process started from a service session (the QEMU guest agent's guest-exec, SSH, a
/// scheduled task) gets a window station nobody is looking at: the tray icon and every window,
/// dock included, report success and never reach the desktop. That exact trace cost a full
/// debugging round on the VM, so debug builds now say so on startup.
#[cfg(all(debug_assertions, target_os = "windows"))]
fn warn_if_window_station_hidden() {
    use windows_sys::Win32::System::StationsAndDesktops::{
        GetProcessWindowStation, GetUserObjectInformationW, UOI_FLAGS, USEROBJECTFLAGS,
    };
    const WSF_VISIBLE: u32 = 0x0001;

    let mut flags = USEROBJECTFLAGS {
        fInherit: 0,
        fReserved: 0,
        dwFlags: 0,
    };
    let mut needed = 0u32;
    let ok = unsafe {
        GetUserObjectInformationW(
            GetProcessWindowStation(),
            UOI_FLAGS,
            &mut flags as *mut USEROBJECTFLAGS as *mut std::ffi::c_void,
            std::mem::size_of::<USEROBJECTFLAGS>() as u32,
            &mut needed,
        )
    };
    if ok != 0 && flags.dwFlags & WSF_VISIBLE == 0 {
        eprintln!(
            "codeburn: running on a non-interactive window station (service session launch); \
             the tray icon and windows will never appear on the desktop"
        );
    }
}

/// The popover window paints nothing of its own: it is transparent, and the rounded card
/// inside it is the whole visible shape. So DWM has to keep its hands off the frame. Its
/// own rounding clips at the system radius rather than the card radius, and the 1 px
/// frame it draws around a rounded window traces that wrong shape in grey just outside
/// the card.
#[cfg(target_os = "windows")]
fn strip_window_frame(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMWCP_DONOTROUND,
    };
    /// DWMWA_COLOR_NONE: suppress the border rather than tint it.
    const COLOR_NONE: u32 = 0xFFFF_FFFE;
    let Ok(hwnd) = window.hwnd() else { return };
    let preference: u32 = DWMWCP_DONOTROUND as u32;
    // Both are no-ops before Windows 11 build 22000, where the frame is square anyway.
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &preference as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_BORDER_COLOR as u32,
            &COLOR_NONE as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

/// Both tray icons carry the same tooltip, so the number is there whichever one the pointer
/// lands on.
fn apply_tray_tooltip(app: &AppHandle, text: &str) {
    #[cfg(not(target_os = "linux"))]
    for id in [TRAY_ID, BADGE_TRAY_ID] {
        if let Some(tray) = app.tray_by_id(id) {
            let _ = tray.set_tooltip(Some(text));
        }
    }
    #[cfg(target_os = "linux")]
    let _ = (app, text);
}

/// `text` is a short spend string ("$87", "142", "1.2K"); `None` hides the badge icon.
#[cfg(not(target_os = "linux"))]
fn apply_tray_badge(app: &AppHandle, text: Option<&str>) -> Result<(), String> {
    let Some(badge) = app.tray_by_id(BADGE_TRAY_ID) else {
        return Ok(());
    };
    match text.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => {
            let icon = tray_badge::render(
                t,
                tray_badge::small_icon_size(),
                tray_badge::taskbar_is_dark(),
            );
            // Windows can only modify an icon that is currently shown, so show first
            // (re-adds the previous bitmap) and then swap the bitmap.
            badge.set_visible(true).map_err(|e| e.to_string())?;
            badge.set_icon(Some(icon)).map_err(|e| e.to_string())?;
        }
        None => {
            badge.set_visible(false).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn apply_tray_tint(app: &AppHandle, tint: Option<[u8; 3]>) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let icon = tray_status::tray_icon(tint).map_err(|e| e.to_string())?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn apply_tray_tint(app: &AppHandle, tint: Option<[u8; 3]>) -> Result<(), String> {
    let _ = (app, tint);
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn set_tray_usage_text(text: &str) {
    if let Some(item) = USAGE_MENU_ITEM.get() {
        let _ = item.set_text(text);
    }
}

#[cfg(target_os = "linux")]
fn set_tray_usage_text(text: &str) {
    let _ = text;
}

/// How long a persisted badge is worth showing after a relaunch, from the mac's
/// MenubarStatusCache. Past that the tray stays blank until the first CLI answer rather than
/// quoting a figure that may be hours old.
const STATUS_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(600);

/// Puts the last known badge and tooltip back before the first refresh lands, so a relaunch
/// does not blank the tray for the length of a CLI round trip.
#[cfg(not(target_os = "linux"))]
fn restore_tray_status(app: &AppHandle) {
    let Some(status) = tray_status::read_status(STATUS_MAX_AGE) else {
        return;
    };
    if let Some(tooltip) = status.tooltip.as_deref() {
        apply_tray_tooltip(app, tooltip);
    }
    if let Some(badge) = status.badge.as_deref() {
        let _ = apply_tray_badge(app, Some(badge));
    }
}

/// A blur immediately followed by the tray click that caused it would re-open the popover;
/// ignore show requests inside this window after a hide.
const TOGGLE_DEBOUNCE_MS: i64 = 300;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Every path that hides the popover goes through here, so the debounce stamp and the
/// frontend's visibility signal can never drift apart. The frontend drops to its idle
/// refresh cadence on `codeburn://hidden` and comes back on `codeburn://shown`.
fn mark_hidden(app: &AppHandle) {
    LAST_HIDDEN_MS.store(now_ms(), Ordering::Relaxed);
    let _ = app.emit("codeburn://hidden", ());
}

/// Persists the dock preference, then brings the window in line with it. The checkmark is only
/// moved once the state is stored, so a failed write cannot leave the menu lying.
fn set_dock_enabled(app: &AppHandle, enabled: bool) {
    if let Err(err) = dock::set_enabled(enabled) {
        eprintln!("codeburn: failed to persist the Capacity Dock setting: {err}");
        return;
    }
    if enabled {
        if let Err(err) = dock::show(app) {
            eprintln!("codeburn: failed to show the Capacity Dock: {err}");
        }
    } else {
        dock::hide(app);
    }
    #[cfg(not(target_os = "linux"))]
    if let Some(item) = DOCK_MENU_ITEM.get() {
        let _ = item.set_checked(enabled);
    }
}

fn toggle_popover(app: &AppHandle, anchor: Option<(i32, i32)>) {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        mark_hidden(app);
        return;
    }
    let last = LAST_HIDDEN_MS.load(Ordering::Relaxed);
    if now_ms() - last < TOGGLE_DEBOUNCE_MS {
        return;
    }
    show_popover(app, anchor);
}

fn show_popover(app: &AppHandle, anchor: Option<(i32, i32)>) {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        return;
    };
    // Position before showing so the first frame is already in place (no jump).
    position_popover(&window, anchor);
    let _ = window.show();
    let _ = window.unminimize();
    position_popover(&window, anchor);
    let _ = window.set_focus();
    let _ = window.emit("codeburn://shown", ());
}

/// Places the popover against the taskbar / panel edge of the monitor that owns the click
/// (or the cursor, when the request came from a menu). The work area already excludes the
/// taskbar on Windows and panels on Linux, so we never need to guess their heights: the
/// card sits `GUTTER` inside the work area, horizontally centred on the anchor and
/// clamped to the screen.
fn position_popover(window: &tauri::WebviewWindow, anchor: Option<(i32, i32)>) {
    const CARD_WIDTH_LOGICAL: f64 = 360.0;
    const CARD_HEIGHT_LOGICAL: f64 = 660.0;
    /// Transparent margin the page paints the card shadow into, and the gap the card
    /// keeps from the work-area edge. One value for both: the shadow needs the room and
    /// the card needs the inset, so the window edge is exactly where the inset ends.
    const GUTTER_LOGICAL: f64 = 12.0;
    const POPOVER_WIDTH_LOGICAL: f64 = CARD_WIDTH_LOGICAL + 2.0 * GUTTER_LOGICAL;
    const POPOVER_HEIGHT_LOGICAL: f64 = CARD_HEIGHT_LOGICAL + 2.0 * GUTTER_LOGICAL;
    const MARGIN_LOGICAL: f64 = 0.0;

    let point = anchor
        .filter(|(x, y)| *x > 0 || *y > 0)
        .map(|(x, y)| (x as f64, y as f64))
        .or_else(|| window.cursor_position().ok().map(|p| (p.x, p.y)));

    let monitor = point
        .and_then(|(x, y)| window.monitor_from_point(x, y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };

    let scale = monitor.scale_factor();
    let pop_w = (POPOVER_WIDTH_LOGICAL * scale).round() as i32;
    let pop_h = (POPOVER_HEIGHT_LOGICAL * scale).round() as i32;
    let margin = (MARGIN_LOGICAL * scale).round() as i32;

    let area = monitor.work_area();
    let area_x = area.position.x;
    let area_y = area.position.y;
    let area_w = area.size.width as i32;
    let area_h = area.size.height as i32;
    let screen = monitor.size();
    let screen_pos = monitor.position();

    let (anchor_x, anchor_y) = point
        .map(|(x, y)| (x as i32, y as i32))
        .unwrap_or((area_x + area_w - pop_w / 2 - margin, area_y + area_h));

    let min_x = area_x + margin;
    let max_x = (area_x + area_w - pop_w - margin).max(min_x);
    let x = (anchor_x - pop_w / 2).clamp(min_x, max_x);

    // Which edge holds the taskbar? Whichever side the work area was trimmed on. If the
    // taskbar is at the top (or the anchor is in the top half with no bottom taskbar) the
    // popover drops down from the top edge; otherwise it rises from the bottom edge.
    let trimmed_top = area_y > screen_pos.y;
    let trimmed_bottom = (area_y + area_h) < (screen_pos.y + screen.height as i32);
    let anchor_in_top_half = anchor_y < screen_pos.y + (screen.height as i32) / 2;
    let open_downward = trimmed_top || (!trimmed_bottom && anchor_in_top_half);

    let y = if open_downward {
        area_y + margin
    } else {
        (area_y + area_h - pop_h - margin).max(area_y + margin)
    };

    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

mod commands {
    use super::{AppState, POPOVER_LABEL};
    use serde_json::Value;
    use tauri::{AppHandle, Emitter, Manager, State};

    #[tauri::command]
    pub async fn fetch_payload(
        period: String,
        provider: String,
        days: Vec<String>,
        scope: String,
        claude_config_source: Option<String>,
        include_optimize: bool,
        state: State<'_, AppState>,
    ) -> Result<Value, String> {
        let cli = state.cli.lock().map_err(|e| e.to_string())?.clone();
        cli.fetch_menubar_payload(
            &period,
            &provider,
            &days,
            &scope,
            claude_config_source.as_deref(),
            include_optimize,
        )
            .await
            .map_err(|e| e.to_string())
    }

    /// Today spend limit from the CLI config, so the hero can warn on the same number the
    /// tray flame is tinted by. `None` means the alert is off.
    #[tauri::command]
    pub fn daily_budget() -> Option<f64> {
        crate::tray_status::daily_budget()
    }

    /// Re-resolves the CLI each call so a freshly installed `codeburn` is picked up
    /// without restarting the tray app.
    #[tauri::command]
    pub async fn cli_status(state: State<'_, AppState>) -> Result<crate::cli::CliStatus, String> {
        let fresh = crate::cli::CodeburnCli::resolve();
        let status = fresh.status().await;
        if status.found {
            if let Ok(mut guard) = state.cli.lock() {
                *guard = fresh;
            }
        }
        Ok(status)
    }

    /// The currency the CLI config names, with a live rate. Both windows ask for this on
    /// mount: without it the popover opened in dollars every launch however the currency was
    /// set, because nothing read the stored code back.
    #[tauri::command]
    pub async fn currency(state: State<'_, AppState>) -> Result<crate::fx::CurrencyApplied, String> {
        let code = crate::config::read()
            .get("currency")
            .and_then(|currency| currency.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("USD")
            .to_string();
        let usd = crate::fx::CurrencyApplied {
            code: "USD".into(),
            symbol: "$".into(),
            rate: 1.0,
        };
        if code == "USD" {
            return Ok(usd);
        }
        // No rate means no honest conversion, so the figures stay in the dollars the CLI
        // reports rather than being multiplied by a guess.
        match state.fx.rate_for(&code).await {
            Some(rate) => Ok(crate::fx::CurrencyApplied {
                symbol: crate::fx::symbol_for(&code),
                code,
                rate,
            }),
            None => Ok(usd),
        }
    }

    #[tauri::command]
    pub async fn set_currency(
        app: AppHandle,
        code: String,
        state: State<'_, AppState>,
    ) -> Result<crate::fx::CurrencyApplied, String> {
        let symbol = crate::fx::symbol_for(&code);
        let rate = state
            .fx
            .rate_for(&code)
            .await
            .ok_or_else(|| format!("Exchange rate for {code} is unavailable right now"))?;
        state
            .config
            .lock()
            .map_err(|e| e.to_string())?
            .set_currency(&code, &symbol)
            .map_err(|e| e.to_string())?;
        let applied = crate::fx::CurrencyApplied { code, symbol, rate };
        // The settings window and the popover both show money, and either can be the one
        // that changed it.
        let _ = app.emit("codeburn://currency-changed", &applied);
        Ok(applied)
    }

    #[tauri::command]
    pub fn open_terminal_command(app: AppHandle, args: Vec<String>) -> Result<(), String> {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::cli::spawn_in_terminal(&app, &args).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn open_claude_login(app: AppHandle) -> Result<(), String> {
        crate::cli::spawn_claude_login(&app).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn quit_app(app: AppHandle) {
        app.exit(0);
    }

    #[tauri::command]
    pub fn hide_popover(app: AppHandle) {
        if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
            let _ = window.hide();
            super::mark_hidden(&app);
        }
    }

    /// The tray cannot render text on Windows, so today's spend lives in the tooltip.
    #[tauri::command]
    pub fn set_tray_tooltip(app: AppHandle, text: String) {
        super::apply_tray_tooltip(&app, &text);
        let stored = text.clone();
        if let Err(err) = crate::tray_status::write_status(|status| status.tooltip = Some(stored)) {
            eprintln!("codeburn: failed to persist the tray tooltip: {err}");
        }
    }

    /// Tints the tray logo from the worst connected provider's quota severity, falling back
    /// to the daily-budget warning. `today_cost` is the figure the hero shows; the limit it
    /// is measured against is the CLI's own `dailyBudget`.
    #[tauri::command]
    pub fn set_tray_severity(
        app: AppHandle,
        severity: String,
        today_cost: Option<f64>,
    ) -> Result<(), String> {
        let severity = crate::tray_status::Severity::parse(&severity)
            .ok_or_else(|| format!("unknown quota severity `{severity}`"))?;
        let over_budget = match (today_cost, crate::tray_status::daily_budget()) {
            (Some(cost), Some(budget)) => cost >= budget,
            _ => false,
        };
        super::apply_tray_tint(&app, crate::tray_status::tint_for(severity, over_budget))
    }

    /// The usage row at the top of the tray menu: disabled, and there only to say what today
    /// cost without opening the popover.
    #[tauri::command]
    pub fn set_tray_usage(text: String) {
        super::set_tray_usage_text(&text);
    }

    /// `text` is a short spend string ("$87", "142", "1.2K"); `None` hides the badge icon.
    #[tauri::command]
    pub fn set_tray_badge(app: AppHandle, text: Option<String>) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            // Unreachable from the UI: the frontend hides the control wherever the badge is
            // unsupported (lib/platform.ts). Saying so beats reporting a success that never
            // happened.
            let _ = (app, text);
            Err("the tray spend badge needs a second tray icon, which the Linux SNI tray does not provide".to_string())
        }
        #[cfg(not(target_os = "linux"))]
        {
            let stored = text.clone();
            if let Err(err) = crate::tray_status::write_status(|status| status.badge = stored) {
                eprintln!("codeburn: failed to persist the tray badge: {err}");
            }
            super::apply_tray_badge(&app, text.as_deref())
        }
    }

    #[tauri::command]
    pub fn app_version(app: AppHandle) -> String {
        app.package_info().version.to_string()
    }

    #[tauri::command]
    pub fn launch_at_login() -> bool {
        crate::autostart::is_enabled()
    }

    #[tauri::command]
    pub fn set_launch_at_login(enabled: bool) -> Result<bool, String> {
        crate::autostart::set_enabled(enabled).map_err(|e| e.to_string())?;
        Ok(crate::autostart::is_enabled())
    }

    #[tauri::command]
    pub async fn plan_usage(state: State<'_, AppState>) -> Result<crate::plan::PlanUsage, String> {
        state.plan.fetch().await.map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn dock_quota(state: State<'_, AppState>) -> Result<crate::cli::DockQuota, String> {
        let cli = state.cli.lock().map_err(|e| e.to_string())?.clone();
        Ok(cli.fetch_quota().await)
    }

    /// The page only knows its row count, hover state and the bubble's measured height; the
    /// geometry that turns those into a window lives in `dock`. Synchronous on purpose: the
    /// replies must arrive in request order or a stale frame could land after a newer one.
    #[tauri::command]
    pub fn dock_set_layout(
        app: AppHandle,
        request: crate::dock::LayoutRequest,
    ) -> Result<crate::dock::DockFrame, String> {
        let window = app
            .get_webview_window(crate::dock::DOCK_LABEL)
            .ok_or_else(|| "dock window is not open".to_string())?;
        crate::dock::apply_layout(&window, request).ok_or_else(|| "no monitor".to_string())
    }

    /// The page decides when a press became a drag (3 px, as on the mac); from here the
    /// cursor poll moves the window and settles it on release.
    #[tauri::command]
    pub fn dock_begin_drag(app: AppHandle, x: i32, y: i32) {
        crate::dock::begin_drag(&app, (x, y));
    }

    #[tauri::command]
    pub fn dock_preferred() -> Option<String> {
        crate::dock::preferred_provider()
    }

    #[tauri::command]
    pub fn dock_set_preferred(id: String) -> Result<(), String> {
        crate::dock::set_preferred_provider(&id).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn dock_context_menu(app: AppHandle) -> Result<(), String> {
        crate::dock::popup_context_menu(&app).map_err(|e| e.to_string())
    }

    /// Everything the Capacity Dock reads out of `windows-dock.json`: whether it is on, its
    /// scale, appearance, gauge shape and provider set. One free-form object, so a new dock
    /// preference costs no Rust.
    #[tauri::command]
    pub fn dock_prefs() -> Value {
        Value::Object(crate::dock::read_prefs())
    }

    /// Writes dock preferences and brings the window in line with them. `enabled` is the one
    /// key with a side effect, since it creates or destroys the dock window; everything else
    /// only has to reach the page, which the event does.
    #[tauri::command]
    pub fn set_dock_prefs(
        app: AppHandle,
        patch: serde_json::Map<String, Value>,
    ) -> Result<Value, String> {
        let enabled = patch.get("enabled").and_then(Value::as_bool);
        let mut merged = crate::dock::patch_prefs(patch).map_err(|e| e.to_string())?;
        if let Some(enabled) = enabled {
            super::set_dock_enabled(&app, enabled);
            // `set_dock_enabled` persists the key itself, so read it back rather than
            // reporting the value we asked for and a failed write nobody saw.
            merged = crate::dock::read_prefs();
        }
        let value = Value::Object(merged);
        let _ = app.emit("codeburn://dock-settings-changed", &value);
        Ok(value)
    }

    /// The popover's More menu and the tray both come through here.
    #[tauri::command]
    pub fn open_settings_window(app: AppHandle, section: Option<String>) -> Result<(), String> {
        crate::settings::open(&app, section.as_deref()).map_err(|e| e.to_string())
    }

    /// The pane the window was opened on, asked for once by the page on mount. An event
    /// cannot do this job: it would be emitted while the webview is still loading.
    #[tauri::command]
    pub fn settings_section() -> Option<String> {
        crate::settings::take_pending_section()
    }

    #[tauri::command]
    pub fn settings_load() -> Value {
        Value::Object(crate::settings::read())
    }

    #[tauri::command]
    pub fn settings_patch(
        app: AppHandle,
        patch: serde_json::Map<String, Value>,
    ) -> Result<Value, String> {
        let merged = crate::settings::patch(patch).map_err(|e| e.to_string())?;
        crate::settings::broadcast(&app, &merged);
        Ok(Value::Object(merged))
    }

    #[tauri::command]
    pub fn claude_config_dirs() -> Vec<String> {
        crate::settings::claude_config_dirs()
    }

    /// Persisted to the CLI's own config so every `codeburn` run honours the list, whether
    /// this app spawned it or the user typed it in a terminal.
    #[tauri::command]
    pub fn set_claude_config_dirs(app: AppHandle, dirs: Vec<String>) -> Result<Vec<String>, String> {
        crate::settings::set_claude_config_dirs(&dirs).map_err(|e| e.to_string())?;
        let stored = crate::settings::claude_config_dirs();
        let _ = app.emit("codeburn://claude-configs-changed", &stored);
        Ok(stored)
    }

    /// Both daily alert thresholds. `None` on either means that alert is off.
    #[tauri::command]
    pub fn daily_budgets() -> Value {
        serde_json::json!({
            "cost": crate::tray_status::daily_budget(),
            "tokens": crate::tray_status::daily_token_budget(),
        })
    }

    #[tauri::command]
    pub fn set_daily_budget(app: AppHandle, key: String, amount: Option<f64>) -> Result<(), String> {
        crate::settings::set_daily_budget(&key, amount).map_err(|e| e.to_string())?;
        let _ = app.emit("codeburn://budget-changed", daily_budgets());
        Ok(())
    }

    /// Which providers have a key stored, never the keys themselves.
    #[tauri::command]
    pub fn provider_key_providers() -> Vec<String> {
        crate::settings::stored_key_providers()
    }

    #[tauri::command]
    pub fn set_provider_key(provider: String, key: String) -> Result<Vec<String>, String> {
        crate::settings::set_provider_key(&provider, &key).map_err(|e| e.to_string())?;
        Ok(crate::settings::stored_key_providers())
    }
}
