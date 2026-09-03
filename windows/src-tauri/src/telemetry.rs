//! Anonymous, consent-gated product telemetry for the tray app and its Capacity Dock.
//!
//! The Windows twin of `app/electron/telemetry.ts`: same endpoint, same envelope, same
//! sanitizer, same day granularity, so events from the two apps land in one table and can be
//! read side by side. `app.name` is what tells them apart.
//!
//! Privacy invariants (enforced here, not by the caller):
//!
//! - Nothing is sent before a decision has been made, and nothing is sent while the toggle
//!   is off.
//! - The tray can be installed on its own or beside the desktop app. When the desktop app's
//!   own state file exists, its decision and its install id are used and this app never
//!   writes that file: one decision covers both, and the two apps' events join on one id.
//!   Standalone, the decision lives in this app's own settings file and defaults off for
//!   EU / EEA / UK / CH and for an unknown region, on elsewhere.
//! - The only identifier is a random id minted locally. Switching the toggle off mints a
//!   fresh one so past and future data cannot be linked.
//! - Events carry a day-granularity date only, and every prop goes through the whitelist
//!   sanitizer below: every leaf is a short string, a finite number or a boolean, and the
//!   nesting, key count, array length and leaf count are all capped. No paths, no session
//!   content, no exact amounts.
//! - Debug builds never send (`CODEBURN_TELEMETRY_DEV=1` overrides, for end-to-end testing).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const TELEMETRY_ENDPOINT: &str = "https://api.codeburn.app/v1/telemetry";
pub const TELEMETRY_SCHEMA: u64 = 1;
/// What separates these rows from the desktop app's (`codeburn-desktop`) in one table.
pub const APP_NAME: &str = "codeburn-menubar";

/// EU-27 + EEA (IS, LI, NO) + UK + CH, the same conservative "default off" region the
/// desktop app uses.
const DEFAULT_OFF_COUNTRIES: [&str; 32] = [
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
    "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO",
    "GB", "CH",
];

/// Every event this app may send. An unknown name is dropped rather than forwarded, so a
/// frontend typo cannot invent a metric.
const EVENT_NAMES: [&str; 11] = [
    "app_open",
    "app_close",
    "popover_open",
    "settings_open",
    "update_click",
    "glance_open",
    "dock_enabled",
    "dock_disabled",
    "dock_provider_switch",
    "dock_drag_end",
    "usage_snapshot",
];

const MAX_QUEUE: usize = 200;
const MAX_STRING: usize = 64;
const MAX_ARRAY: usize = 12;
const MAX_KEYS: usize = 16;
/// How deep a container may sit below the props object. The daily usage snapshot is the
/// deepest shape either app sends: props -> models[] -> model -> tasks[] -> task. Anything
/// deeper is dropped whole.
const MAX_DEPTH: usize = 5;
/// Belt and braces on top of the per-level caps: one event can never encode more than this
/// many leaf values, whatever shape it arrives in.
const MAX_LEAVES: usize = 1_000;

/// How often the queue is offered to the endpoint. The same beat the desktop app keeps.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(5 * 60);
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// Quit waits for the last batch, so it gets a timeout somebody would not notice.
const QUIT_TIMEOUT: Duration = Duration::from_millis(1_500);

// Settings keys ---------------------------------------------------------------------------

/// This app's own consent, in `windows-settings.json` beside every other preference. Only
/// read and written when the desktop app's state file is absent.
const KEY_ENABLED: &str = "telemetryEnabled";
const KEY_ONBOARDED_AT: &str = "telemetryOnboardedAt";
const KEY_INSTALL_ID: &str = "telemetryInstallId";

// Consent -----------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsentSource {
    /// The desktop app decided, and this app is only reading its answer.
    Desktop,
    /// A standalone tray install, which decides for itself.
    App,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Consent {
    pub source: ConsentSource,
    pub install_id: String,
    pub enabled: bool,
    pub onboarded: bool,
}

impl Consent {
    fn can_track(&self) -> bool {
        self.enabled && self.onboarded
    }
}

/// What the settings pane renders. `source` decides whether the toggle is live or a readout
/// of somebody else's decision.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStatus {
    pub enabled: bool,
    pub onboarded: bool,
    pub source: ConsentSource,
    pub country: Option<String>,
    pub default_enabled: bool,
}

/// The desktop app's `telemetry.v1.json`, of which only these three fields matter here.
/// Read-only, always: the desktop app owns that file and rewrites it whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopState {
    pub install_id: String,
    pub enabled: bool,
    pub onboarded: bool,
}

/// `%APPDATA%\codeburn-desktop\telemetry.v1.json`, which is Electron's `userData` for that
/// app plus the file name its Telemetry class writes.
pub fn desktop_state_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("codeburn-desktop")
            .join("telemetry.v1.json"),
    )
}

/// A version this build does not understand, a missing id or a missing toggle all mean "the
/// desktop app has not decided", which sends the resolution on to this app's own settings
/// rather than guessing on the desktop app's behalf.
pub fn parse_desktop_state(bytes: &[u8]) -> Option<DesktopState> {
    let raw: Value = serde_json::from_slice(bytes).ok()?;
    let object = raw.as_object()?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let install_id = object.get("installId").and_then(Value::as_str)?;
    if install_id.is_empty() {
        return None;
    }
    let enabled = object.get("enabled").and_then(Value::as_bool)?;
    Some(DesktopState {
        install_id: install_id.to_owned(),
        enabled,
        onboarded: object
            .get("onboardedAt")
            .and_then(Value::as_str)
            .is_some_and(|at| !at.is_empty()),
    })
}

fn read_desktop_state() -> Option<DesktopState> {
    parse_desktop_state(&fs::read(desktop_state_path()?).ok()?)
}

/// An unknown region is the conservative case and defaults off, exactly as the desktop does.
pub fn default_enabled_for(country: Option<&str>) -> bool {
    match country {
        None => false,
        Some(code) => {
            let upper = code.to_ascii_uppercase();
            !DEFAULT_OFF_COUNTRIES.contains(&upper.as_str())
        }
    }
}

