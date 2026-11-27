use std::net::SocketAddr;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub admin_addr: SocketAddr,
    pub redis_url: String,
    pub control_plane_url: String,
    pub log_level: String,
    pub upstream_timeout: Duration,
    pub redis_key_prefix: String,
    pub parking: ParkingConfig,
    pub circuit_breaker: CircuitBreakerConfig,
    pub api_token: Option<String>,
    /// Optional static API keys for the inference port (#332). Empty = key
    /// disabled (today's behaviour). Multiple comma-separated keys allow
    /// zero-downtime rotation (D2); comparison is constant-time per key.
    pub inference_api_keys: Vec<String>,
    pub max_body_bytes: usize,
    /// Aggregate admission budget over all concurrently buffered inference
    /// bodies (#300). Default `268435456` (256 MiB) — enforcement is ON out of
    /// the box, the same fail-closed precedent as `max_body_bytes`. `0` is an
    /// explicit, WARN-logged unlimited opt-out (see `main.rs`); counting and the
    /// `sardeenz_proxy_buffered_body_bytes` gauge still run.
    pub max_buffered_bytes: usize,
    /// Max concurrently *forwarded* (in-flight upstream) requests across all
    /// models. `0` = unlimited. Deliberately independent of the parking
    /// limits — a request parked waiting for a sleeping model to wake holds
    /// no forwarding permit, so this cap cannot deadlock against parking.
    pub max_concurrent_forwards: usize,
    /// Max concurrently forwarded requests for a single model. `0` = unlimited.
    pub max_concurrent_forwards_per_model: usize,
}

#[derive(Debug, Clone)]
pub struct ParkingConfig {
    pub timeout: Duration,
    pub max_per_model: usize,
    pub max_global: usize,
    pub max_bytes: usize,
}

#[derive(Debug, Clone)]
pub struct CircuitBreakerConfig {
    pub failure_threshold: u32,
    pub failure_window: Duration,
    pub recovery_timeout: Duration,
    /// Window after which a claimed HalfOpen probe is considered leaked and
    /// re-claimable. Deliberately NOT a separate env var: it is derived as
    /// `max(recovery_timeout, upstream_timeout)` so an operator cannot set it
    /// below `upstream_timeout` and reintroduce the bug where a still-running
    /// legitimate probe (up to `upstream_timeout` long) gets treated as
    /// stranded and a new probe is admitted on top of it. The RAII
    /// `ProbeGuard` still clears cancelled/completed probes instantly, so
    /// half-open concurrency stays at 1 in the common case.
    pub probe_timeout: Duration,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let upstream_timeout =
            Duration::from_secs(parse_env("SARDEENZ_UPSTREAM_TIMEOUT_SECS", "300")?);
        let cb_recovery_timeout =
            Duration::from_secs(parse_env("SARDEENZ_CB_RECOVERY_TIMEOUT_SECS", "15")?);
        // A claimed probe is only "leaked" after the maximum time a legitimate
        // request could take (upstream_timeout), never before recovery_timeout
        // either — see CircuitBreakerConfig::probe_timeout doc comment.
        let probe_timeout = std::cmp::max(cb_recovery_timeout, upstream_timeout);

