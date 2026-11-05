use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::manager::Manager;

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    #[serde(default)]
    token: Option<String>,
}

fn authorized(token: &Option<String>, m: &Manager) -> bool {
    let expected = m.config().token.as_deref();
    match expected {
        None => true,
        Some(t) => token.as_deref() == Some(t),
    }
}

fn send(sink: &mpsc::UnboundedSender<String>, payload: &Value) {
    if let Ok(line) = serde_json::to_string(payload) {
        let _ = sink.send(line);
    }
}

pub async fn events_ws(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(m): State<Arc<Manager>>,
) -> Response {
    if !authorized(&q.token, &m) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    ws.on_upgrade(move |socket| handle_events(socket, m))
}

async fn handle_events(mut socket: WebSocket, m: Arc<Manager>) {
    let mut global = m.subscribe_global();
    let _ = socket
        .send(Message::text(json!({ "type": "hello", "kind": "global" }).to_string()))
        .await;
    loop {
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(_))) => {}
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
            ev = global.recv() => {
                match ev {
                    Ok(ev) => {
                        if socket.send(Message::text(ev.to_string())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(_) => {}
                }
            }
        }
    }
}

pub async fn session_ws(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    Query(q): Query<WsQuery>,
    State(m): State<Arc<Manager>>,
) -> Response {
    if !authorized(&q.token, &m) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    ws.on_upgrade(move |socket| handle_session(socket, id, m))
}

async fn handle_session(mut socket: WebSocket, id: String, m: Arc<Manager>) {
    let handle = match m.get(&id).await {
        Ok(h) => h,
        Err(e) => {
            let _ = socket
                .send(Message::text(json!({ "type": "error", "error": e }).to_string()))
                .await;
            return;
        }
    };
    let timeout = Duration::from_secs(m.config().request_timeout_secs);

    let (sink_tx, mut sink_rx) = mpsc::unbounded_channel::<String>();
    let mut events = handle.subscribe();

    send(
        &sink_tx,
        &json!({ "type": "hello", "sessionId": id, "cwd": handle.cwd.to_string_lossy() }),
    );

    match handle.request(json!({ "type": "get_messages" }), timeout).await {
        Ok(resp) => send(&sink_tx, &json!({ "type": "history", "response": resp })),
        Err(e) => send(&sink_tx, &json!({ "type": "error", "error": e })),
    }
    if let Ok(resp) = handle.request(json!({ "type": "get_session_stats" }), timeout).await {
        send(&sink_tx, &json!({ "type": "stats", "response": resp }));
    }

    loop {
        tokio::select! {
            msg = socket.recv() => {
                let text = match msg {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => continue,
                };
                let cmd: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(e) => {
                        send(&sink_tx, &json!({ "type": "error", "error": format!("invalid json: {e}") }));
                        continue;
                    }
                };
                let kind = cmd.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match kind {
                    "extension_ui_response" => {
                        if let Err(e) = handle.send_raw(&cmd) {
                            send(&sink_tx, &json!({ "type": "error", "error": e }));
                        }
                    }
                    "ping" => send(&sink_tx, &json!({ "type": "pong" })),
                    _ => {
                        let h = handle.clone();
                        let s = sink_tx.clone();
                        tokio::spawn(async move {
                            match h.request(cmd, timeout).await {
                                Ok(resp) => send(&s, &json!({ "type": "rpc_response", "response": resp })),
                                Err(e) => send(&s, &json!({ "type": "error", "error": e })),
                            }
                        });
                    }
                }
            }
            line = sink_rx.recv() => {
                if let Some(line) = line {
                    if socket.send(Message::text(line)).await.is_err() {
                        break;
                    }
                }
            }
            ev = events.recv() => {
                match ev {
                    Ok(ev) => send(&sink_tx, &json!({ "type": "event", "event": ev })),
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(_) => {}
                }
            }
        }
    }
}
