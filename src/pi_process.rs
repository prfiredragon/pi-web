use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex, oneshot};

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
static REQ_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A single `pi --mode rpc` child process driven over JSONL stdin/stdout.
pub struct PiHandle {
    pub id: String,
    pub cwd: PathBuf,
    pub created_at: Instant,
    stdin_tx: tokio::sync::mpsc::UnboundedSender<String>,
    events: broadcast::Sender<Value>,
    pending: Arc<Mutex<Vec<(String, String, oneshot::Sender<Value>)>>>,
    alive: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
}

fn next_req_id() -> String {
    format!("req-{}", REQ_COUNTER.fetch_add(1, Ordering::Relaxed))
}

pub fn spawn(pi_bin: &str, cwd: &str, extra_args: &[String]) -> Result<Arc<PiHandle>, String> {
    let mut cmd = Command::new(pi_bin);
    cmd.current_dir(cwd)
        .arg("--mode")
        .arg("rpc")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for a in extra_args {
        cmd.arg(a);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn `{pi_bin}`: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pi process has no stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "pi process has no stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "pi process has no stderr".to_string())?;

    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (events_tx, _) = broadcast::channel::<Value>(2048);
    let pending: Arc<Mutex<Vec<(String, String, oneshot::Sender<Value>)>>> = Arc::new(Mutex::new(Vec::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let child_arc = Arc::new(Mutex::new(Some(child)));

    // writer: push one JSON line per message to the child's stdin
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(line) = stdin_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdin.flush().await.is_err() {
                break;
            }
        }
        let _ = stdin.shutdown().await;
    });

    // stdout reader: every line is either a response (with id) or a session event
    tokio::spawn({
        let pending = pending.clone();
        let events = events_tx.clone();
        let alive = alive.clone();
        async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let rec: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!("unparsable pi rpc line: {e}");
                        continue;
                    }
                };
                let rtype = rec
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();

                // Only responses resolve a pending request. Events can carry their own
                // `id` (e.g. bash_execution_update) and must never be treated as a response.
                let is_response = rtype == "response" || rtype == "extension_ui_response";
                if is_response {
                    let id = rec.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let cmd = rec
                        .get("command")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string();
                    let mut p = pending.lock().await;
                    let pos = p
                        .iter()
                        .position(|(i, _, _)| !id.is_empty() && *i == id)
                        .or_else(|| {
                            // pi does not echo the request id on error responses; resolve the
                            // most recent pending request with the same command name.
                            if cmd.is_empty() {
                                None
                            } else if p.len() == 1 {
                                Some(0)
                            } else {
                                p.iter().rposition(|(_, c, _)| *c == cmd)
                            }
                        });
                    match pos {
                        Some(pos) => {
                            let (_, _, tx) = p.remove(pos);
                            let _ = tx.send(rec);
                        }
                        None => {
                            let _ = events.send(rec);
                        }
                    }
                } else {
                    let _ = events.send(rec);
                }
            }
            alive.store(false, Ordering::Relaxed);
            tracing::info!("pi rpc stdout closed");
        }
    });

    // stderr reader: keep the last few lines for the UI
    tokio::spawn({
        let stderr_tail = stderr_tail.clone();
        async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut tail = stderr_tail.lock().await;
                tail.push(line);
                if tail.len() > 60 {
                    tail.remove(0);
                }
            }
        }
    });

    Ok(Arc::new(PiHandle {
        id: format!("sess-{}", SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)),
        cwd: PathBuf::from(cwd),
        created_at: Instant::now(),
        stdin_tx,
        events: events_tx,
        pending,
        alive,
        child: child_arc,
        stderr_tail,
    }))
}

impl PiHandle {
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub async fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail.lock().await.clone()
    }

    /// Write a record without waiting for a correlated response.
    pub fn send_raw(&self, rec: &Value) -> Result<(), String> {
        let line = serde_json::to_string(rec).map_err(|e| e.to_string())?;
        self.stdin_tx
            .send(line + "\n")
            .map_err(|_| "pi process is not running".to_string())
    }

    /// Send a command and await its correlated response (`id` is echoed by pi).
    pub async fn request(&self, mut cmd: Value, timeout: Duration) -> Result<Value, String> {
        if !self.is_alive() {
            return Err("pi process is not running".into());
        }
        let obj = cmd
            .as_object_mut()
            .ok_or_else(|| "command must be a JSON object".to_string())?;
        if obj.get("id").and_then(|v| v.as_str()).is_none() {
            obj.insert("id".to_string(), Value::String(next_req_id()));
        }
        let id = obj.get("id").and_then(|v| v.as_str()).unwrap().to_string();
        let kind = obj
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.push((id.clone(), kind, tx));

        if self.stdin_tx.send(line + "\n").is_err() {
            self.remove_pending(&id).await;
            return Err("pi process is not running".into());
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(rec)) => Ok(rec),
            Ok(Err(_)) => {
                self.remove_pending(&id).await;
                Err("response channel closed".into())
            }
            Err(_) => {
                self.remove_pending(&id).await;
                Err(format!("timeout waiting for response to {id}"))
            }
        }
    }

    async fn remove_pending(&self, id: &str) {
        let mut p = self.pending.lock().await;
        if let Some(pos) = p.iter().position(|(i, _, _)| i == id) {
            p.remove(pos);
        }
    }

    /// Terminate the pi process. Dropping stdin closes it when the handle is released.
    pub async fn shutdown(&self) {
        let mut guard = self.child.lock().await;
        if let Some(c) = guard.as_mut() {
            let _ = c.kill().await;
        }
        self.alive.store(false, Ordering::Relaxed);
    }
}