        Ok(Self {
            // Renamed from SARDEENZ_LISTEN_ADDR (which the control plane also reads) so a single
            // shared .env can set both ports independently; legacy name still honored as fallback.
            listen_addr: parse_env_with_legacy(
                "SARDEENZ_PROXY_LISTEN_ADDR",
                "SARDEENZ_LISTEN_ADDR",
                "0.0.0.0:8080",
            )?,
            admin_addr: parse_env("SARDEENZ_ADMIN_ADDR", "0.0.0.0:9099")?,
            redis_url: std::env::var("SARDEENZ_REDIS_URL")
                .unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string()),
            control_plane_url: std::env::var("SARDEENZ_CONTROL_PLANE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:3000".to_string()),
            log_level: std::env::var("SARDEENZ_LOG_LEVEL").unwrap_or_else(|_| "info".to_string()),
            upstream_timeout,
            redis_key_prefix: std::env::var("SARDEENZ_REDIS_KEY_PREFIX")
                .unwrap_or_else(|_| "sardeenz".to_string()),
            parking: ParkingConfig {
                timeout: Duration::from_secs(parse_env("SARDEENZ_PARKING_TIMEOUT_SECS", "120")?),
                max_per_model: parse_env("SARDEENZ_PARKING_MAX_PER_MODEL", "1000")?,
                max_global: parse_env("SARDEENZ_PARKING_MAX_GLOBAL", "10000")?,
                max_bytes: parse_env("SARDEENZ_PARKING_MAX_BYTES", "1073741824")?,
            },
            circuit_breaker: CircuitBreakerConfig {
                failure_threshold: parse_env("SARDEENZ_CB_FAILURE_THRESHOLD", "5")?,
                failure_window: Duration::from_secs(parse_env(
                    "SARDEENZ_CB_FAILURE_WINDOW_SECS",
                    "30",
                )?),
                recovery_timeout: cb_recovery_timeout,
                probe_timeout,
            },
            api_token: std::env::var("SARDEENZ_API_TOKEN").ok().filter(|s| !s.is_empty()),
            inference_api_keys: parse_inference_api_keys(std::env::var(
                "SARDEENZ_PROXY_INFERENCE_API_KEY",
            ))?,
            max_body_bytes: parse_env("SARDEENZ_PROXY_MAX_BODY_BYTES", "33554432")?,
            max_buffered_bytes: parse_env("SARDEENZ_PROXY_MAX_BUFFERED_BYTES", "268435456")?,
            max_concurrent_forwards: parse_env("SARDEENZ_PROXY_MAX_CONCURRENT_FORWARDS", "0")?,
            max_concurrent_forwards_per_model: parse_env(
                "SARDEENZ_PROXY_MAX_CONCURRENT_PER_MODEL",
                "0",
            )?,
        })
    }
}

fn parse_env<T: std::str::FromStr>(key: &str, default: &str) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    let val = std::env::var(key).unwrap_or_else(|_| default.to_string());
    val.parse::<T>().map_err(|e| anyhow::anyhow!("invalid value for {key}: {e}"))
}

/// Like [`parse_env`], but reads `legacy_key` when `key` is unset before falling back to `default`.
fn parse_env_with_legacy<T: std::str::FromStr>(
    key: &str,
    legacy_key: &str,
    default: &str,
) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    let val = std::env::var(key)
        .or_else(|_| std::env::var(legacy_key))
        .unwrap_or_else(|_| default.to_string());
    val.parse::<T>().map_err(|e| anyhow::anyhow!("invalid value for {key}: {e}"))
}

