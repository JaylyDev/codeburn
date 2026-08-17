use std::env;
use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// Hard bounds mirror the macOS CodeburnCLI / DataClient design. A malicious or stuck CLI
/// cannot pin the Tauri process: stdout is capped, stderr is bounded, total wall time is
/// 60s. A hostile CODEBURN_BIN is rejected before any shell-resembling path is taken.
const MAX_PAYLOAD_BYTES: usize = 20 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 256 * 1024;
const FETCH_TIMEOUT_SECS: u64 = 60;
const VERSION_TIMEOUT_SECS: u64 = 20;

/// Oldest CLI that emits the `menubar-json` shape this app renders (history.daily with
/// per-day model breakdown, providers map). Older CLIs get the setup screen instead of a
/// half-rendered popover.
pub const MIN_CLI_VERSION: (u32, u32, u32) = (0, 7, 0);

#[cfg(windows)]
const WINDOWS_CLI_NAMES: [&str; 2] = ["codeburn.cmd", "codeburn.exe"];

/// Alphanumerics plus `._/-` and space, with `\`, `:`, `(`, `)` also allowed on Windows
/// so a user-supplied `CODEBURN_BIN` path like `C:\Users\...\codeburn.cmd` is accepted.
/// None of these are shell metacharacters in a direct-argv spawn (we never invoke `sh -c`).
fn is_safe_arg(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '.' | '_' | '/' | '-' | ' ')
                || (cfg!(windows) && matches!(c, '\\' | ':' | '(' | ')'))
        })
}

#[derive(Clone, Debug)]
pub struct CodeburnCli {
    program: String,
    extra_args: Vec<String>,
}

/// What the setup screen needs to know about the CLI on this machine.
#[derive(Clone, Debug, Serialize)]
pub struct CliStatus {
    pub found: bool,
    pub program: String,
    pub version: Option<String>,
    pub min_version: String,
    pub compatible: bool,
    pub error: Option<String>,
}

impl CodeburnCli {
    /// Honours `CODEBURN_BIN` only when every whitespace-delimited token passes the
    /// allowlist. Otherwise resolves `codeburn` from PATH and the usual npm locations.
    pub fn resolve() -> Self {
        let raw = env::var("CODEBURN_BIN").unwrap_or_default();
        if raw.is_empty() {
            return Self::default_program();
        }
        let parts: Vec<String> = raw.split_whitespace().map(String::from).collect();
        if parts.iter().all(|p| is_safe_arg(p)) {
            if let Some((first, rest)) = parts.split_first() {
                return CodeburnCli {
                    program: first.clone(),
                    extra_args: rest.to_vec(),
                };
            }
        }
        eprintln!("codeburn-desktop: refusing unsafe CODEBURN_BIN; falling back to `codeburn`");
        Self::default_program()
    }

    fn default_program() -> Self {
        CodeburnCli {
            program: locate_cli().unwrap_or_else(default_program_name),
            extra_args: vec![],
        }
    }

    pub fn program(&self) -> &str {
        &self.program
    }

    /// Runs `codeburn --version` and reports whether the CLI is present and new enough.
    pub async fn status(&self) -> CliStatus {
        let min_version = format!(
            "{}.{}.{}",
            MIN_CLI_VERSION.0, MIN_CLI_VERSION.1, MIN_CLI_VERSION.2
        );
        let mut status = CliStatus {
            found: false,
            program: self.program.clone(),
            version: None,
            min_version,
            compatible: false,
            error: None,
        };
        match self.run_capture(&["--version"], VERSION_TIMEOUT_SECS).await {
            Ok(out) => {
                let version = out.trim().to_string();
                status.found = true;
                status.compatible = parse_version(&version)
                    .map(|v| v >= MIN_CLI_VERSION)
                    .unwrap_or(false);
                status.version = Some(version);
            }
            Err(err) => {
                status.error = Some(err.to_string());
            }
        }
        status
    }

    /// Spawns `codeburn status --format menubar-json --period X --provider Y` and decodes the
    /// output. Pipes are drained concurrently so a chatty stderr cannot deadlock stdout.
    pub async fn fetch_menubar_payload(
        &self,
        period: &str,
        provider: &str,
        include_optimize: bool,
    ) -> Result<Value> {
        if !is_safe_arg(period) || !is_safe_arg(provider) {
            bail!("invalid period/provider argument");
        }

        let mut args = vec![
            "status",
            "--format",
            "menubar-json",
            "--period",
            period,
            "--provider",
            provider,
        ];
        if !include_optimize {
            args.push("--no-optimize");
        }

        let stdout = self.run_capture(&args, FETCH_TIMEOUT_SECS).await?;
        let payload: Value =
            serde_json::from_str(&stdout).with_context(|| "CLI returned invalid JSON")?;
        Ok(payload)
    }