/// The region subtag of a BCP-47 or POSIX locale name: `en-GB`, `sr-Latn-RS`,
/// `de_AT.UTF-8`. Only a two-letter alpha subtag is a region here, so the UN M.49 forms
/// (`es-419`) come back as unknown rather than as a country nobody can join on.
pub fn country_from_locale(locale: &str) -> Option<String> {
    let trimmed = locale.split('.').next().unwrap_or("");
    let mut parts = trimmed.split(['-', '_']);
    // The first subtag is the language, never the region.
    parts.next()?;
    parts
        .find(|part| part.len() == 2 && part.chars().all(|c| c.is_ascii_alphabetic()))
        .map(|part| part.to_ascii_uppercase())
}

/// The one decision every send is gated on. `desktop` present and valid wins outright, so a
/// tray running beside the desktop app never asks its own question.
pub fn resolve_consent(
    desktop: Option<DesktopState>,
    tray: &Map<String, Value>,
    country: Option<&str>,
) -> Consent {
    if let Some(state) = desktop {
        return Consent {
            source: ConsentSource::Desktop,
            install_id: state.install_id,
            enabled: state.enabled,
            onboarded: state.onboarded,
        };
    }
    Consent {
        source: ConsentSource::App,
        install_id: tray
            .get(KEY_INSTALL_ID)
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(new_install_id),
        enabled: tray
            .get(KEY_ENABLED)
            .and_then(Value::as_bool)
            .unwrap_or_else(|| default_enabled_for(country)),
        onboarded: tray
            .get(KEY_ONBOARDED_AT)
            .and_then(Value::as_str)
            .is_some_and(|at| !at.is_empty()),
    }
}

// Sanitizing ---------------------------------------------------------------------------------

/// One event's leaf allowance, spent as the walk goes and never refilled.
struct LeafBudget {
    left: usize,
}

fn sanitize_value(value: &Value, depth: usize, budget: &mut LeafBudget) -> Option<Value> {
    match value {
        Value::String(text) => {
            if budget.left == 0 {
                return None;
            }
            budget.left -= 1;
            Some(Value::String(truncate(text)))
        }
        Value::Number(number) => {
            if budget.left == 0 {
                return None;
            }
            if !number.as_f64().is_some_and(f64::is_finite) {
                return None;
            }
            budget.left -= 1;
            Some(value.clone())
        }
        Value::Bool(flag) => {
            if budget.left == 0 {
                return None;
            }
            budget.left -= 1;
            Some(Value::Bool(*flag))
        }
        // Only leaves are allowed at the bottom; a container here is dropped whole rather
        // than truncated to something that reads like a complete answer.
        _ if depth >= MAX_DEPTH => None,
        Value::Array(entries) => {
            let mut items: Vec<Value> = Vec::new();
            for entry in entries.iter().take(MAX_ARRAY) {
                if let Some(clean) = sanitize_value(entry, depth + 1, budget) {
                    items.push(clean);
                }
            }
            (!items.is_empty()).then_some(Value::Array(items))
        }
        Value::Object(fields) => {
            let flat = sanitize_object(fields, depth + 1, budget);
            (!flat.is_empty()).then_some(Value::Object(flat))
        }
        Value::Null => None,
    }
}

fn truncate(text: &str) -> String {
    text.chars().take(MAX_STRING).collect()
}

/// Note on the key cap: `serde_json`'s map is ordered by key here, where the desktop app's
/// object is in insertion order, so an object with more than `MAX_KEYS` keys can keep a
/// different sixteen in each app. Nothing this app sends is anywhere near the cap, and the
/// caps exist to bound a payload rather than to choose between keys.
fn sanitize_object(
    fields: &Map<String, Value>,
    depth: usize,
    budget: &mut LeafBudget,
) -> Map<String, Value> {
    let mut out = Map::new();
    let mut keys = 0;
    for (key, value) in fields {
        if keys >= MAX_KEYS {
            break;
        }
        if let Some(clean) = sanitize_value(value, depth, budget) {
            out.insert(truncate(key), clean);
            keys += 1;
        }
    }
    out
}

/// Whitelist sanitizer. Keeps short strings, finite numbers and booleans, plus plain objects
/// and arrays of them nested up to `MAX_DEPTH`, each level capped by `MAX_KEYS` / `MAX_ARRAY`
/// and the whole event by `MAX_LEAVES`. Everything else is dropped. Port of `sanitizeProps`
/// in the desktop app: deep enough for the daily usage snapshot's model by task cross and
/// nothing more.
pub fn sanitize_props(props: &Value) -> Map<String, Value> {
    let Some(object) = props.as_object() else {
        return Map::new();
    };
    sanitize_object(object, 1, &mut LeafBudget { left: MAX_LEAVES })
}

/// The daily aggregate out of the CLI's menubar payload, when there is one. A CLI older
/// than the field carries nothing, and a `null` means the CLI had nothing worth reporting;
/// both are the same answer here. The object itself is opaque: the CLI decides what belongs
/// in it, and the sanitizer decides what survives.
pub fn snapshot_from_payload(payload: &Value) -> Option<&Value> {
    payload.get("telemetrySnapshot").filter(|value| value.is_object())
}

// Buckets ------------------------------------------------------------------------------------

/// The dock's size as a band rather than the exact slider position, which would be close to
/// an identifier on its own.
pub fn scale_bucket(scale: f64) -> &'static str {
    if !scale.is_finite() {
        return "unknown";
    }
    let percent = scale * 100.0;
    if percent < 80.0 {
        "60-79"
    } else if percent < 100.0 {
        "80-99"
    } else {
        "100-120"
    }
}

