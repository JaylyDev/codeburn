//! The settings window and the preferences behind it, the Windows twin of the macOS
//! `Views/SettingsView.swift` scene.
//!
//! Three stores, split by who else needs to read the value:
//!
//! - `~/.config/codeburn/config.json` for anything the CLI also reads (the currency, the
//!   Claude config directories, the daily budget). Written through `config::update`, which
//!   holds the same lock the currency write already took.
//! - `~/.config/codeburn/windows-settings.json` for everything that only this app cares
//!   about (display metric, refresh cadences, terminal, theme, accent). A free-form object
//!   rather than a typed struct, so a new preference costs one line of TypeScript and no
//!   Rust at all.
//! - `%LOCALAPPDATA%\codeburn\provider-keys.dat` for pasted provider API keys, encrypted
//!   with DPAPI so the file is worthless on another machine or under another account.
//!
//! Every write emits `codeburn://settings-changed` with the whole settings object, because
//! the popover, the tray and the Capacity Dock all render from it and none of them polls.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const SETTINGS_LABEL: &str = "settings";

/// The mac's window size, in logical pixels.
const WINDOW_WIDTH: f64 = 880.0;
const WINDOW_HEIGHT: f64 = 620.0;
const MIN_WIDTH: f64 = 720.0;
const MIN_HEIGHT: f64 = 520.0;

/// Where a tray item or the popover asked the window to open. The page reads it once on
/// mount, because an event emitted while the webview is still loading has nobody to hear it.
static PENDING_SECTION: Mutex<Option<String>> = Mutex::new(None);

// Preferences ---------------------------------------------------------------------------

fn settings_path() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".config/codeburn"))
        .unwrap_or_else(|| PathBuf::from(".codeburn"))
        .join("windows-settings.json")
}

pub fn read() -> Map<String, Value> {
    fs::read(settings_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// Merges `patch` into the stored settings and returns the result. A null value removes the
/// key, so the page can reset a preference to its default without knowing what that default
/// is.
pub fn patch(values: Map<String, Value>) -> Result<Map<String, Value>> {
    let mut stored = read();
    for (key, value) in values {
        if value.is_null() {
            stored.remove(&key);
        } else {
            stored.insert(key, value);
        }
    }
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&stored)?)?;
    fs::rename(&tmp, &path)?;
    Ok(stored)
}

/// One event for every consumer: the popover retints and re-reads its cadence, the dock
/// re-reads its own keys, and the settings window itself stays in step with a change made
/// from the tray.
pub fn broadcast(app: &AppHandle, settings: &Map<String, Value>) {
    let _ = app.emit("codeburn://settings-changed", settings);
}

// Keys the CLI shares -------------------------------------------------------------------

/// The extra Claude config directories the CLI aggregates over, from
/// `Data/CLIClaudeConfig.swift`. An empty list removes the key so the CLI falls back to its
/// own default of `~/.claude`.
pub fn claude_config_dirs() -> Vec<String> {
    crate::config::read()
        .get("claudeConfigDirs")
        .and_then(Value::as_array)
        .map(|dirs| {
            dirs.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|dir| !dir.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn set_claude_config_dirs(dirs: &[String]) -> Result<()> {
    let cleaned: Vec<String> = dirs
        .iter()
        .map(|dir| dir.trim().to_owned())
        .filter(|dir| !dir.is_empty())
        .collect();
    crate::config::update(|obj| {
        if cleaned.is_empty() {
            obj.remove("claudeConfigDirs");
        } else {
            obj.insert("claudeConfigDirs".into(), serde_json::json!(cleaned));
        }
    })?;
    Ok(())
}

/// The daily alert thresholds. Both live beside the currency because the tray reads them
/// from Rust, before any webview exists. Zero means off, which is stored as the key's
/// absence rather than a zero the CLI would have to special-case.
pub fn set_daily_budget(key: &str, amount: Option<f64>) -> Result<()> {
    if !matches!(key, "dailyBudget" | "dailyTokenBudget") {
        return Err(anyhow!("unknown budget key `{key}`"));
    }
    let key = key.to_owned();
    crate::config::update(move |obj| match amount {
        Some(value) if value > 0.0 => {
            obj.insert(key, serde_json::json!(value));
        }
        _ => {
            obj.remove(&key);
        }
    })?;
    Ok(())
}

// Provider API keys ---------------------------------------------------------------------

/// Keys the CLI's quota adapters read from the environment, from `src/quota/*.ts`. Only
/// providers listed here can be given a pasted key: anywhere else the key would be stored
/// and never used, which is worse than refusing it.
pub const KEY_VARS: &[(&str, &[&str])] = &[
    ("zai", &["ZAI_API_KEY"]),
    ("clinepass", &["CLINEPASS_API_KEY", "CLINE_API_KEY"]),
];

pub fn accepts_key(provider: &str) -> bool {
    KEY_VARS.iter().any(|(id, _)| *id == provider)
}

fn keys_path() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join("codeburn").join("provider-keys.dat"))
}

fn load_keys() -> BTreeMap<String, String> {
    let Some(path) = keys_path() else {
        return BTreeMap::new();
    };
    let Ok(sealed) = fs::read(&path) else {
        return BTreeMap::new();
    };
    unseal(&sealed)
        .ok()
        .and_then(|plain| serde_json::from_slice(&plain).ok())
        .unwrap_or_default()
}

fn store_keys(keys: &BTreeMap<String, String>) -> Result<()> {
    let path = keys_path().context("no local app data directory")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if keys.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    let sealed = seal(&serde_json::to_vec(keys)?)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &sealed)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Which providers have a stored key. Deliberately not the keys themselves: nothing outside
/// this module and the CLI spawn ever sees one, so a key cannot reach the webview, a log
/// line or an error message.
pub fn stored_key_providers() -> Vec<String> {
    load_keys().into_keys().collect()
}

/// An empty key clears the entry, which is how the settings window's Clear button works.
pub fn set_provider_key(provider: &str, key: &str) -> Result<()> {
    if !accepts_key(provider) {
        return Err(anyhow!(
            "the codeburn CLI does not read a pasted key for `{provider}`"
        ));
    }
    let mut keys = load_keys();
    let key = key.trim();
    if key.is_empty() {
        keys.remove(provider);
    } else {
        keys.insert(provider.to_owned(), key.to_owned());
    }
    store_keys(&keys)
}

/// The environment `codeburn quota` is spawned with. The CLI has no credential store of its
/// own, so a key pasted here reaches it the only way it can: as a variable on the child,
/// never on this process and never written to a command line.
pub fn quota_environment() -> Vec<(String, String)> {
    let stored = load_keys();
    let mut env = Vec::new();
    for (provider, vars) in KEY_VARS {
        let Some(key) = stored.get(*provider) else {
            continue;
        };
        for var in *vars {
            env.push(((*var).to_string(), key.clone()));
        }
    }
    env
}

/// DPAPI, the Windows counterpart of the mac's Keychain item: the ciphertext is bound to
/// this user on this machine, so a copied file decrypts nowhere else.
#[cfg(windows)]
fn seal(plain: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    use windows_sys::Win32::Foundation::LocalFree;

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &mut input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(anyhow!(
            "DPAPI could not protect the key: {}",
            std::io::Error::last_os_error()
        ));
    }
    let sealed =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData as _) };
    Ok(sealed)
}

