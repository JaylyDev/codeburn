//! How often the background usage refresh may spawn a CLI run, and what the machine is
//! doing while it decides. Port of `mac/.../RefreshCadence.swift`.
//!
//! The page owns the loop; this owns the arithmetic and the two questions the arithmetic
//! needs answering (is the machine on battery, is it saving power), because both are Win32
//! reads that have no business in a webview. Every fetch is a full Node process, so a
//! popover nobody is looking at has to cost less than one somebody is.

use serde::Serialize;

/// A popover on screen is ground truth: the reader is looking at these numbers.
pub const ACTIVE_SECS: u64 = 30;
pub const AC_IDLE_SECS: u64 = 120;
pub const BATTERY_IDLE_SECS: u64 = 150;
pub const SAVER_IDLE_SECS: u64 = 300;

/// `UsageRefreshCadence`, stored as raw seconds in `windows-settings.json`, with the mac's
/// two sentinel values: auto is adaptive, manual never spawns on a timer.
pub const AUTO: i64 = -1;
pub const MANUAL: i64 = 0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    pub on_battery: bool,
    /// Windows battery saver, the counterpart of the mac's Low Power Mode.
    pub battery_saver: bool,
}

/// `None` means "never auto-spawn": usage then refreshes only on popover open, Refresh Now,
/// wake and first launch.
pub fn interval_secs(mode: i64, popover_open: bool, power: PowerState) -> Option<u64> {
    match mode {
        MANUAL => None,
        AUTO => Some(if popover_open {
            ACTIVE_SECS
        } else if power.battery_saver {
            SAVER_IDLE_SECS
        } else if power.on_battery {
            BATTERY_IDLE_SECS
        } else {
            AC_IDLE_SECS
        }),
        // A fixed cadence the reader chose, except that an open popover always gets the
        // active one: they are looking at the numbers.
        seconds if seconds > 0 => {
            let seconds = seconds as u64;
            Some(if popover_open {
                seconds.min(ACTIVE_SECS)
            } else {
                seconds
            })
        }
        // A negative value that is not the auto sentinel is a hand-edited file; treat it as
        // the default rather than as a cadence.
        _ => interval_secs(AUTO, popover_open, power),
    }
}

#[cfg(target_os = "windows")]
pub fn power_state() -> PowerState {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    // AC line status 1 is plugged in, 0 is on battery and 255 is "unknown", which is what a
    // desktop with no battery reports. Only a definite 0 counts as battery, so a machine
    // that cannot answer keeps the AC cadence rather than being backed off forever.
    const AC_OFFLINE: u8 = 0;
    const BATTERY_SAVER_ON: u8 = 1;

    let mut status = SYSTEM_POWER_STATUS {
        ACLineStatus: 255,
        BatteryFlag: 255,
        BatteryLifePercent: 255,
        SystemStatusFlag: 0,
        BatteryLifeTime: u32::MAX,
        BatteryFullLifeTime: u32::MAX,
    };
    if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
        return PowerState::default();
    }
    PowerState {
        on_battery: status.ACLineStatus == AC_OFFLINE,
        battery_saver: status.SystemStatusFlag == BATTERY_SAVER_ON,
    }
}

#[cfg(not(target_os = "windows"))]
pub fn power_state() -> PowerState {
    PowerState::default()
}

/// What the page's refresh loop is told on every tick: how long to wait for the next one.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshPlan {
    /// `null` in Manual mode, which stops the loop until the setting or the popover changes.
    pub interval_ms: Option<u64>,
    pub power: PowerState,
}

pub fn plan(mode: i64, popover_open: bool) -> RefreshPlan {
    let power = power_state();
    let plan = RefreshPlan {
        interval_ms: interval_secs(mode, popover_open, power).map(|secs| secs * 1000),
        power,
    };
    #[cfg(debug_assertions)]
    eprintln!(
        "codeburn: refresh plan mode={mode} popover={popover_open} battery={} saver={} interval={:?}",
        power.on_battery, power.battery_saver, plan.interval_ms
    );
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    const AC: PowerState = PowerState {
        on_battery: false,
        battery_saver: false,
    };
    const BATTERY: PowerState = PowerState {
        on_battery: true,
        battery_saver: false,
    };
    const SAVER: PowerState = PowerState {
        on_battery: true,
        battery_saver: true,
    };

    #[test]
    fn manual_never_spawns_however_the_machine_is_running() {
        for power in [AC, BATTERY, SAVER] {
            assert_eq!(interval_secs(MANUAL, true, power), None);
            assert_eq!(interval_secs(MANUAL, false, power), None);
        }
    }

    #[test]
    fn auto_backs_off_as_the_machine_loses_power() {
        assert_eq!(interval_secs(AUTO, false, AC), Some(AC_IDLE_SECS));
        assert_eq!(interval_secs(AUTO, false, BATTERY), Some(BATTERY_IDLE_SECS));
        assert_eq!(interval_secs(AUTO, false, SAVER), Some(SAVER_IDLE_SECS));
    }

    #[test]
    fn an_open_popover_always_gets_the_active_cadence() {
        for power in [AC, BATTERY, SAVER] {
            assert_eq!(interval_secs(AUTO, true, power), Some(ACTIVE_SECS));
        }
        // A chosen cadence longer than the active one is shortened while the popover is up,
        // and one shorter than it is left alone.
        assert_eq!(interval_secs(900, true, AC), Some(ACTIVE_SECS));
        assert_eq!(interval_secs(15, true, AC), Some(15));
    }

    #[test]
    fn a_chosen_cadence_is_what_it_says_while_the_popover_is_closed() {
        assert_eq!(interval_secs(60, false, AC), Some(60));
        assert_eq!(interval_secs(300, false, BATTERY), Some(300));
        assert_eq!(interval_secs(900, false, SAVER), Some(900));
    }

    #[test]
    fn a_value_no_build_ever_stored_falls_back_to_auto() {
        assert_eq!(interval_secs(-7, false, AC), Some(AC_IDLE_SECS));
    }
}