// The queue ----------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueuedEvent {
    pub name: String,
    pub day: String,
    pub props: Map<String, Value>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedQueue {
    #[serde(default)]
    events: Vec<QueuedEvent>,
    /// The last day a `usage_snapshot` was queued, which is what caps it at one per day
    /// across restarts as well as within one run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_snapshot_day: Option<String>,
}

/// The queue, and the file behind it. Written after every change so a quit, a crash or a
/// sign-out loses nothing that was already recorded.
#[derive(Debug)]
pub struct Queue {
    path: Option<PathBuf>,
    events: Vec<QueuedEvent>,
    last_snapshot_day: Option<String>,
}

impl Queue {
    pub fn load(path: Option<PathBuf>) -> Self {
        let persisted = path
            .as_deref()
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<PersistedQueue>(&bytes).ok())
            .unwrap_or_default();
        let mut events = persisted.events;
        // A hand-edited or truncated file must not put this run over the cap.
        if events.len() > MAX_QUEUE {
            let excess = events.len() - MAX_QUEUE;
            events.drain(0..excess);
        }
        Queue {
            path,
            events,
            last_snapshot_day: persisted.last_snapshot_day,
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// At most one snapshot per calendar day. Answers once: a caller told `true` has already
    /// spent the day's slot, which is why this both asks and records.
    pub fn claim_snapshot_day(&mut self, day: &str) -> bool {
        if self.last_snapshot_day.as_deref() == Some(day) {
            return false;
        }
        self.last_snapshot_day = Some(day.to_owned());
        true
    }

    /// The oldest event gives way at the cap, so the queue always carries the most recent
    /// window rather than freezing at whatever filled it first.
    pub fn push(&mut self, event: QueuedEvent) {
        if self.events.len() >= MAX_QUEUE {
            self.events.remove(0);
        }
        self.events.push(event);
    }

    /// The batch to send. It leaves the queue here and comes back through `restore` if the
    /// send failed in a way worth retrying.
    pub fn take(&mut self) -> Vec<QueuedEvent> {
        std::mem::take(&mut self.events)
    }

    /// Puts a failed batch back in front of whatever was queued while it was in flight, and
    /// drops the oldest of the two if together they overflow.
    pub fn restore(&mut self, mut batch: Vec<QueuedEvent>) {
        batch.append(&mut self.events);
        if batch.len() > MAX_QUEUE {
            let excess = batch.len() - MAX_QUEUE;
            batch.drain(0..excess);
        }
        self.events = batch;
    }

    pub fn clear(&mut self) {
        self.events.clear();
    }

    pub fn save(&self) {
        let Some(path) = self.path.as_deref() else {
            return;
        };
        if let Err(err) = write_atomic(
            path,
            &PersistedQueue {
                events: self.events.clone(),
                last_snapshot_day: self.last_snapshot_day.clone(),
            },
        ) {
            crate::log_line!("codeburn: failed to persist the telemetry queue: {err}");
        }
    }
}

fn write_atomic(path: &Path, queue: &PersistedQueue) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let serialized = serde_json::to_vec(queue)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serialized)?;
    fs::rename(&tmp, path)
}

fn queue_path() -> Option<PathBuf> {
    Some(
        dirs::data_local_dir()?
            .join("codeburn-menubar")
            .join("telemetry-queue.json"),
    )
}

// The envelope ---------------------------------------------------------------------------------

/// The exact shape the desktop app posts, field for field, so both apps land in one table.
pub fn envelope(
    install_id: &str,
    app_version: &str,
    country: Option<&str>,
    events: &[QueuedEvent],
) -> Value {
    serde_json::json!({
        "schema": TELEMETRY_SCHEMA,
        "installId": install_id,
        "app": {
            "name": APP_NAME,
            "version": app_version,
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "country": country,
        },
        "events": events,
    })
}

// Dates ------------------------------------------------------------------------------------------

/// `YYYY-MM-DD`, the desktop app's day key.
pub fn format_day(year: i64, month: u32, day: u32) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

/// Civil date from a Unix timestamp, by the usual days-from-epoch algorithm. Used for the
/// day key where the platform has no cheap local-time call, and by the tests, which need a
/// date that does not move with the machine's clock settings.
pub fn day_key_utc(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    // Shift the epoch to 0000-03-01 so leap days land at the end of the cycle.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    format_day(if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(target_os = "windows")]
fn today() -> String {
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;

    let mut time = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut time) };
    format_day(time.wYear as i64, time.wMonth as u32, time.wDay as u32)
}

/// Off Windows the day key is UTC. The desktop app's is local, so an install on both, in a
/// timezone far from UTC, can disagree about which day an event near midnight belongs to.
/// That is a day-granularity metric being off by a day at the boundary, which is the whole
/// cost of not carrying a timezone database here.
#[cfg(not(target_os = "windows"))]
fn today() -> String {
    day_key_utc(now_secs())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

// The install id -----------------------------------------------------------------------------

/// A random v4 UUID, the same shape the desktop app's `randomUUID` produces.
pub fn new_install_id() -> String {
    let mut bytes = [0u8; 16];
    fill_random(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(target_os = "windows")]
fn fill_random(bytes: &mut [u8; 16]) {
    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };

    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        fill_random_fallback(bytes);
    }
}

#[cfg(not(target_os = "windows"))]
fn fill_random(bytes: &mut [u8; 16]) {
    match fs::read("/dev/urandom") {
        Ok(from_kernel) if from_kernel.len() >= bytes.len() => {
            bytes.copy_from_slice(&from_kernel[..bytes.len()]);
        }
        _ => fill_random_fallback(bytes),
    }
}

/// Only reached when the OS refused to hand over randomness, which it does not do in
/// practice. An id that is merely hard to guess is still better than a fixed one, and the
/// alternative is having no id and so no telemetry at all.
fn fill_random_fallback(bytes: &mut [u8; 16]) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let mut state = (nanos as u64) ^ (std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    for chunk in bytes.chunks_mut(8) {
        // SplitMix64, which is enough to spread one clock reading over sixteen bytes.
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        for (slot, byte) in chunk.iter_mut().zip(z.to_le_bytes()) {
            *slot = byte;
        }
    }
}

