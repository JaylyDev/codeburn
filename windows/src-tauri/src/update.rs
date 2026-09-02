//! Is there a newer tray app, is there a newer CLI, and the one click that installs both.
//!
//! Port of `mac/Sources/CodeBurnMenubar/Data/UpdateChecker.swift`, with the Windows release
//! line in place of the mac one: the app ships as an `.msi` under a `windows-v*` tag rather
//! than a zip under `mac-v*`, and the CLI's own `codeburn menubar --force` is what installs
//! it (`src/menubar-installer.ts`, which verifies the `.sha256` before handing the file to
//! `msiexec /i <msi> /passive /norestart`). So this module never downloads or executes
//! anything itself: it reads GitHub to know whether there is something newer, and asks the
//! CLI to do the install.
//!
//! The check runs here rather than in the page for two reasons: the answer has to survive a
//! popover that is closed most of the time, and the webview's CSP has no business reaching
//! api.github.com when the fetch can be made from a place that already talks HTTPS.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::cli::CodeburnCli;

const RELEASES_API: &str =
    "https://api.github.com/repos/getagentseal/codeburn/releases?per_page=20";
const USER_AGENT: &str = "codeburn-menubar-updater";
/// The mac's checkIntervalSeconds. A release cadence measured in weeks does not need asking
/// about more often than this, and the answer is cached on disk so a relaunch does not spend
/// a request either.
const CHECK_INTERVAL_SECS: u64 = 2 * 24 * 60 * 60;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// Twenty releases with their asset lists is a few tens of kilobytes. Anything past this is
/// not the GitHub API answering, and the body is read in chunks so an endless one is dropped
/// rather than buffered.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// The mac's updateTimeoutSeconds: an install that has not finished in two minutes is stuck,
/// not slow. Applied per stage, so the CLI update and the app install get one each.
const UPDATE_TIMEOUT_SECS: u64 = 120;
const MAX_UPDATE_STDERR_BYTES: usize = 64 * 1024;
/// The longest scrubbed subprocess output worth putting in front of a reader.
const MAX_DISPLAYED_CHARS: usize = 1_000;

/// What the reader is told to run by hand. Windows installs the CLI from npm; there is no
/// Homebrew branch to mirror.
pub const CLI_UPDATE_COMMAND: &str = "npm update -g codeburn";

/// The Windows MSI asset name, from `WINDOWS_RELEASE` in `src/menubar-installer.ts`. GitHub
/// rewrites the spaces in the product name to dots when it stores the asset, so the version
/// sits between a dotted prefix and the architecture suffix.
const MSI_PREFIX: &str = "CodeBurn.Menubar_";
const MSI_SUFFIX: &str = "_x64_en-US.msi";

/// The oldest CLI whose `menubar --force` can install the Windows app at all: the Windows
/// branch of the installer landed in 0.9.21 (commit 527e5807). An older one downloads a mac
/// zip on a machine that cannot open it, so we refuse to run it and ask for the CLI first,
/// exactly as the mac refuses anything below 0.9.9.
const MIN_CLI_VERSION_FOR_UPDATE: (u32, u32, u32) = (0, 9, 21);

/// Only one update may be in flight: the badge, the CLI banner and the About pane can all
/// start one, and two npm installs racing each other on the same global prefix is how a
/// half-installed CLI happens.
static UPDATING: AtomicBool = AtomicBool::new(false);

// The GitHub payload ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct GitHubAsset {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct GitHubRelease {
    pub tag_name: String,
    #[serde(default)]
    pub assets: Vec<GitHubAsset>,
}

/// The version an MSI asset name carries, or None when the asset is something else.
fn msi_version(name: &str) -> Option<&str> {
    name.strip_prefix(MSI_PREFIX)?.strip_suffix(MSI_SUFFIX)
}

/// The newest `windows-v*` release that carries an installable: an `.msi` and the `.sha256`
/// beside it. A release missing either is skipped rather than reported, because
/// `codeburn menubar` verifies the checksum before anything executes and would fail on it.
pub fn resolve_latest_windows_version(releases: &[GitHubRelease]) -> Option<String> {
    for release in releases
        .iter()
        .filter(|release| release.tag_name.starts_with("windows-v"))
    {
        let Some(asset) = release
            .assets
            .iter()
            .find(|asset| msi_version(&asset.name).is_some())
        else {
            continue;
        };
        let checksum = format!("{}.sha256", asset.name);
        if !release.assets.iter().any(|other| other.name == checksum) {
            continue;
        }
        return msi_version(&asset.name).map(str::to_owned);
    }
    None
}

