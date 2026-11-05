use std::collections::HashMap;
use std::io::{BufRead, BufReader};
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

        let handle = spawn(&self.cfg.pi_bin, &cwd, name, &args)?;

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
        let _ = self.global.send(json!({
            "type": "session_created",
            "id": id,
            "cwd": cwd,
            "name": handle.get_name().await,
        }));

        // Forward session events to global broadcast
        let mut rx = handle.subscribe();
        let global_tx = self.global.clone();
        let sid = id.clone();
        tokio::spawn(async move {
            while let Ok(ev) = rx.recv().await {
                let _ = global_tx.send(json!({
                    "type": "session_event",
                    "sessionId": sid,
                    "event": ev,
                }));
            }
            let _ = global_tx.send(json!({
                "type": "session_closed",
                "id": sid,
            }));
        });

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
        let removed = self
            .sessions
            .lock()
            .await
            .remove(id)
            .ok_or_else(|| format!("unknown session id: {id}"))?;
        let _ = self.global.send(json!({ "type": "session_closed", "id": id }));
        Ok(removed)
    }

    pub async fn list(&self) -> Vec<Arc<PiHandle>> {
        let mut v: Vec<Arc<PiHandle>> = self.sessions.lock().await.values().cloned().collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    /// Browse directories for the UI folder picker, respecting `allowed_roots`.
    pub fn browse_dirs(&self, raw_path: Option<&str>) -> Result<Value, String> {
        let default_base = self
            .cfg
            .default_cwd
            .clone()
            .or_else(|| self.cfg.allowed_roots.first().cloned())
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| "/".to_string());

        let input = raw_path
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or(&default_base);

        let target = PathBuf::from(input);
        let (dir_to_read, prefix_filter) = if target.is_dir() {
            (target.clone(), String::new())
        } else if let Some(parent) = target.parent() {
            let fname = target
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_lowercase();
            (parent.to_path_buf(), fname)
        } else {
            (PathBuf::from(&default_base), String::new())
        };

        let mut dirs: Vec<String> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&dir_to_read) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_dir() {
                    continue;
                }
                let fname = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if fname.starts_with('.') && !prefix_filter.starts_with('.') {
                    continue;
                }
                if !prefix_filter.is_empty() && !fname.to_lowercase().starts_with(&prefix_filter) {
                    continue;
                }
                let full = p.to_string_lossy().to_string();
                if self.cwd_allowed(&full)
                    || self
                        .cfg
                        .allowed_roots
                        .iter()
                        .any(|r| r.starts_with(&full))
                {
                    dirs.push(full);
                }
            }
        }
        dirs.sort();
        dirs.truncate(60);

        let parent = dir_to_read
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .filter(|p| !p.is_empty());

        Ok(json!({
            "current": dir_to_read.to_string_lossy(),
            "parent": parent,
            "dirs": dirs,
            "allowedRoots": self.cfg.allowed_roots,
        }))
    }

    /// List sessions pi has persisted on disk, newest first, with name & first prompt preview.
    pub async fn saved_sessions(&self, cwd: Option<&str>) -> Result<Value, String> {
        let root = PathBuf::from(&self.cfg.session_dir);
        if !root.is_dir() {
            return Ok(json!({ "sessions": [], "sessionDir": root.to_string_lossy() }));
        }
        let slug = cwd
            .map(|c| c.trim())
            .filter(|c| !c.is_empty())
            .map(|c| format!("--{}--", c.trim_matches('/').replace('/', "-")));
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
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str().map(|s| s.to_string()));
                let Some(name) = name else { continue };
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let Some(meta) = inspect_session_file(&path) else {
                    continue;
                };
                out.push(meta);
            }
        }
        out.sort_by(|a, b| {
            b["timestamp"]
                .as_str()
                .unwrap_or("")
                .cmp(a["timestamp"].as_str().unwrap_or(""))
        });
        out.truncate(60);
        Ok(json!({ "sessions": out, "sessionDir": root.to_string_lossy() }))
    }
}

fn inspect_session_file(path: &Path) -> Option<Value> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines();

    let first_line = lines.next()?.ok()?;
    let header: Value = serde_json::from_str(&first_line).ok()?;

    let mut session_name: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut message_count: usize = 0;

    for line in lines.take(250).flatten() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let etype = entry.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if etype == "session_info" {
            session_name = entry
                .get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string());
        } else if etype == "message" {
            message_count += 1;
            if first_prompt.is_none() {
                if let Some(msg) = entry.get("message") {
                    if msg.get("role").and_then(|r| r.as_str()) == Some("user") {
                        let txt = extract_user_text(msg.get("content"));
                        if !txt.trim().is_empty() {
                            let clean: String = txt
                                .lines()
                                .map(|l| l.trim())
                                .filter(|l| !l.is_empty())
                                .collect::<Vec<_>>()
                                .join(" ");
                            let preview: String = clean.chars().take(120).collect();
                            first_prompt = Some(preview);
                        }
                    }
                }
            }
        }
    }

    Some(json!({
        "path": path.to_string_lossy(),
        "id": header.get("id"),
        "cwd": header.get("cwd"),
        "timestamp": header.get("timestamp"),
        "name": session_name,
        "firstPrompt": first_prompt,
        "messageCount": message_count,
    }))
}

fn extract_user_text(content: Option<&Value>) -> String {
    let Some(c) = content else { return String::new() };
    if let Some(s) = c.as_str() {
        return s.to_string();
    }
    if let Some(arr) = c.as_array() {
        let mut parts = Vec::new();
        for item in arr {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                    parts.push(t);
                }
            }
        }
        return parts.join("\n");
    }
    String::new()
}
