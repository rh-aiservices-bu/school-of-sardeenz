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
}

#[derive(Debug, Clone)]
pub struct ParkingConfig {
    pub timeout: Duration,
    pub max_per_model: usize,
    pub max_global: usize,
}

#[derive(Debug, Clone)]
pub struct CircuitBreakerConfig {
    pub failure_threshold: u32,
    pub failure_window: Duration,
    pub recovery_timeout: Duration,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
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
            upstream_timeout: Duration::from_secs(parse_env(
                "SARDEENZ_UPSTREAM_TIMEOUT_SECS",
                "300",
            )?),
            redis_key_prefix: std::env::var("SARDEENZ_REDIS_KEY_PREFIX")
                .unwrap_or_else(|_| "sardeenz".to_string()),
            parking: ParkingConfig {
                timeout: Duration::from_secs(parse_env("SARDEENZ_PARKING_TIMEOUT_SECS", "120")?),
                max_per_model: parse_env("SARDEENZ_PARKING_MAX_PER_MODEL", "1000")?,
                max_global: parse_env("SARDEENZ_PARKING_MAX_GLOBAL", "10000")?,
            },
            circuit_breaker: CircuitBreakerConfig {
                failure_threshold: parse_env("SARDEENZ_CB_FAILURE_THRESHOLD", "5")?,
                failure_window: Duration::from_secs(parse_env(
                    "SARDEENZ_CB_FAILURE_WINDOW_SECS",
                    "30",
                )?),
                recovery_timeout: Duration::from_secs(parse_env(
                    "SARDEENZ_CB_RECOVERY_TIMEOUT_SECS",
                    "15",
                )?),
            },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_parses() {
        // Clear any env vars that might interfere
        for key in [
            "SARDEENZ_PROXY_LISTEN_ADDR",
            "SARDEENZ_LISTEN_ADDR",
            "SARDEENZ_ADMIN_ADDR",
            "SARDEENZ_REDIS_URL",
            "SARDEENZ_CONTROL_PLANE_URL",
        ] {
            std::env::remove_var(key);
        }
        let config = Config::from_env().unwrap();
        assert_eq!(config.listen_addr, "0.0.0.0:8080".parse().unwrap());
        assert_eq!(config.admin_addr, "0.0.0.0:9099".parse().unwrap());
        assert_eq!(config.parking.timeout, Duration::from_secs(120));
        assert_eq!(config.parking.max_per_model, 1000);
        assert_eq!(config.upstream_timeout, Duration::from_secs(300));
        assert_eq!(config.circuit_breaker.failure_threshold, 5);
    }
}
