//! What the machine is doing to the screen: is the session locked, are the displays off,
//! has it just woken. The Windows counterpart of the NSWorkspace observers in
//! `mac/.../CodeBurnApp.swift` (`screensDidSleep`, `screensDidWake`, `didWake`).
//!
//! Nobody can see the tray while the session is locked or the displays are asleep, and a
//! refresh there is a full Node process spent on nothing, so the background loop skips one.
//! Coming back is the opposite case: the figure on screen is as old as the sleep was long,
//! so a wake refreshes at once.
//!
//! The notifications need a window to be delivered to, so this owns a hidden one on a thread
//! of its own with its own message pump, the same shape as the dock's cursor thread. A
//! message-only window would not do: `WM_POWERBROADCAST` is not delivered to one.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::AppHandle;

static LOCKED: AtomicBool = AtomicBool::new(false);
static DISPLAY_OFF: AtomicBool = AtomicBool::new(false);
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemState {
    pub locked: bool,
    pub display_off: bool,
}

impl SystemState {
    /// True while nobody could see a refreshed figure even if one arrived.
    pub fn unattended(self) -> bool {
        self.locked || self.display_off
    }

    pub fn reason(self) -> Option<&'static str> {
        if self.locked {
            Some("locked")
        } else if self.display_off {
            Some("displayOff")
        } else {
            None
        }
    }
}

pub fn state() -> SystemState {
    SystemState {
        locked: LOCKED.load(Ordering::Relaxed),
        display_off: DISPLAY_OFF.load(Ordering::Relaxed),
    }
}

/// An open popover proves the screens are on and the session is unlocked, so it clears a
/// latched flag the same way the mac's `refreshPayloadForPopoverOpen` does. A missed
/// notification must never be able to suppress refreshes forever.
pub fn note_attended() {
    if state().unattended() {
        LOCKED.store(false, Ordering::Relaxed);
        DISPLAY_OFF.store(false, Ordering::Relaxed);
        publish(false);
    }
}

fn publish(woke: bool) {
    let current = state();
    #[cfg(debug_assertions)]
    eprintln!(
        "codeburn: system state locked={} display_off={} woke={woke}",
        current.locked, current.display_off
    );
    let Some(app) = APP.get() else { return };
    use tauri::Emitter;
    let _ = app.emit("codeburn://system-state", current);
    if woke {
        let _ = app.emit("codeburn://wake", current);
    }
}

fn set_locked(locked: bool) {
    if LOCKED.swap(locked, Ordering::Relaxed) == locked {
        return;
    }
    publish(!locked);
}

fn set_display_off(off: bool) {
    if DISPLAY_OFF.swap(off, Ordering::Relaxed) == off {
        return;
    }
    publish(!off);
}

pub fn start(app: &AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(target_os = "windows")]
    windows_impl::start();
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Power::{
        RegisterPowerSettingNotification, RegisterSuspendResumeNotification, POWERBROADCAST_SETTING,
    };
    use windows_sys::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows_sys::Win32::System::SystemServices::GUID_CONSOLE_DISPLAY_STATE;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, DEVICE_NOTIFY_WINDOW_HANDLE, MSG, PBT_APMRESUMEAUTOMATIC,
        PBT_APMRESUMESUSPEND, PBT_POWERSETTINGCHANGE, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE,
        WNDCLASSW, WS_OVERLAPPED, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
    };

    /// `GUID_CONSOLE_DISPLAY_STATE` payload: 0 off, 1 on, 2 dimmed. Dimmed is still visible.
    const DISPLAY_OFF: u8 = 0;

    pub fn start() {
        let _ = std::thread::Builder::new()
            .name("codeburn-system".into())
            .spawn(run);
    }

    fn run() {
        let class: Vec<u16> = "CodeBurnSystemWatcher\0".encode_utf16().collect();
        unsafe {
            let instance = GetModuleHandleW(null());
            let mut class_def: WNDCLASSW = std::mem::zeroed();
            class_def.lpfnWndProc = Some(wndproc);
            class_def.hInstance = instance;
            class_def.lpszClassName = class.as_ptr();
            if RegisterClassW(&class_def) == 0 {
                eprintln!("codeburn: could not register the system watcher window class");
                return;
            }
            // Never shown and never sized: the window exists only as the address the session
            // and power notifications are delivered to.
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                null_mut(),
                null_mut(),
                instance,
                null(),
            );
            if hwnd.is_null() {
                eprintln!("codeburn: could not create the system watcher window");
                return;
            }
            if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) == 0 {
                eprintln!("codeburn: session lock notifications are unavailable");
            }
            // Display state covers the case system sleep does not: the screens go off on
            // their own timer while the machine keeps running.
            if RegisterPowerSettingNotification(
                hwnd,
                &GUID_CONSOLE_DISPLAY_STATE,
                DEVICE_NOTIFY_WINDOW_HANDLE,
            ) == 0
            {
                eprintln!("codeburn: display state notifications are unavailable");
            }
            if RegisterSuspendResumeNotification(hwnd, DEVICE_NOTIFY_WINDOW_HANDLE) == 0 {
                eprintln!("codeburn: suspend and resume notifications are unavailable");
            }

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_WTSSESSION_CHANGE => match wparam as u32 {
                WTS_SESSION_LOCK => super::set_locked(true),
                WTS_SESSION_UNLOCK => super::set_locked(false),
                _ => {}
            },
            WM_POWERBROADCAST => {
                match wparam as u32 {
                    PBT_POWERSETTINGCHANGE => {
                        let setting = lparam as *const POWERBROADCAST_SETTING;
                        if !setting.is_null()
                            && same_guid(&(*setting).PowerSetting, &GUID_CONSOLE_DISPLAY_STATE)
                            && (*setting).DataLength >= 1
                        {
                            super::set_display_off((*setting).Data[0] == DISPLAY_OFF);
                        }
                    }
                    // Both resume messages can arrive for one wake; publishing is idempotent
                    // and the page's own refresh is single-flighted.
                    PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => {
                        super::set_display_off(false);
                        super::publish(true);
                    }
                    _ => {}
                }
                return 1;
            }
            _ => {}
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    fn same_guid(a: &windows_sys::core::GUID, b: &windows_sys::core::GUID) -> bool {
        a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unattended_machine_names_the_reason_that_made_it_so() {
        let awake = SystemState {
            locked: false,
            display_off: false,
        };
        assert!(!awake.unattended());
        assert_eq!(awake.reason(), None);

        let locked = SystemState {
            locked: true,
            display_off: false,
        };
        assert!(locked.unattended());
        assert_eq!(locked.reason(), Some("locked"));

        let dark = SystemState {
            locked: false,
            display_off: true,
        };
        assert!(dark.unattended());
        assert_eq!(dark.reason(), Some("displayOff"));
    }
}