/// The newest CLI release. Its tags are a bare `v<version>`, so the two platform lines
/// (`mac-v*`, `windows-v*`) are excluded by the prefix alone.
pub fn resolve_latest_cli_version(releases: &[GitHubRelease]) -> Option<String> {
    releases
        .iter()
        .find(|release| release.tag_name.starts_with('v'))
        .map(|release| release.tag_name.trim_start_matches('v').to_owned())
}

/// Strictly newer, by the same numeric comparison the CLI gate uses. An unparseable version
/// on either side is not an update: guessing would either nag forever or hide a real one.
fn is_newer(latest: &str, current: &str) -> bool {
    match (
        crate::cli::parse_version(latest),
        crate::cli::parse_version(current),
    ) {
        (Some(latest), Some(current)) => latest > current,
        _ => false,
    }
}

fn is_cli_too_old(installed: Option<&str>) -> bool {
    installed
        .and_then(crate::cli::parse_version)
        .is_some_and(|version| version < MIN_CLI_VERSION_FOR_UPDATE)
}

// What the page renders -------------------------------------------------------------------

/// Which stage failed, so the badge can say so. The mac's UpdateFailureStage; the labels and
/// the help text live in the page, since that is where they are read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureStage {
    Check,
    CliUpdate,
    MenubarUpdate,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub latest_cli_version: Option<String>,
    pub installed_cli_version: Option<String>,
    pub update_available: bool,
    pub cli_update_available: bool,
    /// Too old to install the app even though it may not be the newest release.
    pub cli_too_old: bool,
    pub cli_update_command: &'static str,
    /// Unix seconds of the last answer GitHub gave, cached or fresh.
    pub checked_at: Option<u64>,
    pub failure_stage: Option<FailureStage>,
    pub error: Option<String>,
}

impl UpdateStatus {
    fn new(current_version: String) -> Self {
        UpdateStatus {
            current_version,
            latest_version: None,
            latest_cli_version: None,
            installed_cli_version: None,
            update_available: false,
            cli_update_available: false,
            cli_too_old: false,
            cli_update_command: CLI_UPDATE_COMMAND,
            checked_at: None,
            failure_stage: None,
            error: None,
        }
    }

    /// The three derived answers, recomputed wherever a version moves: after a check, and
    /// again after the CLI update replaces the installed one.
    fn recompute(&mut self) {
        self.update_available = self
            .latest_version
            .as_deref()
            .is_some_and(|latest| is_newer(latest, &self.current_version));
        self.cli_update_available = match (
            self.latest_cli_version.as_deref(),
            self.installed_cli_version.as_deref(),
        ) {
            (Some(latest), Some(installed)) => is_newer(latest, installed),
            _ => false,
        };
        self.cli_too_old = is_cli_too_old(self.installed_cli_version.as_deref());
    }
}

// The disk cache ---------------------------------------------------------------------------

/// Beside the tray's own status file, for the same reason: the answer has to be there before
/// any webview is, and a relaunch must not spend a request to learn what it already knew.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cached {
    #[serde(default)]
    checked_at: u64,
    #[serde(default)]
    latest: Option<String>,
    #[serde(default)]
    latest_cli: Option<String>,
}

fn cache_path() -> Option<PathBuf> {
    Some(
        dirs::data_local_dir()?
            .join("codeburn-menubar")
            .join("update.json"),
    )
}

