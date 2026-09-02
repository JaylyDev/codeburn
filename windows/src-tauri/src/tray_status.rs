//! What the tray says without being clicked: the flame's colour and the number beside it.
//!
//! Two jobs, both ported from the macOS status item (CodeBurnApp.swift refreshStatusButton and
//! Data/MenubarStatusCache.swift). The flame takes the worst connected provider's quota
//! severity, or yellow when today's spend is over the daily budget, and stays untinted the
//! rest of the time. The badge figure and the tooltip are written to disk on every refresh so
//! a relaunch shows the last known number instead of a blank tray for one CLI round trip.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::image::Image;

/// The tray logo, embedded so a tint can be applied without going back to disk.
const TRAY_PNG: &[u8] = include_bytes!("../icons/tray.png");

/// The quota severity ladder from QuotaSummary.Severity. Normal keeps the untinted logo, so
/// the tray only ever gains colour when there is something to say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Normal,
    Warning,
    Critical,
    Danger,
}

impl Severity {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "normal" => Some(Self::Normal),
            "warning" => Some(Self::Warning),
            "critical" => Some(Self::Critical),
            "danger" => Some(Self::Danger),
            _ => None,
        }
    }

    /// The mac's systemYellow / systemOrange / systemRed.
    fn tint(self) -> Option<[u8; 3]> {
        match self {
            Self::Normal => None,
            Self::Warning => Some([0xFF, 0xCC, 0x00]),
            Self::Critical => Some([0xFF, 0x95, 0x00]),
            Self::Danger => Some([0xFF, 0x3B, 0x30]),
        }
    }
}

/// The tint the tray logo should carry. Severity wins; being over the daily budget only
/// colours a flame that quota left alone, exactly as the mac orders the two.
pub fn tint_for(severity: Severity, over_budget: bool) -> Option<[u8; 3]> {
    severity
        .tint()
        .or(if over_budget { Some([0xFF, 0xCC, 0x00]) } else { None })
}

/// The logo recoloured in place: alpha is the shape, so only the colour channels move. An
/// untinted request returns the artwork as shipped.
pub fn tray_icon(tint: Option<[u8; 3]>) -> Result<Image<'static>> {
    let image = Image::from_bytes(TRAY_PNG).context("failed to decode the tray icon")?;
    let (width, height) = (image.width(), image.height());
    let mut rgba = image.rgba().to_vec();
    if let Some(color) = tint {
        for pixel in rgba.chunks_exact_mut(4) {
            if pixel[3] == 0 {
                continue;
            }
            pixel[0] = color[0];
            pixel[1] = color[1];
            pixel[2] = color[2];
        }
    }
    Ok(Image::new_owned(rgba, width, height))
}

/// Today's spend limit, shared with the CLI's config. Absent or zero means no budget, which
/// is the default until the settings window can write one.
pub fn daily_budget() -> Option<f64> {
    let path = dirs::home_dir()?.join(".config/codeburn/config.json");
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let budget = value.get("dailyBudget")?.as_f64()?;
    (budget > 0.0).then_some(budget)
}

/// The badge text and tooltip from the last successful refresh.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TrayStatus {
    #[serde(default)]
    pub badge: Option<String>,
    #[serde(default)]
    pub tooltip: Option<String>,
}

fn status_path() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join("codeburn-menubar").join("status.json"))
}

/// The stored status, but only while it is younger than `max_age`. Age comes from the file's
/// mtime, as on the mac: a stale figure in the tray is worse than an empty one.
pub fn read_status(max_age: Duration) -> Option<TrayStatus> {
    read_status_from(&status_path()?, max_age)
}

fn read_status_from(path: &std::path::Path, max_age: Duration) -> Option<TrayStatus> {
    let age = SystemTime::now()
        .duration_since(fs::metadata(path).ok()?.modified().ok()?)
        .ok()?;
    if age > max_age {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Merges one field into the stored status. Both fields are written by separate refresh
/// paths, so neither may clear the other.
pub fn write_status(update: impl FnOnce(&mut TrayStatus)) -> Result<()> {
    let path = status_path().context("no local app data directory")?;
    let mut status = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => TrayStatus::default(),
    };
    update(&mut status);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_vec(&status)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_tints_only_once_there_is_something_to_say() {
        assert_eq!(tint_for(Severity::Normal, false), None);
        assert_eq!(tint_for(Severity::Warning, false), Some([0xFF, 0xCC, 0x00]));
        assert_eq!(tint_for(Severity::Critical, false), Some([0xFF, 0x95, 0x00]));
        assert_eq!(tint_for(Severity::Danger, false), Some([0xFF, 0x3B, 0x30]));
    }

    #[test]
    fn the_budget_only_colours_a_flame_quota_left_alone() {
        assert_eq!(tint_for(Severity::Normal, true), Some([0xFF, 0xCC, 0x00]));
        assert_eq!(tint_for(Severity::Danger, true), Some([0xFF, 0x3B, 0x30]));
    }

    #[test]
    fn an_unknown_severity_is_rejected_rather_than_guessed() {
        assert_eq!(Severity::parse("danger"), Some(Severity::Danger));
        assert_eq!(Severity::parse("DANGER"), None);
        assert_eq!(Severity::parse(""), None);
    }

    fn temp_status(name: &str, contents: &str) -> PathBuf {
        let path = std::env::temp_dir().join(name);
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn a_fresh_status_file_is_read_back() {
        let path = temp_status("codeburn-status-fresh.json", r#"{"badge":"$12","tooltip":"t"}"#);
        let status = read_status_from(&path, Duration::from_secs(600)).unwrap();
        assert_eq!(status.badge.as_deref(), Some("$12"));
        assert_eq!(status.tooltip.as_deref(), Some("t"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn an_expired_or_unreadable_status_file_is_ignored() {
        let stale = temp_status("codeburn-status-stale.json", r#"{"badge":"$12"}"#);
        assert!(read_status_from(&stale, Duration::ZERO).is_none());
        let torn = temp_status("codeburn-status-torn.json", "{not json");
        assert!(read_status_from(&torn, Duration::from_secs(600)).is_none());
        assert!(read_status_from(std::path::Path::new("no-such-status.json"), Duration::from_secs(600)).is_none());
        let _ = fs::remove_file(stale);
        let _ = fs::remove_file(torn);
    }

    #[test]
    fn tinting_moves_colour_but_keeps_the_shape() {
        let plain = tray_icon(None).unwrap();
        let tinted = tray_icon(Some([0xFF, 0x3B, 0x30])).unwrap();
        assert_eq!(plain.width(), tinted.width());
        assert_eq!(plain.rgba().len(), tinted.rgba().len());
        let alpha = |image: &Image<'_>| image.rgba().iter().skip(3).step_by(4).map(|a| *a as u64).sum::<u64>();
        assert_eq!(alpha(&plain), alpha(&tinted));
        assert!(
            tinted
                .rgba()
                .chunks_exact(4)
                .filter(|p| p[3] > 0)
                .all(|p| p[0] == 0xFF && p[1] == 0x3B && p[2] == 0x30),
            "every visible pixel takes the tint"
        );
    }
}