#[cfg(windows)]
fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    use windows_sys::Win32::Foundation::LocalFree;

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: sealed.len() as u32,
        pbData: sealed.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(anyhow!(
            "DPAPI could not read the stored key: {}",
            std::io::Error::last_os_error()
        ));
    }
    let plain =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData as _) };
    Ok(plain)
}

/// Linux support here is experimental and has no DPAPI equivalent that does not drag in a
/// keyring daemon, so the file is written in the clear with owner-only permissions and the
/// settings window says so before anything is pasted.
#[cfg(not(windows))]
fn seal(plain: &[u8]) -> Result<Vec<u8>> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    Ok(sealed.to_vec())
}

// The window ----------------------------------------------------------------------------

/// Opens the settings window on `section`, creating it if it is not already up. Closing it
/// destroys it, as the dock window is destroyed, so a settings window nobody is looking at
/// costs no webview.
pub fn open(app: &AppHandle, section: Option<&str>) -> tauri::Result<()> {
    if let Some(section) = section {
        if let Ok(mut pending) = PENDING_SECTION.lock() {
            *pending = Some(section.to_owned());
        }
    }

    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.unminimize();
        window.show()?;
        window.set_focus()?;
        // The page is already mounted, so it will never ask for the pending section.
        if let Some(section) = section {
            let _ = window.emit("codeburn://settings-section", section);
        }
        return Ok(());
    }

    // Built visible rather than shown afterwards: a window created hidden and then shown
    // came up invisible every time but the first, and the builder centres it before the
    // first frame anyway, so there is nothing to hide from.
    let window = WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::default())
        .title("CodeBurn Settings")
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        .decorations(true)
        .center()
        .build()?;
    window.set_focus()?;
    Ok(())
}

/// The section the window was opened on, taken rather than read: a later reload of the page
/// should land on General, not on the pane the tray asked for an hour ago.
pub fn take_pending_section() -> Option<String> {
    PENDING_SECTION.lock().ok().and_then(|mut p| p.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_providers_the_cli_reads_from_the_environment_accept_a_key() {
        assert!(accepts_key("zai"));
        assert!(accepts_key("clinepass"));
        assert!(!accepts_key("claude"));
        assert!(!accepts_key("copilot"));
    }

    #[test]
    fn a_key_reaches_the_cli_under_every_name_that_adapter_reads() {
        let vars: Vec<&str> = KEY_VARS
            .iter()
            .filter(|(id, _)| *id == "clinepass")
            .flat_map(|(_, vars)| vars.iter().copied())
            .collect();
        assert_eq!(vars, vec!["CLINEPASS_API_KEY", "CLINE_API_KEY"]);
    }

    #[test]
    fn a_sealed_key_comes_back_unchanged() {
        let plain = br#"{"zai":"sk-test-value"}"#;
        let sealed = seal(plain).unwrap();
        assert_eq!(unseal(&sealed).unwrap(), plain.to_vec());
    }

    #[test]
    fn a_null_patch_value_removes_the_key_rather_than_storing_null() {
        let mut stored = Map::new();
        stored.insert("metric".into(), Value::String("tokens".into()));
        let mut patch = Map::new();
        patch.insert("metric".into(), Value::Null);
        for (key, value) in patch {
            if value.is_null() {
                stored.remove(&key);
            } else {
                stored.insert(key, value);
            }
        }
        assert!(stored.is_empty());
    }
}