fn read_cache() -> Option<Cached> {
    let path = cache_path()?;
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_cache(cached: &Cached) -> Result<()> {
    let path = cache_path().context("no local app data directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(cached)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

fn is_fresh(checked_at: u64) -> bool {
    checked_at > 0 && now_secs().saturating_sub(checked_at) < CHECK_INTERVAL_SECS
}

// The check ---------------------------------------------------------------------------------

async fn fetch_releases() -> Result<Vec<GitHubRelease>> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        // Plain HTTP is refused outright, redirect included: this answer decides what the
        // one-click update installs.
        .https_only(true)
        .build()?;
    let mut response = client
        .get(RELEASES_API)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    if !response.status().is_success() {
        bail!("GitHub returned HTTP {}.", response.status().as_u16());
    }
    let mut body: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            bail!("The releases response was larger than expected.");
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).context("GitHub returned unexpected JSON")
}

async fn installed_cli_version(cli: &CodeburnCli) -> Option<String> {
    cli.status().await.version
}

/// The current answer. `force` skips the two-day gate; without it a cached answer inside the
/// interval is returned untouched, which is what makes this cheap to call on every mount.
pub async fn check(app: &AppHandle, cli: &CodeburnCli, force: bool) -> UpdateStatus {
    let mut status = UpdateStatus::new(app.package_info().version.to_string());
    status.installed_cli_version = installed_cli_version(cli).await;

    let cached = read_cache().unwrap_or_default();
    if !force && is_fresh(cached.checked_at) {
        status.latest_version = cached.latest;
        status.latest_cli_version = cached.latest_cli;
        status.checked_at = Some(cached.checked_at);
        status.recompute();
        return status;
    }

    match fetch_releases().await {
        Ok(releases) => {
            let fresh = Cached {
                checked_at: now_secs(),
                latest: resolve_latest_windows_version(&releases),
                latest_cli: resolve_latest_cli_version(&releases),
            };
            if let Err(err) = write_cache(&fresh) {
                eprintln!("codeburn: failed to cache the update check: {err}");
            }
            status.latest_version = fresh.latest;
            status.latest_cli_version = fresh.latest_cli;
            status.checked_at = Some(fresh.checked_at);
        }
        Err(err) => {
            // A failed check keeps whatever the cache knew, so a badge already on screen does
            // not vanish because the network went away for a moment.
            status.latest_version = cached.latest;
            status.latest_cli_version = cached.latest_cli;
            status.checked_at = (cached.checked_at > 0).then_some(cached.checked_at);
            status.failure_stage = Some(FailureStage::Check);
            status.error = Some(scrub(&err.to_string()));
            eprintln!("codeburn: update check failed: {err}");
        }
    }
    status.recompute();
    status
}

// The one-click update ------------------------------------------------------------------------

/// What one stage of the update did. `code` is None when the process was killed for running
/// past the timeout.
struct Run {
    code: Option<i32>,
    stderr: String,
    spawn_error: Option<String>,
    timed_out: bool,
}

impl Run {
    fn succeeded(&self) -> bool {
        self.code == Some(0) && self.spawn_error.is_none()
    }

    /// The one line the reader gets. The subprocess said whatever it said, so it is scrubbed
    /// before it is quoted.
    fn failure_message(&self, what: &str) -> String {
        if let Some(err) = &self.spawn_error {
            return format!("{what} could not be started: {err}");
        }
        if self.timed_out {
            return format!("{what} did not finish within {UPDATE_TIMEOUT_SECS}s and was stopped.");
        }
        if !self.stderr.is_empty() {
            return self.stderr.clone();
        }
        match self.code {
            Some(code) => format!("{what} failed (exit {code})."),
            None => format!("{what} failed."),
        }
    }
}

/// Spawn, cap and time-bound one update stage. stdout goes nowhere (npm and the installer
/// narrate on it and nobody reads that), stderr is capped, and a process still alive after
/// the timeout is killed rather than waited on forever.
async fn run_captured(program: &str, args: &[&str]) -> Run {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return Run {
                code: None,
                stderr: String::new(),
                spawn_error: Some(scrub(&format!("{program}: {err}"))),
                timed_out: false,
            }
        }
    };

    let stderr_task = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            let mut buf = Vec::with_capacity(4 * 1024);
            let mut limited = (&mut stderr).take(MAX_UPDATE_STDERR_BYTES as u64);
            limited.read_to_end(&mut buf).await.ok();
            buf
        })
    });

    let mut timed_out = false;
    let status = match timeout(Duration::from_secs(UPDATE_TIMEOUT_SECS), child.wait()).await {
        Ok(status) => status.ok(),
        Err(_) => {
            timed_out = true;
            eprintln!(
                "codeburn: update subprocess timed out after {UPDATE_TIMEOUT_SECS}s - terminating"
            );
            let _ = child.kill().await;
            None
        }
    };

    let stderr_bytes = match stderr_task {
        Some(task) => task.await.unwrap_or_default(),
        None => Vec::new(),
    };
    Run {
        code: status.and_then(|status| status.code()),
        stderr: scrub(&String::from_utf8_lossy(&stderr_bytes)),
        spawn_error: None,
        timed_out,
    }
}