/// Parse `SARDEENZ_PROXY_INFERENCE_API_KEY` from the raw `std::env::var` result.
/// `NotPresent` → empty vec (key disabled, today's behaviour). Set → split on
/// ',', trim each segment; a segment that is empty after trim is a startup
/// error (fail closed, #268/ADR-022: an operator who set the variable intended
/// auth on; a blank key would be trivially guessable or a silent disable). The
/// trimmed segment is the stored key so the constant-time compare is byte-exact
/// on the trimmed value. `NotUnicode` is also a startup error: the variable is
/// present, so it must never be folded into `NotPresent`'s "auth disabled".
fn parse_inference_api_keys(
    raw: Result<String, std::env::VarError>,
) -> anyhow::Result<Vec<String>> {
    let raw = match raw {
        Ok(raw) => raw,
        Err(std::env::VarError::NotPresent) => return Ok(Vec::new()),
        Err(std::env::VarError::NotUnicode(_)) => anyhow::bail!(
            "invalid value for SARDEENZ_PROXY_INFERENCE_API_KEY: not valid Unicode \
             (unset the variable to disable the key)"
        ),
    };
    let mut keys = Vec::new();
    for segment in raw.split(',') {
        let trimmed = segment.trim();
        if trimmed.is_empty() {
            anyhow::bail!(
                "invalid value for SARDEENZ_PROXY_INFERENCE_API_KEY: blank segment \
                 (unset the variable to disable the key)"
            );
        }
        keys.push(trimmed.to_string());
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises the `from_env` cases: cargo runs lib tests on parallel
    /// threads, and these mutate the process-global environment.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        // A panic in one case must not poison the others.
        ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn default_config_parses() {
        let _env = env_lock();
        // Clear any env vars that might interfere
        for key in [
            "SARDEENZ_PROXY_LISTEN_ADDR",
            "SARDEENZ_LISTEN_ADDR",
            "SARDEENZ_ADMIN_ADDR",
            "SARDEENZ_REDIS_URL",
            "SARDEENZ_CONTROL_PLANE_URL",
            "SARDEENZ_API_TOKEN",
            "SARDEENZ_PROXY_INFERENCE_API_KEY",
            "SARDEENZ_PROXY_MAX_BODY_BYTES",
            "SARDEENZ_PROXY_MAX_BUFFERED_BYTES",
        ] {
            std::env::remove_var(key);
        }
        let config = Config::from_env().unwrap();
        assert_eq!(config.listen_addr, "0.0.0.0:8080".parse().unwrap());
        assert_eq!(config.admin_addr, "0.0.0.0:9099".parse().unwrap());
        assert_eq!(config.parking.timeout, Duration::from_secs(120));
        assert_eq!(config.parking.max_per_model, 1000);
        assert_eq!(config.parking.max_bytes, 1_073_741_824);
        assert_eq!(config.upstream_timeout, Duration::from_secs(300));
        assert_eq!(config.circuit_breaker.failure_threshold, 5);
        assert_eq!(config.api_token, None);
        assert!(config.inference_api_keys.is_empty());
        assert_eq!(config.max_body_bytes, 33_554_432);
        assert_eq!(
            config.max_buffered_bytes, 268_435_456,
            "the aggregate body budget enforces out of the box (#300)"
        );
        assert_eq!(config.max_concurrent_forwards, 0);
        assert_eq!(config.max_concurrent_forwards_per_model, 0);
    }

    #[test]
    fn explicit_buffered_budget_parses() {
        let _env = env_lock();
        std::env::set_var("SARDEENZ_PROXY_MAX_BUFFERED_BYTES", "12345");
        let config = Config::from_env();
        std::env::remove_var("SARDEENZ_PROXY_MAX_BUFFERED_BYTES");
        assert_eq!(config.unwrap().max_buffered_bytes, 12_345);
    }

    #[test]
    fn zero_buffered_budget_parses() {
        let _env = env_lock();
        std::env::set_var("SARDEENZ_PROXY_MAX_BUFFERED_BYTES", "0");
        let config = Config::from_env();
        std::env::remove_var("SARDEENZ_PROXY_MAX_BUFFERED_BYTES");
        // `0` = the explicit unlimited opt-out; the startup WARN that announces it
        // lives in `main.rs` (after the tracing subscriber exists), so it is not
        // assertable from this crate's unit tests.
        assert_eq!(config.unwrap().max_buffered_bytes, 0);
    }

    #[test]
    fn invalid_buffered_budget_fails() {
        let _env = env_lock();
        std::env::set_var("SARDEENZ_PROXY_MAX_BUFFERED_BYTES", "banana");
        let config = Config::from_env();
        std::env::remove_var("SARDEENZ_PROXY_MAX_BUFFERED_BYTES");
        let error = config.expect_err("a non-numeric budget must fail startup");
        assert!(
            error.to_string().contains("invalid value for SARDEENZ_PROXY_MAX_BUFFERED_BYTES"),
            "message should name the variable: {error}"
        );
    }

    // `parse_inference_api_keys` takes the raw `std::env::var` result, so these
    // cases need no process-global env mutation and cannot race other tests.
    #[test]
    fn inference_api_key_parsing() {
        // Not present = key disabled, today's behaviour.
        assert_eq!(
            parse_inference_api_keys(Err(std::env::VarError::NotPresent)).unwrap(),
            Vec::<String>::new()
        );

        // Comma-separated rotation slots, each segment trimmed.
        assert_eq!(
            parse_inference_api_keys(Ok("key1,key2".to_string())).unwrap(),
            vec!["key1".to_string(), "key2".to_string()]
        );
        assert_eq!(
            parse_inference_api_keys(Ok("  key1 , key2  ".to_string())).unwrap(),
            vec!["key1".to_string(), "key2".to_string()]
        );

        // Present but not valid Unicode: the operator set the variable, so auth
        // must not silently turn itself off — startup fails closed.
        assert!(parse_inference_api_keys(Err(std::env::VarError::NotUnicode(
            std::ffi::OsString::from("key1")
        )))
        .is_err());

        // A set-but-blank key fails closed at startup (ADR-022 / #268).
        for blank in ["", "   ", "key1,,key2", "key1, ,key2", "key1,"] {
            assert!(
                parse_inference_api_keys(Ok(blank.to_string())).is_err(),
                "blank segment in {blank:?} must be a startup error"
            );
        }
    }
}