    async fn run_capture(&self, args: &[&str], timeout_secs: u64) -> Result<String> {
        let mut full_args = self.extra_args.clone();
        full_args.extend(args.iter().map(|s| s.to_string()));

        let mut cmd = Command::new(&self.program);
        cmd.args(&full_args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|err| {
            anyhow!(
                "CodeBurn CLI not found ({}). Install it with `npm install -g codeburn`.",
                spawn_error_summary(&self.program, &err)
            )
        })?;

        let mut stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let mut stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;

        let stdout_task = tokio::spawn(async move {
            let mut buf = Vec::with_capacity(64 * 1024);
            let mut limited = (&mut stdout).take(MAX_PAYLOAD_BYTES as u64);
            limited.read_to_end(&mut buf).await.ok();
            buf
        });
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::with_capacity(4 * 1024);
            let mut limited = (&mut stderr).take(MAX_STDERR_BYTES as u64);
            limited.read_to_end(&mut buf).await.ok();
            buf
        });

        let status = timeout(Duration::from_secs(timeout_secs), child.wait())
            .await
            .map_err(|_| anyhow!("codeburn CLI timed out after {}s", timeout_secs))??;

        let stdout_bytes = stdout_task.await.unwrap_or_default();
        let stderr_bytes = stderr_task.await.unwrap_or_default();

        if !status.success() {
            let msg = String::from_utf8_lossy(&stderr_bytes);
            bail!("codeburn CLI exited {}: {}", status, msg.trim());
        }
        Ok(String::from_utf8_lossy(&stdout_bytes).into_owned())
    }
}

fn spawn_error_summary(program: &str, err: &std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("{} is not on PATH", program),
        _ => format!("{}: {}", program, err),
    }
}

fn default_program_name() -> String {
    #[cfg(windows)]
    {
        "codeburn.cmd".to_string()
    }
    #[cfg(not(windows))]
    {
        "codeburn".to_string()
    }
}

/// Parses "0.7.3" or "codeburn 0.7.3" into a comparable tuple.
pub fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let token = text
        .split_whitespace()
        .find(|t| t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))?;
    let mut parts = token.split('.').map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u32>()
            .ok()
    });
    Some((parts.next()??, parts.next()??, parts.next().flatten().unwrap_or(0)))
}

/// Locates the CLI without relying on the inherited PATH being fresh. A tray app is often
/// launched from Explorer or at login, before (or long after) `npm install -g codeburn`
/// changed the user's PATH, so we also read the live PATH from the registry on Windows and
/// probe the standard npm / node install prefixes.
fn locate_cli() -> Option<String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&path));
    }
    dirs.extend(extra_search_dirs());

    for dir in dirs {
        for name in candidate_names() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn candidate_names() -> Vec<&'static str> {
    #[cfg(windows)]
    {
        WINDOWS_CLI_NAMES.to_vec()
    }
    #[cfg(not(windows))]
    {
        vec!["codeburn"]
    }
}

#[cfg(windows)]
fn extra_search_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for var in ["APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(base) = env::var_os(var).map(PathBuf::from) {
            match var {
                "APPDATA" => out.push(base.join("npm")),
                "LOCALAPPDATA" => {
                    out.push(base.join("Programs").join("nodejs"));
                    out.push(base.join("pnpm"));
                    out.push(base.join("Volta").join("bin"));
                    out.push(base.join("fnm_multishells"));
                }
                _ => out.push(base.join("nodejs")),
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("scoop").join("shims"));
        out.push(home.join(".bun").join("bin"));
    }
    out.extend(registry_path_dirs());
    out
}

#[cfg(not(windows))]
fn extra_search_dirs() -> Vec<PathBuf> {
    let mut out = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".npm-global").join("bin"));
        out.push(home.join(".local").join("bin"));
    }
    out
}

/// Reads the user and machine PATH values from the registry via `reg.exe` so a PATH edit
/// made after this process started (npm install adds `%APPDATA%\npm`) is still honoured.
#[cfg(windows)]
fn registry_path_dirs() -> Vec<PathBuf> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut out = Vec::new();
    let keys = [
        r"HKCU\Environment",
        r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    ];
    for key in keys {
        let output = std::process::Command::new("reg")
            .args(["query", key, "/v", "Path"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let Ok(output) = output else { continue };
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("Path") {
                continue;
            }
            let Some(idx) = trimmed.find("REG_") else { continue };
            let rest = &trimmed[idx..];
            let Some(space) = rest.find(char::is_whitespace) else { continue };
            let value = rest[space..].trim();
            for part in value.split(';') {
                let expanded = expand_env(part.trim());
                if !expanded.is_empty() {
                    out.push(PathBuf::from(expanded));
                }
            }
        }
    }
    out
}