fn emit_stage(app: &AppHandle, stage: FailureStage) {
    let _ = app.emit("codeburn://update-stage", stage);
}

/// One click, both updates, in the mac's order: the CLI first, so the installer that puts the
/// app on this machine is the one that ships with the new CLI, then the app itself. Either
/// stage stops the sequence and reports which one it was.
pub async fn perform_update(app: &AppHandle, cli: &CodeburnCli) -> UpdateStatus {
    let mut status = check(app, cli, false).await;
    if UPDATING.swap(true, Ordering::SeqCst) {
        status.failure_stage = Some(FailureStage::Check);
        status.error = Some("An update is already running.".into());
        return status;
    }
    let result = run_update(app, cli, status).await;
    UPDATING.store(false, Ordering::SeqCst);
    result
}

async fn run_update(app: &AppHandle, cli: &CodeburnCli, mut status: UpdateStatus) -> UpdateStatus {
    if status.cli_update_available || status.cli_too_old {
        emit_stage(app, FailureStage::CliUpdate);
        let Some(npm) = crate::cli::locate_npm(cli.program()) else {
            status.failure_stage = Some(FailureStage::CliUpdate);
            status.error = Some(format!(
                "Could not find npm beside {}. Run \u{201C}{CLI_UPDATE_COMMAND}\u{201D} yourself, then try again.",
                cli.program()
            ));
            return status;
        };
        let run = run_captured(&npm, &["install", "-g", "codeburn@latest", "--force"]).await;
        if !run.succeeded() {
            status.failure_stage = Some(FailureStage::CliUpdate);
            status.error = Some(run.failure_message("The CLI update"));
            return status;
        }
        // A fresh handle: the update may have moved the launcher, and the version has to be
        // re-read from whatever is installed now rather than assumed to be the latest.
        let updated = CodeburnCli::resolve();
        status.installed_cli_version = installed_cli_version(&updated).await;
        status.recompute();
        if status.cli_too_old {
            status.failure_stage = Some(FailureStage::CliUpdate);
            status.error = Some(format!(
                "The CLI is still {} after the update, which cannot install the app. Run \u{201C}{CLI_UPDATE_COMMAND}\u{201D} yourself, then try again.",
                status.installed_cli_version.as_deref().unwrap_or("unknown")
            ));
            return status;
        }
    }

    if !status.update_available {
        return status;
    }

    emit_stage(app, FailureStage::MenubarUpdate);
    // The CLI does the whole install: it resolves the release, verifies the .sha256, runs
    // msiexec and launches what it installed. Re-resolved for the same reason as above.
    let installer = CodeburnCli::resolve();
    let argv = installer.argv();
    let args: Vec<&str> = argv[1..]
        .iter()
        .map(String::as_str)
        .chain(["menubar", "--force"])
        .collect();
    let run = run_captured(&argv[0], &args).await;
    if !run.succeeded() {
        status.failure_stage = Some(FailureStage::MenubarUpdate);
        status.error = Some(run.failure_message("The app update"));
        return status;
    }
    // Installed: the version on disk is the one that was on offer, so the badge has nothing
    // left to say until the next check.
    status.latest_version = None;
    status.recompute();
    let _ = write_cache(&Cached {
        checked_at: now_secs(),
        latest: None,
        latest_cli: status.latest_cli_version.clone(),
    });
    status
}

// Scrubbing -----------------------------------------------------------------------------------

fn token_len(text: &str) -> usize {
    text.bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
        .count()
}

/// Three dot-separated `[A-Za-z0-9_-]` segments, the shape of a JWT.
fn jwt_len(rest: &str) -> Option<usize> {
    let mut pos = 0;
    for segment in 0..3 {
        if segment > 0 {
            if !rest[pos..].starts_with('.') {
                return None;
            }
            pos += 1;
        }
        let len = token_len(&rest[pos..]);
        if len == 0 {
            return None;
        }
        pos += len;
    }
    Some(pos)
}

