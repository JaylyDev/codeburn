//! The slice of the menubar payload the Capacity Dock's glance bubble draws: the sessions
//! running right now and today's totals. The counterpart of the mac's
//! `AppStore.capacityDockLiveSessions` and `AppStore.capacityDockToday`, which read the
//! payload the app already holds.
//!
//! The dock lives in a window of its own with no payload of its own, and the popover's
//! `fetch_payload` already runs the CLI. So the answer is cached here as it goes past,
//! broadcast on `codeburn://glance`, and served to the dock through `dock_glance`; the dock
//! only ever spawns a CLI run of its own when nothing has been cached yet.

use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;

/// Today's totals, as the glance's Today strip needs them. Cache counts travel with them
/// because the payload carries them and a reader asking what today cost is the same reader
/// asking what it was spent on.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Today {
    pub cost: f64,
    pub calls: u64,
    pub sessions: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

/// What the dock is handed. Both halves are optional and mean different things when absent:
/// `live_sessions` absent is "the CLI never said", so the section hides rather than claiming
/// nothing is running; `today` absent is "no today payload has come back yet".
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Glance {
    /// The payload's `liveSessions` block, passed through untouched so a field the CLI grows
    /// reaches the page without a change here.
    pub live_sessions: Option<Value>,
    pub today: Option<Today>,
}

fn number(block: &Value, key: &str) -> f64 {
    block.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn count(block: &Value, key: &str) -> u64 {
    let value = number(block, key);
    if value.is_finite() && value > 0.0 {
        value as u64
    } else {
        0
    }
}

/// The `liveSessions` block, or None when the payload carries none at all (a CLI older than
/// the block). An empty session list is an answer and is kept.
pub fn live_sessions_of(payload: &Value) -> Option<Value> {
    let block = payload.get("liveSessions")?;
    block.get("sessions")?.as_array()?;
    Some(block.clone())
}

pub fn today_of(payload: &Value) -> Option<Today> {
    let current = payload.get("current")?;
    Some(Today {
        cost: number(current, "cost"),
        calls: count(current, "calls"),
        sessions: count(current, "sessions"),
        input_tokens: count(current, "inputTokens"),
        output_tokens: count(current, "outputTokens"),
        cache_read_tokens: count(current, "cacheReadTokens"),
        cache_write_tokens: count(current, "cacheWriteTokens"),
    })
}

/// Whether this request is the one whose `current` block is today's. The popover fetches
/// several keys and only this one answers "what has today cost": a week's totals under a
/// heading that says Today would be a lie.
pub fn is_today_key(period: &str, provider: &str, days: &[String], scope: &str) -> bool {
    period == "today" && provider == "all" && scope == "local" && days.is_empty()
}

#[derive(Default)]
pub struct GlanceCache {
    inner: Mutex<Option<Glance>>,
}

impl GlanceCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Folds a payload into the cache and says whether anything moved, so a poll that
    /// answered the same thing does not wake the dock. Live sessions ride on every payload;
    /// today's totals only on the request that asked for today.
    pub fn record(&self, payload: &Value, is_today: bool) -> Option<Glance> {
        let mut guard = self.inner.lock().ok()?;
        let mut next = guard.clone().unwrap_or_default();
        if let Some(sessions) = live_sessions_of(payload) {
            next.live_sessions = Some(sessions);
        }
        if is_today {
            if let Some(today) = today_of(payload) {
                next.today = Some(today);
            }
        }
        if guard.as_ref() == Some(&next) {
            return None;
        }
        *guard = Some(next.clone());
        Some(next)
    }

    pub fn snapshot(&self) -> Option<Glance> {
        self.inner.lock().ok().and_then(|guard| guard.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(live: Option<Value>, cost: f64) -> Value {
        let mut value = json!({
            "current": {
                "cost": cost,
                "calls": 1513,
                "sessions": 6,
                "inputTokens": 135040,
                "outputTokens": 238270,
                "cacheReadTokens": 696179871,
                "cacheWriteTokens": 4866152,
            }
        });
        if let Some(live) = live {
            value["liveSessions"] = live;
        }
        value
    }

    fn live(count: usize) -> Value {
        let sessions: Vec<Value> = (0..count)
            .map(|index| json!({ "id": format!("s{index}"), "provider": "claude" }))
            .collect();
        json!({ "windowSeconds": 600, "sessions": sessions })
    }

    #[test]
    fn today_reads_every_total_the_strip_draws() {
        let today = today_of(&payload(None, 385.27)).unwrap();
        assert_eq!(today.cost, 385.27);
        assert_eq!(today.calls, 1513);
        assert_eq!(today.sessions, 6);
        assert_eq!(today.input_tokens, 135_040);
        assert_eq!(today.output_tokens, 238_270);
        assert_eq!(today.cache_read_tokens, 696_179_871);
        assert_eq!(today.cache_write_tokens, 4_866_152);
    }

    #[test]
    fn a_payload_without_the_block_reads_as_unknown_not_as_empty() {
        assert!(live_sessions_of(&payload(None, 1.0)).is_none());
        let empty = live_sessions_of(&payload(Some(live(0)), 1.0)).unwrap();
        assert_eq!(empty["sessions"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn only_the_today_key_may_write_todays_totals() {
        assert!(is_today_key("today", "all", &[], "local"));
        assert!(!is_today_key("week", "all", &[], "local"));
        assert!(!is_today_key("today", "claude", &[], "local"));
        assert!(!is_today_key("today", "all", &[], "combined"));
        assert!(!is_today_key(
            "today",
            "all",
            &["2026-09-01".to_string()],
            "local"
        ));
    }

    #[test]
    fn a_non_today_payload_still_carries_its_live_sessions() {
        let cache = GlanceCache::new();
        assert!(cache.record(&payload(Some(live(1)), 9.0), false).is_some());
        let snapshot = cache.snapshot().unwrap();
        assert!(snapshot.today.is_none());
        assert_eq!(snapshot.live_sessions.unwrap()["sessions"][0]["id"], "s0");
    }

    #[test]
    fn an_unchanged_answer_does_not_wake_the_dock() {
        let cache = GlanceCache::new();
        assert!(cache.record(&payload(Some(live(1)), 9.0), true).is_some());
        assert!(cache.record(&payload(Some(live(1)), 9.0), true).is_none());
        assert!(cache.record(&payload(Some(live(2)), 9.0), true).is_some());
        assert!(cache.record(&payload(Some(live(2)), 9.5), true).is_some());
    }

    #[test]
    fn a_later_payload_never_blanks_what_the_cache_already_holds() {
        let cache = GlanceCache::new();
        cache.record(&payload(Some(live(1)), 9.0), true);
        // A provider-scoped fetch from an older CLI: no block, and not today's numbers.
        assert!(cache.record(&payload(None, 3.0), false).is_none());
        let snapshot = cache.snapshot().unwrap();
        assert_eq!(snapshot.today.unwrap().cost, 9.0);
        assert!(snapshot.live_sessions.is_some());
    }
}