#[cfg(windows)]
fn expand_env(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match env::var(name) {
                    Ok(v) => result.push_str(&v),
                    Err(_) => {
                        result.push('%');
                        result.push_str(name);
                        result.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                result.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    result.push_str(rest);
    result
}

/// Runs a codeburn subcommand in the user's terminal emulator so they can see the output.
/// Linux: tries `x-terminal-emulator`, `gnome-terminal`, `konsole`, then falls back to a
/// detached headless spawn. Windows: opens a console via `cmd /C start`. Never
/// interpolates through a shell -- argv throughout.
pub fn spawn_in_terminal(app: &AppHandle, subcommand: &[&str]) -> Result<()> {
    let cli = CodeburnCli::resolve();
    spawn_program_in_terminal(app, &cli, subcommand)
}

/// The Plan view's "Connect Claude" runs Claude Code's own login flow, not codeburn.
pub fn spawn_claude_login(app: &AppHandle) -> Result<()> {
    #[cfg(windows)]
    let program = "claude.cmd";
    #[cfg(not(windows))]
    let program = "claude";
    let cli = CodeburnCli {
        program: program.to_string(),
        extra_args: vec![],
    };
    spawn_program_in_terminal(app, &cli, &["login"])
}

fn spawn_program_in_terminal(_app: &AppHandle, cli: &CodeburnCli, subcommand: &[&str]) -> Result<()> {
    if !subcommand.iter().all(|s| is_safe_arg(s)) {
        bail!("unsafe subcommand argument");
    }

    #[cfg(target_os = "linux")]
    {
        let terminals: [&[&str]; 4] = [
            &["x-terminal-emulator", "-e"],
            &["gnome-terminal", "--", "bash", "-lc"],
            &["konsole", "-e"],
            &["xterm", "-e"],
        ];
        for term in &terminals {
            let program = term[0];
            let extras = &term[1..];
            if which::which(program).is_ok() {
                let mut command_parts: Vec<String> = vec![cli.program.clone()];
                command_parts.extend(cli.extra_args.clone());
                command_parts.extend(subcommand.iter().map(|s| s.to_string()));
                // gnome-terminal wants the whole command as a single argv after `--`
                // followed by `bash -lc`. The allowlist guarantees no quoting is needed.
                let composite = command_parts.join(" ");
                let mut cmd = std::process::Command::new(program);
                cmd.args(extras);
                cmd.arg(&composite);
                cmd.spawn().with_context(|| format!("failed to launch {}", program))?;
                return Ok(());
            }
        }
        // Fallback: run detached, output lost -- better than silently doing nothing.
        std::process::Command::new(&cli.program)
            .args(&cli.extra_args)
            .args(subcommand)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| "no terminal emulator found, detached spawn also failed")?;
    }

    #[cfg(target_os = "windows")]
    {
        // `start` treats the first quoted argument as the window title, so we pass an
        // explicit empty title. `/K` keeps the console open for non-interactive commands
        // (export) so the user can read where the file went; the TUI (report/optimize)
        // owns the window until the user quits it either way.
        let is_codeburn = cli.program.starts_with("codeburn");
        let program = if std::path::Path::new(&cli.program).is_absolute() || !is_codeburn {
            cli.program.clone()
        } else {
            locate_cli().unwrap_or_else(|| cli.program.clone())
        };
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg("start").arg("").arg("cmd").arg("/K").arg(&program);
        for a in &cli.extra_args {
            cmd.arg(a);
        }
        for a in subcommand {
            cmd.arg(a);
        }
        cmd.spawn().with_context(|| "failed to open cmd.exe")?;
    }

    #[cfg(target_os = "macos")]
    {
        // macOS isn't our target for this app (Swift handles Mac), but keep dev-on-Mac working.
        std::process::Command::new(&cli.program)
            .args(&cli.extra_args)
            .args(subcommand)
            .spawn()
            .with_context(|| format!("failed to spawn {}", cli.program))?;
    }

    Ok(())
}

/// Minimal dependency: we only use `which` inside spawn_in_terminal on Linux. Vendored here
/// so the crate graph stays tiny. Gated so the unused-function warning doesn't fire on Mac
/// or Windows builds.
#[cfg(target_os = "linux")]
mod which {
    use std::env;
    use std::path::PathBuf;

    pub fn which(program: &str) -> Result<PathBuf, ()> {
        let path = env::var_os("PATH").ok_or(())?;
        for dir in env::split_paths(&path) {
            let candidate = dir.join(program);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        Err(())
    }
}