/// A secret starting at `start`, as (what to print instead, where it ends).
fn secret_at(text: &str, start: usize) -> Option<(&'static str, usize)> {
    let rest = &text[start..];
    if let Some(after) = rest.strip_prefix("sk-ant-") {
        let len = token_len(after);
        if len > 0 {
            return Some(("sk-ant-***", start + "sk-ant-".len() + len));
        }
    }
    if let Some(after) = rest.strip_prefix("sk-") {
        let len = token_len(after);
        // The mac's `sk-[A-Za-z0-9_-]{16,}`: short enough and it is a word, not a key.
        if len >= 16 {
            return Some(("sk-***", start + "sk-".len() + len));
        }
    }
    if rest.starts_with("eyJ") {
        if let Some(len) = jwt_len(rest) {
            return Some(("eyJ***", start + len));
        }
    }
    // Compared as bytes rather than as a slice of the string: `&rest[..6]` would panic if
    // those six bytes ended inside a multi-byte character, and a scrubber that panics on
    // whatever a subprocess happened to print is worse than one that misses a token.
    if rest.len() >= 6 && rest.as_bytes()[..6].eq_ignore_ascii_case(b"bearer") {
        let after = &rest[6..];
        let spaces = after.len() - after.trim_start_matches([' ', '\t']).len();
        if spaces > 0 {
            let value = &after[spaces..];
            let len = value.len() - value.trim_start_matches(|c: char| !c.is_whitespace()).len();
            if len > 0 {
                return Some(("Bearer ***", start + 6 + spaces + len));
            }
        }
    }
    None
}

