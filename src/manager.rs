use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};

use crate::config::Config;
use crate::pi_process::{spawn, PiHandle};

pub struct Manager {
    cfg: Config,
    sessions: Mutex<HashMap<String, Arc<PiHandle>>>,
    global: broadcast::Sender<Value>,
}

impl Manager {
    pub fn new(cfg: Config) -> Manager {
        let (global, _) = broadcast::channel::<Value>(2048);
        Manager {
            cfg,
            sessions: Mutex::new(HashMap::new()),
            global,
        }
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    pub fn subscribe_global(&self) -> broadcast::Receiver<Value> {
        self.global.subscribe()
    }

    pub fn cwd_allowed(&self, cwd: &str) -> bool {
        if self.cfg.allowed_roots.is_empty() {
            return true;
        }
        self.cfg
            .allowed_roots
            .iter()
            .any(|root| cwd.starts_with(root.trim_end_matches('/')))
    }

    pub async fn create(
        &self,
        cwd: &str,
        name: Option<&str>,
        model: Option<&str>,
        no_session: bool,
        session: Option<&str>,
        thinking: Option<&str>,
        extra: &[String],
    ) -> Result<Arc<PiHandle>, String> {
        let cwd = cwd.to_string();
        if !Path::new(&cwd).is_dir() {
            return Err(format!("cwd does not exist or is not a directory: {cwd}"));
        }
        if !self.cwd_allowed(&cwd) {
            return Err(format!("cwd not allowed by PI_WEB_ALLOWED_ROOTS: {cwd}"));
        }
        let mut args: Vec<String> = Vec::new();
        if let Some(m) = model {
            args.push("--model".into());
            args.push(m.to_string());
        }
        if let Some(n) = name {
            args.push("--name".into());
            args.push(n.to_string());
        }
        if no_session {
            args.push("--no-session".into());
        }
        if let Some(s) = session {
            args.push("--session".into());
            args.push(s.to_string());
        }
        if let Some(t) = thinking {
            args.push("--thinking".into());
            args.push(t.to_string());
        }
        args.extend(extra.iter().cloned());

        let handle = spawn(&self.cfg.pi_bin, &cwd, &args)?;

        // Confirm the session is alive before handing it out.
        let state = handle
            .request(json!({ "type": "get_state" }), Duration::from_secs(30))
            .await?;
        if !state.get("success").and_then(|s| s.as_bool()).unwrap_or(false) {
            return Err(format!(
                "pi session failed to start: {}",
                state
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown error")
            ));
        }

        let id = handle.id.clone();
        tracing::info!("session {id} started in {cwd}");
        self.sessions.lock().await.insert(id.clone(), handle.clone());
        let _ = self
            .global
            .send(json!({ "type": "session_created", "id": id, "cwd": cwd }));
        Ok(handle)
    }

    pub async fn get(&self, id: &str) -> Result<Arc<PiHandle>, String> {
        self.sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("unknown session id: {id}"))
    }

    pub async fn remove(&self, id: &str) -> Result<Arc<PiHandle>, String> {
        self.sessions
            .lock()
            .await
            .remove(id)
            .ok_or_else(|| format!("unknown session id: {id}"))
    }

    pub async fn list(&self) -> Vec<Arc<PiHandle>> {
        self.sessions.lock().await.values().cloned().collect()
    }

    /// List sessions pi has persisted on disk, newest first.
    pub async fn saved_sessions(&self, cwd: Option<&str>) -> Result<Value, String> {
        let root = PathBuf::from(&self.cfg.session_dir);
        if !root.is_dir() {
            return Err(format!("session directory not found: {root:?}"));
        }
        let slug = cwd.map(|c| format!("--{}--", c.trim_matches('/').replace('/', "-")));
        let mut out: Vec<Value> = Vec::new();
        let dirs = if let Some(name) = slug {
            vec![root.join(name)]
        } else {
            let mut v = Vec::new();
            for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
                let p = entry.map_err(|e| e.to_string())?.path();
                if p.is_dir() {
                    v.push(p);
                }
            }
            v
        };
        for dir in dirs {
            if !dir.is_dir() {
                continue;
            }
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries {
                let path = entry.map_err(|e| e.to_string())?.path();
                let name = path.file_name().and_then(|n| n.to_str().map(|s| s.to_string()));
                let Some(name) = name else { continue };
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let first = read_first_line(&path);
                let parsed: Value = match serde_json::from_str(&first) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                out.push(json!({
                    "path": path.to_string_lossy(),
                    "id": parsed.get("id"),
                    "cwd": parsed.get("cwd"),
                    "timestamp": parsed.get("timestamp"),
                    "entries": name,
                }));
            }
        }
        out.sort_by(|a, b| b["timestamp"].as_str().unwrap_or("").cmp(a["timestamp"].as_str().unwrap_or("")));
        out.truncate(50);
        Ok(json!({ "sessions": out, "sessionDir": root.to_string_lossy() }))
    }
}

fn read_first_line(path: &Path) -> String {
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(_) => return String::new(),
    };
    let text = String::from_utf8_lossy(&data);
    text.lines().next().unwrap_or_default().to_string()
}