// The client ------------------------------------------------------------------------------------

pub struct Telemetry {
    inner: Mutex<Inner>,
    app_version: String,
    country: Option<String>,
    endpoint: String,
    /// False in a debug build without `CODEBURN_TELEMETRY_DEV=1`: the queue still fills, so
    /// the wiring can be exercised, but nothing leaves the machine.
    may_send: bool,
    opened_at: SystemTime,
}

struct Inner {
    consent: Consent,
    queue: Queue,
}

impl Telemetry {
    /// Reads consent and whatever a previous run left queued. Mints and stores this app's
    /// own install id on a standalone install that has none yet, and never touches the
    /// desktop app's file.
    pub fn new(app_version: String) -> Self {
        let country = user_country();
        let consent = resolve_consent(
            read_desktop_state(),
            &crate::settings::read(),
            country.as_deref(),
        );
        if consent.source == ConsentSource::App {
            persist_install_id(&consent.install_id);
        }
        Telemetry {
            inner: Mutex::new(Inner {
                consent,
                queue: Queue::load(queue_path()),
            }),
            app_version,
            country,
            endpoint: TELEMETRY_ENDPOINT.to_owned(),
            may_send: !cfg!(debug_assertions)
                || std::env::var("CODEBURN_TELEMETRY_DEV").as_deref() == Ok("1"),
            opened_at: SystemTime::now(),
        }
    }

    pub fn status(&self) -> TelemetryStatus {
        let consent = self.reresolve();
        TelemetryStatus {
            enabled: consent.enabled,
            onboarded: consent.onboarded,
            source: consent.source,
            country: self.country.clone(),
            default_enabled: default_enabled_for(self.country.as_deref()),
        }
    }

    /// Re-reads the desktop app's file, because it can appear or change while this app runs:
    /// the desktop app can be installed after the tray, and its consent screen is answered
    /// in a different process.
    fn reresolve(&self) -> Consent {
        let stored = crate::settings::read();
        let mut fresh = resolve_consent(read_desktop_state(), &stored, self.country.as_deref());
        let Ok(mut inner) = self.inner.lock() else {
            return fresh;
        };
        // A settings file that could not be written leaves this app's id unstored, and
        // resolving mints a fresh one every time it is asked. Keep the one this run already
        // has instead, so a failed write does not scatter a session over several ids.
        if fresh.source == ConsentSource::App
            && inner.consent.source == ConsentSource::App
            && !stored.contains_key(KEY_INSTALL_ID)
        {
            fresh.install_id = inner.consent.install_id.clone();
        }
        inner.consent = fresh.clone();
        fresh
    }

    /// The settings toggle. Off mints a fresh install id and empties the queue, so nothing
    /// already recorded is sent and nothing later can be tied to what came before. Refused
    /// while the desktop app is the source: its file is that app's to write.
    pub fn set_enabled(&self, enabled: bool) -> TelemetryStatus {
        let consent = self.reresolve();
        if consent.source == ConsentSource::Desktop {
            return self.status();
        }
        let mut patch = Map::new();
        patch.insert(KEY_ENABLED.into(), Value::Bool(enabled));
        if !enabled {
            patch.insert(KEY_INSTALL_ID.into(), Value::String(new_install_id()));
            if let Ok(mut inner) = self.inner.lock() {
                inner.queue.clear();
                inner.queue.save();
            }
        }
        self.patch_settings(patch);
        self.status()
    }

    /// The one-time consent notice's answer. Records that the question was asked, whichever
    /// way it was answered, which is what unlocks sending.
    pub fn complete_consent(&self, enabled: bool) -> TelemetryStatus {
        let consent = self.reresolve();
        if consent.source == ConsentSource::Desktop {
            return self.status();
        }
        let mut patch = Map::new();
        patch.insert(KEY_ENABLED.into(), Value::Bool(enabled));
        patch.insert(KEY_ONBOARDED_AT.into(), Value::String(iso_now()));
        if !enabled {
            patch.insert(KEY_INSTALL_ID.into(), Value::String(new_install_id()));
        }
        self.patch_settings(patch);
        let status = self.status();
        if status.enabled {
            self.track("app_open", &Value::Null);
        }
        status
    }

    fn patch_settings(&self, patch: Map<String, Value>) {
        if let Err(err) = crate::settings::patch(patch) {
            crate::log_line!("codeburn: failed to store the telemetry decision: {err}");
        }
    }

    /// Queues one event. An unknown name, junk props or a missing decision are all dropped
    /// here rather than reaching the wire.
    pub fn track(&self, name: &str, props: &Value) {
        self.track_on(name, props, &today());
    }

    fn track_on(&self, name: &str, props: &Value, day: &str) {
        if !EVENT_NAMES.contains(&name) {
            return;
        }
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if !inner.consent.can_track() {
            return;
        }
        // The desktop app sends the snapshot from its own process when it is the one that
        // decided; two apps sending the same aggregate under one install id would double
        // every figure in it.
        if name == "usage_snapshot" {
            if inner.consent.source == ConsentSource::Desktop {
                return;
            }
            if !inner.queue.claim_snapshot_day(day) {
                return;
            }
        }
        inner.queue.push(QueuedEvent {
            name: name.to_owned(),
            day: day.to_owned(),
            props: sanitize_props(props),
        });
        inner.queue.save();
    }

    /// Session length, in whole minutes, for the last flush before the process goes.
    pub fn track_close(&self) {
        let minutes = self
            .opened_at
            .elapsed()
            .map(|elapsed| (elapsed.as_secs_f64() / 60.0).round())
            .unwrap_or_default();
        self.track("app_close", &serde_json::json!({ "sessionMinutes": minutes }));
    }