/// Whatever a subprocess printed, made safe to show. npm and the installer echo their whole
/// environment on some failures, and this app's own child processes carry provider API keys
/// in theirs, so the four shapes the mac redacts are redacted here too before anything
/// reaches a window. Same order as `sanitizeForDisplay`, longest prefix first.
pub fn scrub(value: &str) -> String {
    let cleaned: String = value.chars().filter(|c| *c != '\0').collect();
    let mut out = String::with_capacity(cleaned.len());
    let mut index = 0;
    while index < cleaned.len() {
        if let Some((replacement, end)) = secret_at(&cleaned, index) {
            out.push_str(replacement);
            index = end;
            continue;
        }
        let ch = cleaned[index..].chars().next().unwrap_or('\u{FFFD}');
        out.push(ch);
        index += ch.len_utf8();
    }
    let trimmed = out.trim();
    if trimmed.chars().count() > MAX_DISPLAYED_CHARS {
        let head: String = trimmed.chars().take(MAX_DISPLAYED_CHARS).collect();
        return format!("{head}...");
    }
    trimmed.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, assets: &[&str]) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.to_owned(),
            assets: assets
                .iter()
                .map(|name| GitHubAsset {
                    name: (*name).to_owned(),
                })
                .collect(),
        }
    }

    fn msi(version: &str) -> String {
        format!("{MSI_PREFIX}{version}{MSI_SUFFIX}")
    }

    #[test]
    fn the_version_comes_off_the_msi_asset_name() {
        assert_eq!(msi_version(&msi("0.9.23")), Some("0.9.23"));
        assert_eq!(msi_version("CodeBurnMenubar-v0.9.23.zip"), None);
        assert_eq!(msi_version("CodeBurn.Menubar_0.9.23_arm64_en-US.msi"), None);
    }

    #[test]
    fn the_newest_windows_release_with_both_assets_wins() {
        let releases = vec![
            release("v0.9.24", &["codeburn-0.9.24.tgz"]),
            // No checksum: `codeburn menubar` verifies one before it runs anything, so this
            // release is not installable and must not be offered.
            release("windows-v0.9.24", &[&msi("0.9.24")]),
            release(
                "windows-v0.9.23",
                &[&msi("0.9.23"), &format!("{}.sha256", msi("0.9.23"))],
            ),
        ];
        assert_eq!(
            resolve_latest_windows_version(&releases),
            Some("0.9.23".to_owned())
        );
    }

    #[test]
    fn a_release_line_without_an_msi_is_skipped_rather_than_reported() {
        let releases = vec![
            release("mac-v0.9.24", &["CodeBurnMenubar-v0.9.24.zip"]),
            release("windows-v0.9.24", &["release-notes.md"]),
        ];
        assert_eq!(resolve_latest_windows_version(&releases), None);
    }

    #[test]
    fn the_cli_version_comes_from_the_bare_tag_only() {
        let releases = vec![
            release("windows-v0.9.24", &[]),
            release("mac-v0.9.24", &[]),
            release("v0.9.23", &[]),
            release("v0.9.22", &[]),
        ];
        assert_eq!(
            resolve_latest_cli_version(&releases),
            Some("0.9.23".to_owned())
        );
        assert_eq!(resolve_latest_cli_version(&[]), None);
    }

    #[test]
    fn only_a_strictly_newer_version_is_an_update() {
        assert!(is_newer("0.9.24", "0.9.23"));
        assert!(is_newer("0.10.0", "0.9.30"));
        assert!(!is_newer("0.9.23", "0.9.23"));
        assert!(!is_newer("0.9.22", "0.9.23"));
        // Nothing to compare is not an update; a nag nobody can clear is worse than silence.
        assert!(!is_newer("nightly", "0.9.23"));
        assert!(!is_newer("0.9.24", "dev"));
    }

    #[test]
    fn a_cli_older_than_the_windows_installer_cannot_install_the_app() {
        assert!(is_cli_too_old(Some("0.9.20")));
        assert!(is_cli_too_old(Some("0.9.9")));
        assert!(!is_cli_too_old(Some("0.9.21")));
        assert!(!is_cli_too_old(Some("0.9.23")));
        // Nothing known means nothing to refuse; the spawn itself reports a missing CLI.
        assert!(!is_cli_too_old(None));
        assert!(!is_cli_too_old(Some("")));
    }

    #[test]
    fn keys_never_reach_the_window() {
        assert_eq!(
            scrub("npm ERR! ANTHROPIC_API_KEY=sk-ant-api03-AbCd_1234-xyz failed"),
            "npm ERR! ANTHROPIC_API_KEY=sk-ant-*** failed"
        );
        assert_eq!(
            scrub("using sk-proj-0123456789abcdefghij now"),
            "using sk-*** now"
        );
        // Under sixteen characters is a word, not a key, and stays legible.
        assert_eq!(scrub("sk-short"), "sk-short");
        assert_eq!(
            scrub("Authorization: Bearer eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSM"),
            "Authorization: Bearer ***"
        );
        assert_eq!(
            scrub("token eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSM here"),
            "token eyJ*** here"
        );
        assert_eq!(scrub("bearer\tsecret-value"), "Bearer ***");
        // eyJ that is not a JWT is left alone rather than eaten.
        assert_eq!(scrub("eyJnope"), "eyJnope");
        // Multi-byte text is carried through rather than sliced through the middle.
        assert_eq!(scrub("café beareré"), "café beareré");
        // The token runs to the next whitespace, as the mac's `Bearers+S+` does, so a
        // trailing quotation mark goes with it rather than being left behind as a clue.
        assert_eq!(
            scrub("“Bearer abc123” and on"),
            "“Bearer *** and on"
        );
    }

    #[test]
    fn scrubbing_also_strips_nuls_and_caps_the_length() {
        assert_eq!(scrub("  ok\u{0000}ay \n"), "okay");
        let long = "x".repeat(MAX_DISPLAYED_CHARS + 500);
        let scrubbed = scrub(&long);
        assert_eq!(scrubbed.chars().count(), MAX_DISPLAYED_CHARS + 3);
        assert!(scrubbed.ends_with("..."));
    }

    #[test]
    fn a_failed_stage_says_which_one_and_why() {
        let timed_out = Run {
            code: None,
            stderr: String::new(),
            spawn_error: None,
            timed_out: true,
        };
        assert!(timed_out.failure_message("The CLI update").contains("120s"));
        let refused = Run {
            code: Some(1),
            stderr: "npm ERR! code EACCES".into(),
            spawn_error: None,
            timed_out: false,
        };
        assert_eq!(refused.failure_message("The CLI update"), "npm ERR! code EACCES");
        let quiet = Run {
            code: Some(3),
            stderr: String::new(),
            spawn_error: None,
            timed_out: false,
        };
        assert_eq!(
            quiet.failure_message("The app update"),
            "The app update failed (exit 3)."
        );
        assert!(!quiet.succeeded());
    }
}
