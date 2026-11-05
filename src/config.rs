use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub pi_bin: String,
    pub token: Option<String>,
    pub request_timeout_secs: u64,
    pub allowed_roots: Vec<String>,
    pub default_cwd: Option<String>,
    pub session_dir: String,
}

fn env_or(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> Config {
        Config {
            host: env_or("PI_WEB_HOST", "0.0.0.0"),
            port: env_or("PI_WEB_PORT", "8080")
                .parse()
                .unwrap_or(8080),
            pi_bin: env_or("PI_BIN", "pi"),
            token: env::var("PI_WEB_TOKEN").ok().filter(|t| !t.is_empty()),
            request_timeout_secs: env_or("PI_WEB_TIMEOUT", "120")
                .parse()
                .unwrap_or(120),
            allowed_roots: env::var("PI_WEB_ALLOWED_ROOTS")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            default_cwd: env::var("PI_WEB_CWD").ok().filter(|s| !s.is_empty()),
            session_dir: env_or(
                "PI_WEB_SESSION_DIR",
                &dirs_home().join(".pi/agent/sessions").to_string_lossy(),
            ),
        }
    }
}

fn dirs_home() -> std::path::PathBuf {
    env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("~"))
}
