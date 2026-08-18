use std::fs;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct CurrencyConfig {
    #[serde(default, flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn codeburn_config_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".config/codeburn"))
        .unwrap_or_else(|| PathBuf::from(".codeburn"))
}

fn config_path() -> PathBuf {
    codeburn_config_dir().join("config.json")
}

fn lock_path() -> PathBuf {
    codeburn_config_dir().join(".config.lock")
}

impl CurrencyConfig {
    pub fn load_or_default() -> Self {
        match fs::read(config_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn set_currency(&mut self, code: &str, symbol: &str) -> Result<()> {
        fs::create_dir_all(codeburn_config_dir())
            .with_context(|| "failed to create ~/.config/codeburn")?;

        #[cfg(unix)]
        let _lock = unix_lock::acquire()?;
        #[cfg(windows)]
        let _lock = windows_lock::acquire()?;

        let mut disk: serde_json::Value = match fs::read(config_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({})),
            Err(_) => serde_json::json!({}),
        };

        if code == "USD" {
            if let Some(obj) = disk.as_object_mut() {
                obj.remove("currency");
            }
        } else if let Some(obj) = disk.as_object_mut() {
            obj.insert(
                "currency".into(),
                serde_json::json!({ "code": code, "symbol": symbol }),
            );
        }

        let serialized = serde_json::to_vec_pretty(&disk)?;
        let tmp = config_path().with_extension("tmp");
        {
            let mut file = fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&tmp)?;
            file.write_all(&serialized)?;
            file.flush()?;
        }
        fs::rename(&tmp, config_path())?;

        *self = serde_json::from_value(disk).unwrap_or_default();
        Ok(())
    }
}

#[cfg(unix)]
mod unix_lock {
    use std::fs;
    use std::os::fd::AsRawFd;
    use anyhow::{anyhow, Context, Result};

    pub struct Guard {
        _file: fs::File,
    }

    pub fn acquire() -> Result<Guard> {
        let file = fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(super::lock_path())
            .with_context(|| "failed to open config lock")?;

        let fd = file.as_raw_fd();
        let ret = unsafe { flock(fd, 2) };
        if ret != 0 {
            return Err(anyhow!("flock failed: {}", std::io::Error::last_os_error()));
        }
        Ok(Guard { _file: file })
    }

    extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }
}

/// Windows has no flock; a create-new lock file gives the same mutual exclusion against
/// the CLI's own writer. Stale locks (crash mid-write) are ignored once older than
/// STALE_LOCK_SECS so a single crash can never wedge currency changes forever.
#[cfg(windows)]
mod windows_lock {
    use std::fs;
    use std::path::PathBuf;
    use std::thread::sleep;
    use std::time::{Duration, SystemTime};
    use anyhow::{anyhow, Result};

    const RETRY_INTERVAL: Duration = Duration::from_millis(40);
    const MAX_RETRIES: u32 = 50;
    const STALE_LOCK_SECS: u64 = 30;

    pub struct Guard {
        path: PathBuf,
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    pub fn acquire() -> Result<Guard> {
        let path = super::lock_path();
        for _ in 0..MAX_RETRIES {
            match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(Guard { path }),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    if is_stale(&path) {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    sleep(RETRY_INTERVAL);
                }
                Err(err) => return Err(anyhow!("failed to open config lock: {err}")),
            }
        }
        Err(anyhow!("config lock is held by another process"))
    }

    fn is_stale(path: &PathBuf) -> bool {
        fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .map(|age| age.as_secs() > STALE_LOCK_SECS)
            .unwrap_or(false)
    }
}