    /// Best-effort batch POST. A 4xx drops the batch, because retrying a payload the server
    /// has already refused would wedge the queue at its cap; a 5xx or a dead network keeps
    /// it for the next beat.
    pub async fn flush(&self, timeout: Duration) -> bool {
        if !self.may_send {
            return false;
        }
        // Also where a decision made elsewhere is picked up: the desktop app can be
        // installed, or answer its consent screen, while this app is already running.
        self.reresolve();
        let (install_id, batch) = {
            let Ok(mut inner) = self.inner.lock() else {
                return false;
            };
            if !inner.consent.can_track() || inner.queue.is_empty() {
                return false;
            }
            (inner.consent.install_id.clone(), inner.queue.take())
        };
        let body = envelope(
            &install_id,
            &self.app_version,
            self.country.as_deref(),
            &batch,
        );
        let outcome = post(&self.endpoint, &body, timeout).await;
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        match outcome {
            Outcome::Sent => {
                inner.queue.save();
                true
            }
            Outcome::Rejected => {
                crate::log_line!(
                    "codeburn: the telemetry endpoint refused a batch of {} events; dropping it",
                    batch.len()
                );
                inner.queue.save();
                false
            }
            Outcome::Retry => {
                inner.queue.restore(batch);
                inner.queue.save();
                false
            }
        }
    }

    /// Visible for tests.
    #[cfg(test)]
    pub fn queue_len(&self) -> usize {
        self.inner.lock().map(|inner| inner.queue.len()).unwrap_or(0)
    }
}

enum Outcome {
    Sent,
    /// A 4xx: this batch will never be accepted.
    Rejected,
    /// A 5xx, a timeout or no network: worth another beat.
    Retry,
}

async fn post(endpoint: &str, body: &Value, timeout: Duration) -> Outcome {
    // Plain HTTP is refused outright, redirect included, as everywhere else this app talks
    // to the network: see fx.rs and update.rs.
    let client = match reqwest::Client::builder()
        .timeout(timeout)
        .https_only(true)
        .build()
    {
        Ok(client) => client,
        Err(_) => return Outcome::Retry,
    };
    match client.post(endpoint).json(body).send().await {
        Ok(response) => {
            let status = response.status();
            if status.is_success() {
                Outcome::Sent
            } else if status.is_client_error() {
                Outcome::Rejected
            } else {
                Outcome::Retry
            }
        }
        Err(_) => Outcome::Retry,
    }
}

fn iso_now() -> String {
    let secs = now_secs();
    let seconds_of_day = secs.rem_euclid(86_400);
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        day_key_utc(secs),
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60
    )
}

fn persist_install_id(install_id: &str) {
    let stored = crate::settings::read();
    if stored.get(KEY_INSTALL_ID).and_then(Value::as_str) == Some(install_id) {
        return;
    }
    let mut patch = Map::new();
    patch.insert(KEY_INSTALL_ID.into(), Value::String(install_id.to_owned()));
    if let Err(err) = crate::settings::patch(patch) {
        crate::log_line!("codeburn: failed to store the telemetry install id: {err}");
    }
}

#[cfg(target_os = "windows")]
fn user_country() -> Option<String> {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;

    // LOCALE_NAME_MAX_LENGTH.
    let mut buffer = [0u16; 85];
    let written = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
    if written <= 0 {
        return None;
    }
    // The count includes the terminating null.
    let name = String::from_utf16_lossy(&buffer[..(written as usize - 1)]);
    country_from_locale(&name)
}

#[cfg(not(target_os = "windows"))]
fn user_country() -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .filter(|locale| !locale.is_empty())
        .as_deref()
        .and_then(country_from_locale)
}

// The process-wide instance -----------------------------------------------------------------

static INSTANCE: OnceLock<Telemetry> = OnceLock::new();

/// Called once from `setup`. Every later call is a no-op, so a second one cannot reset the
/// session clock or lose a queue.
pub fn init(app_version: String) -> &'static Telemetry {
    INSTANCE.get_or_init(|| Telemetry::new(app_version))
}

pub fn instance() -> Option<&'static Telemetry> {
    INSTANCE.get()
}

/// The call every surface uses. Silent before `init`, which is what a tray icon built before
/// setup finishes would otherwise trip over.
pub fn track(name: &str, props: Value) {
    if let Some(telemetry) = instance() {
        telemetry.track(name, &props);
    }
}

/// The last flush, on the way out. Bounded so quitting never waits on a slow network.
pub fn flush_on_quit() {
    let Some(telemetry) = instance() else {
        return;
    };
    telemetry.track_close();
    tauri::async_runtime::block_on(async {
        telemetry.flush(QUIT_TIMEOUT).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tray(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect()
    }

    fn temp_queue(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join("codeburn-telemetry-tests")
            .join(name)
    }

    // Consent -----------------------------------------------------------------------------

    #[test]
    fn the_desktop_apps_decision_wins_and_carries_its_install_id() {
        let desktop = parse_desktop_state(
            br#"{"version":1,"installId":"desk-1","enabled":true,"onboardedAt":"2026-01-01T00:00:00Z"}"#,
        );
        let consent = resolve_consent(
            desktop,
            &tray(&[
                (KEY_ENABLED, Value::Bool(false)),
                (KEY_INSTALL_ID, Value::String("tray-1".into())),
            ]),
            Some("US"),
        );
        assert_eq!(consent.source, ConsentSource::Desktop);
        assert_eq!(consent.install_id, "desk-1");
        assert!(consent.enabled);
        assert!(consent.onboarded);
    }

    #[test]
    fn a_desktop_file_without_a_decision_is_not_a_decision() {
        let desktop = parse_desktop_state(br#"{"version":1,"installId":"desk-1","enabled":true}"#);
        let consent = resolve_consent(desktop, &Map::new(), Some("US"));
        assert_eq!(consent.source, ConsentSource::Desktop);
        assert!(!consent.onboarded);
    }

    #[test]
    fn an_unreadable_or_future_desktop_file_falls_through_to_this_app() {
        assert_eq!(parse_desktop_state(b"not json"), None);
        assert_eq!(
            parse_desktop_state(br#"{"version":2,"installId":"desk-1","enabled":true}"#),
            None
        );
        assert_eq!(parse_desktop_state(br#"{"version":1,"enabled":true}"#), None);
        assert_eq!(
            parse_desktop_state(br#"{"version":1,"installId":"","enabled":true}"#),
            None
        );
    }

    #[test]
    fn a_standalone_install_uses_its_own_stored_decision() {
        let consent = resolve_consent(
            None,
            &tray(&[
                (KEY_ENABLED, Value::Bool(true)),
                (KEY_ONBOARDED_AT, Value::String("2026-01-01T00:00:00Z".into())),
                (KEY_INSTALL_ID, Value::String("tray-1".into())),
            ]),
            Some("DE"),
        );
        assert_eq!(consent.source, ConsentSource::App);
        assert_eq!(consent.install_id, "tray-1");
        assert!(consent.enabled);
        assert!(consent.onboarded);
    }

    #[test]
    fn a_standalone_install_with_no_stored_decision_takes_the_region_default() {
        let eu = resolve_consent(None, &Map::new(), Some("FR"));
        assert_eq!(eu.source, ConsentSource::App);
        assert!(!eu.enabled);
        assert!(!eu.onboarded);

        let elsewhere = resolve_consent(None, &Map::new(), Some("US"));
        assert!(elsewhere.enabled);
        assert!(!elsewhere.onboarded);
    }

    #[test]
    fn an_unknown_region_defaults_off() {
        assert!(!default_enabled_for(None));
        assert!(!default_enabled_for(Some("gb")));
        assert!(!default_enabled_for(Some("CH")));
        assert!(default_enabled_for(Some("us")));
        assert!(default_enabled_for(Some("JP")));
    }

    #[test]
    fn a_fresh_standalone_install_is_given_an_id_of_its_own() {
        let first = resolve_consent(None, &Map::new(), Some("US")).install_id;
        let second = resolve_consent(None, &Map::new(), Some("US")).install_id;
        assert_eq!(first.len(), 36);
        assert_ne!(first, second);
    }

    #[test]
    fn the_region_comes_from_the_locales_region_subtag() {
        assert_eq!(country_from_locale("en-GB"), Some("GB".into()));
        assert_eq!(country_from_locale("de_AT.UTF-8"), Some("AT".into()));
        assert_eq!(country_from_locale("sr-Latn-RS"), Some("RS".into()));
        assert_eq!(country_from_locale("en"), None);
        assert_eq!(country_from_locale("es-419"), None);
        assert_eq!(country_from_locale(""), None);
    }

    #[test]
    fn consent_needs_both_a_decision_and_a_toggle_that_is_on() {
        let onboarded_off = Consent {
            source: ConsentSource::App,
            install_id: "id".into(),
            enabled: false,
            onboarded: true,
        };
        let undecided_on = Consent {
            source: ConsentSource::App,
            install_id: "id".into(),
            enabled: true,
            onboarded: false,
        };
        assert!(!onboarded_off.can_track());
        assert!(!undecided_on.can_track());
    }

    // The queue ---------------------------------------------------------------------------

    fn event(name: &str) -> QueuedEvent {
        QueuedEvent {
            name: name.to_owned(),
            day: "2026-09-03".into(),
            props: Map::new(),
        }
    }

    #[test]
    fn the_queue_is_capped_and_keeps_the_most_recent_events() {
        let mut queue = Queue::load(None);
        for index in 0..(MAX_QUEUE + 10) {
            queue.push(QueuedEvent {
                name: format!("popover_open{index}"),
                day: "2026-09-03".into(),
                props: Map::new(),
            });
        }
        assert_eq!(queue.len(), MAX_QUEUE);
        assert_eq!(queue.events[0].name, "popover_open10");
        assert_eq!(
            queue.events[MAX_QUEUE - 1].name,
            format!("popover_open{}", MAX_QUEUE + 9)
        );
    }

    #[test]
    fn a_restored_batch_goes_back_in_front_and_still_respects_the_cap() {
        let mut queue = Queue::load(None);
        queue.push(event("app_open"));
        let batch = queue.take();
        assert!(queue.is_empty());
        queue.push(event("popover_open"));
        queue.restore(batch);
        assert_eq!(queue.len(), 2);
        assert_eq!(queue.events[0].name, "app_open");
        assert_eq!(queue.events[1].name, "popover_open");

        // A batch that comes back to a queue which filled while it was in flight is the
        // older of the two, so it is the one that gives way at the cap.
        let mut full = Queue::load(None);
        for _ in 0..MAX_QUEUE {
            full.push(event("popover_open"));
        }
        full.restore(vec![event("app_open"), event("app_open")]);
        assert_eq!(full.len(), MAX_QUEUE);
        assert_eq!(full.events[0].name, "popover_open");
    }

    #[test]
    fn the_queue_survives_a_restart() {
        let path = temp_queue("queue-roundtrip.json");
        let _ = fs::remove_file(&path);
        let mut queue = Queue::load(Some(path.clone()));
        queue.push(event("app_open"));
        assert!(queue.claim_snapshot_day("2026-09-03"));
        queue.save();

        let reloaded = Queue::load(Some(path.clone()));
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded.events[0].name, "app_open");
        assert_eq!(reloaded.last_snapshot_day.as_deref(), Some("2026-09-03"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn an_oversized_file_from_an_older_build_is_trimmed_on_load() {
        let path = temp_queue("queue-oversized.json");
        let _ = fs::remove_file(&path);
        let events: Vec<QueuedEvent> = (0..(MAX_QUEUE + 5))
            .map(|index| QueuedEvent {
                name: format!("popover_open{index}"),
                day: "2026-09-03".into(),
                props: Map::new(),
            })
            .collect();
        write_atomic(
            &path,
            &PersistedQueue {
                events,
                last_snapshot_day: None,
            },
        )
        .unwrap();

        let queue = Queue::load(Some(path.clone()));
        assert_eq!(queue.len(), MAX_QUEUE);
        assert_eq!(queue.events[0].name, "popover_open5");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_missing_or_corrupt_queue_file_starts_empty_rather_than_failing() {
        let path = temp_queue("queue-corrupt.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{not json").unwrap();
        assert!(Queue::load(Some(path.clone())).is_empty());
        let _ = fs::remove_file(&path);
        assert!(Queue::load(Some(path)).is_empty());
    }

    #[test]
    fn the_snapshot_day_can_only_be_claimed_once() {
        let mut queue = Queue::load(None);
        assert!(queue.claim_snapshot_day("2026-09-03"));
        assert!(!queue.claim_snapshot_day("2026-09-03"));
        assert!(queue.claim_snapshot_day("2026-09-04"));
        assert!(!queue.claim_snapshot_day("2026-09-04"));
    }

    // Sanitizing ---------------------------------------------------------------------------

    #[test]
    fn leaves_are_short_strings_finite_numbers_and_booleans() {
        let props = serde_json::json!({
            "edge": "left",
            "scale": 0.8,
            "pinned": true,
            "long": "x".repeat(200),
            "nothing": null,
        });
        let clean = sanitize_props(&props);
        assert_eq!(clean.get("edge").unwrap(), "left");
        assert_eq!(clean.get("scale").unwrap(), 0.8);
        assert_eq!(clean.get("pinned").unwrap(), true);
        assert_eq!(clean.get("long").unwrap().as_str().unwrap().len(), MAX_STRING);
        assert!(clean.get("nothing").is_none());
    }

    #[test]
    fn the_snapshots_shape_survives_the_walk() {
        // props -> models[] -> model -> tasks[] -> task is the deepest thing either app
        // sends, and it has to come through whole.
        let props = serde_json::json!({
            "costBucket": "1-10",
            "models": [{ "name": "sonnet", "tasks": [{ "category": "code", "turnsBucket": "10-50" }] }],
            "sessions": { "countBucket": "5-20" },
        });
        let clean = sanitize_props(&props);
        assert_eq!(clean["sessions"]["countBucket"], "5-20");
        assert_eq!(clean["models"][0]["tasks"][0]["turnsBucket"], "10-50");
    }

    #[test]
    fn a_container_past_the_depth_cap_is_dropped_whole() {
        // One level deeper than the snapshot: the task's own object has nowhere to go.
        let props = serde_json::json!({
            "models": [{ "tasks": [{ "deeper": { "no": 1 }, "kept": "yes" }] }],
        });
        let clean = sanitize_props(&props);
        let task = &clean["models"][0]["tasks"][0];
        assert_eq!(task["kept"], "yes");
        assert!(task.get("deeper").is_none());
    }

    #[test]
    fn arrays_are_capped_and_an_empty_container_is_dropped_rather_than_sent() {
        let props = serde_json::json!({
            "rows": (0..20).map(|index| serde_json::json!({ "id": index })).collect::<Vec<_>>(),
            "nulls": [null, null],
            "empty": {},
        });
        let clean = sanitize_props(&props);
        assert_eq!(clean["rows"].as_array().unwrap().len(), MAX_ARRAY);
        assert!(clean.get("nulls").is_none());
        assert!(clean.get("empty").is_none());
    }

    #[test]
    fn one_event_can_never_encode_more_leaves_than_the_budget() {
        let rows: Vec<Value> = (0..MAX_ARRAY)
            .map(|_| {
                let mut row = Map::new();
                for key in 0..MAX_KEYS {
                    row.insert(format!("k{key:02}"), Value::from(1));
                }
                Value::Object(row)
            })
            .collect();
        let mut props = Map::new();
        // Sixteen keys of twelve rows of sixteen leaves is 3072, well past the budget.
        for key in 0..MAX_KEYS {
            props.insert(format!("g{key:02}"), Value::Array(rows.clone()));
        }
        let clean = sanitize_props(&Value::Object(props));
        let leaves: usize = clean
            .values()
            .map(|group| {
                group
                    .as_array()
                    .map(|rows| rows.iter().map(|row| row.as_object().map_or(0, Map::len)).sum())
                    .unwrap_or(0)
            })
            .sum();
        assert_eq!(leaves, MAX_LEAVES);
    }

    #[test]
    fn props_that_are_not_an_object_sanitize_to_nothing() {
        assert!(sanitize_props(&Value::Null).is_empty());
        assert!(sanitize_props(&serde_json::json!([1, 2])).is_empty());
        assert!(sanitize_props(&Value::String("nope".into())).is_empty());
    }

    // The envelope --------------------------------------------------------------------------

    #[test]
    fn the_envelope_matches_the_desktop_apps_field_for_field() {
        let events = vec![QueuedEvent {
            name: "popover_open".into(),
            day: "2026-09-03".into(),
            props: sanitize_props(&serde_json::json!({ "pane": "general" })),
        }];
        let body = envelope("install-1", "0.9.23", Some("GB"), &events);
        assert_eq!(body["schema"], 1);
        assert_eq!(body["installId"], "install-1");
        assert_eq!(body["app"]["name"], "codeburn-menubar");
        assert_eq!(body["app"]["version"], "0.9.23");
        assert_eq!(body["app"]["platform"], std::env::consts::OS);
        assert_eq!(body["app"]["arch"], std::env::consts::ARCH);
        assert_eq!(body["app"]["country"], "GB");
        assert_eq!(body["events"][0]["name"], "popover_open");
        assert_eq!(body["events"][0]["day"], "2026-09-03");
        assert_eq!(body["events"][0]["props"]["pane"], "general");
        // Nothing beyond those five keys, and nothing beyond those three per event.
        assert_eq!(body.as_object().unwrap().len(), 4);
        assert_eq!(body["app"].as_object().unwrap().len(), 5);
        assert_eq!(body["events"][0].as_object().unwrap().len(), 3);
    }

    #[test]
    fn an_unknown_region_is_sent_as_null_rather_than_omitted() {
        let body = envelope("install-1", "0.9.23", None, &[]);
        assert!(body["app"]["country"].is_null());
    }

    // Dates and buckets ----------------------------------------------------------------------

    #[test]
    fn the_day_key_is_a_padded_calendar_date() {
        assert_eq!(day_key_utc(0), "1970-01-01");
        assert_eq!(day_key_utc(1_772_000_000), "2026-02-25");
        assert_eq!(day_key_utc(951_868_800), "2000-03-01");
        assert_eq!(day_key_utc(-1), "1969-12-31");
    }

    #[test]
    fn the_snapshot_is_taken_from_the_payload_only_when_the_cli_carries_one() {
        // The shape the CLI's menubar-json payload will carry. Opaque here, so the fixture
        // only has to be an object.
        let with_snapshot = serde_json::json!({
            "current": { "cost": 1.5 },
            "telemetrySnapshot": { "costBucket": "1-10", "providers": 3 },
        });
        let snapshot = snapshot_from_payload(&with_snapshot).unwrap();
        assert_eq!(snapshot["costBucket"], "1-10");
        assert_eq!(sanitize_props(snapshot).len(), 2);

        // An older CLI, and a CLI with nothing to report.
        assert!(snapshot_from_payload(&serde_json::json!({ "current": {} })).is_none());
        assert!(snapshot_from_payload(&serde_json::json!({ "telemetrySnapshot": null })).is_none());
        assert!(snapshot_from_payload(&serde_json::json!({ "telemetrySnapshot": 7 })).is_none());
    }

    #[test]
    fn the_dock_scale_is_reported_as_a_band() {
        assert_eq!(scale_bucket(0.6), "60-79");
        assert_eq!(scale_bucket(0.75), "60-79");
        assert_eq!(scale_bucket(0.8), "80-99");
        assert_eq!(scale_bucket(1.0), "100-120");
        assert_eq!(scale_bucket(1.2), "100-120");
        assert_eq!(scale_bucket(f64::NAN), "unknown");
    }

    // Tracking -------------------------------------------------------------------------------

    /// A client with no settings file behind it: consent is handed in, so these exercise
    /// `track` without touching the real `windows-settings.json`.
    fn client(consent: Consent, path: Option<PathBuf>) -> Telemetry {
        Telemetry {
            inner: Mutex::new(Inner {
                consent,
                queue: Queue::load(path),
            }),
            app_version: "0.0.0".into(),
            country: Some("US".into()),
            endpoint: TELEMETRY_ENDPOINT.to_owned(),
            may_send: false,
            opened_at: SystemTime::now(),
        }
    }

    fn consented(source: ConsentSource) -> Consent {
        Consent {
            source,
            install_id: "id".into(),
            enabled: true,
            onboarded: true,
        }
    }

    #[test]
    fn nothing_is_queued_before_a_decision_or_while_the_toggle_is_off() {
        let undecided = client(
            Consent {
                onboarded: false,
                ..consented(ConsentSource::App)
            },
            None,
        );
        undecided.track("popover_open", &Value::Null);
        assert_eq!(undecided.queue_len(), 0);

        let opted_out = client(
            Consent {
                enabled: false,
                ..consented(ConsentSource::App)
            },
            None,
        );
        opted_out.track("popover_open", &Value::Null);
        assert_eq!(opted_out.queue_len(), 0);
    }

    #[test]
    fn an_event_this_build_does_not_know_is_dropped() {
        let telemetry = client(consented(ConsentSource::App), None);
        telemetry.track("prompt_text", &serde_json::json!({ "text": "secret" }));
        assert_eq!(telemetry.queue_len(), 0);
    }

    #[test]
    fn the_snapshot_is_queued_once_a_day_and_never_when_the_desktop_app_decided() {
        let standalone = client(consented(ConsentSource::App), None);
        let snapshot = serde_json::json!({ "costBucket": "1-10" });
        standalone.track_on("usage_snapshot", &snapshot, "2026-09-03");
        standalone.track_on("usage_snapshot", &snapshot, "2026-09-03");
        assert_eq!(standalone.queue_len(), 1);
        standalone.track_on("usage_snapshot", &snapshot, "2026-09-04");
        assert_eq!(standalone.queue_len(), 2);

        let beside_desktop = client(consented(ConsentSource::Desktop), None);
        beside_desktop.track_on("usage_snapshot", &snapshot, "2026-09-03");
        assert_eq!(beside_desktop.queue_len(), 0);
        // Everything else still goes: only the aggregate is the desktop app's to send.
        beside_desktop.track_on("popover_open", &Value::Null, "2026-09-03");
        assert_eq!(beside_desktop.queue_len(), 1);
    }

    #[test]
    fn a_queued_event_carries_the_day_and_sanitized_props_only() {
        let telemetry = client(consented(ConsentSource::App), None);
        telemetry.track_on(
            "dock_disabled",
            &serde_json::json!({ "edge": "left", "scaleBucket": "80-99", "dropped": null }),
            "2026-09-03",
        );
        let inner = telemetry.inner.lock().unwrap();
        let queued = &inner.queue.events[0];
        assert_eq!(queued.name, "dock_disabled");
        assert_eq!(queued.day, "2026-09-03");
        assert_eq!(queued.props.len(), 2);
        assert_eq!(queued.props.get("edge").unwrap(), "left");
    }

    #[test]
    fn a_debug_build_queues_but_does_not_send() {
        let telemetry = client(consented(ConsentSource::App), None);
        telemetry.track_on("popover_open", &Value::Null, "2026-09-03");
        assert_eq!(telemetry.queue_len(), 1);
        // may_send is false here, so flush refuses before it ever builds a request.
        assert!(!tauri::async_runtime::block_on(
            telemetry.flush(Duration::from_millis(1))
        ));
        assert_eq!(telemetry.queue_len(), 1);
    }
}
