use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::manager::Manager;
use crate::ws;

#[derive(Debug, Deserialize)]
pub struct NewSessionReq {
    pub cwd: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub no_session: bool,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct PromptReq {
    pub text: String,
    #[serde(default)]
    pub streaming: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BashReq {
    pub command: String,
}

pub fn json_err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

fn reply(r: Result<Value, String>) -> (StatusCode, Json<Value>) {
    match r {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    #[serde(default)]
    token: Option<String>,
}

fn auth(token: &Option<String>, m: &Manager) -> Option<Response> {
    let expected = m.config().token.as_deref();
    match expected {
        None => None,
        Some(tok) if token.as_deref() == Some(tok) => None,
        Some(_) => Some(json_err(StatusCode::UNAUTHORIZED, "missing or invalid ?token=")),
    }
}

pub fn build_router(m: Arc<Manager>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style_css))
        .route("/health", get(health))
        .route("/config", get(config))
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/saved-sessions", get(saved_sessions))
        .route("/sessions/{id}", get(get_session).delete(close_session))
        .route("/sessions/{id}/snapshot", get(snapshot))
        .route("/sessions/{id}/commands", get(commands))
        .route("/sessions/{id}/models", get(models))
        .route("/sessions/{id}/stderr", get(stderr_tail))
        .route("/sessions/{id}/command", post(raw_command))
        .route("/sessions/{id}/prompt", post(prompt))
        .route("/sessions/{id}/abort", post(abort))
        .route("/sessions/{id}/bash", post(run_bash))
        .route("/ws/events", get(ws::events_ws))
        .route("/ws/sessions/{id}", get(ws::session_ws))
        .with_state(m)
}

async fn health(State(m): State<Arc<Manager>>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "sessions": m.list().await.iter().filter(|h| h.is_alive()).count(),
    }))
}

async fn config(State(m): State<Arc<Manager>>) -> Json<Value> {
    let c = m.config();
    Json(json!({
        "piBin": c.pi_bin,
        "defaultCwd": c.default_cwd,
        "allowedRoots": c.allowed_roots,
        "requestTimeoutSecs": c.request_timeout_secs,
        "tokenRequired": c.token.is_some(),
    }))
}

async fn index() -> Response {
    html_response(include_str!("../static/index.html"), "text/html; charset=utf-8")
}
async fn app_js() -> Response {
    html_response(include_str!("../static/app.js"), "application/javascript; charset=utf-8")
}
async fn style_css() -> Response {
    html_response(include_str!("../static/style.css"), "text/css; charset=utf-8")
}

fn html_response(body: &str, content_type: &str) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", content_type)
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

async fn list_sessions(State(m): State<Arc<Manager>>, Query(q): Query<TokenQuery>) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    let out: Vec<Value> = m
        .list()
        .await
        .into_iter()
        .map(|h| {
            json!({
                "id": h.id,
                "cwd": h.cwd.to_string_lossy(),
                "alive": h.is_alive(),
                "created": h.created_at.elapsed().as_secs(),
            })
        })
        .collect();
    (StatusCode::OK, Json(json!({ "sessions": out }))).into_response()
}

async fn create_session(
    State(m): State<Arc<Manager>>,
    Query(q): Query<TokenQuery>,
    Json(req): Json<NewSessionReq>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    match m
        .create(
            &req.cwd,
            req.name.as_deref(),
            req.model.as_deref(),
            req.no_session,
            req.session.as_deref(),
            req.thinking.as_deref(),
            &req.extra_args,
        )
        .await
    {
        Ok(h) => (
            StatusCode::CREATED,
            Json(json!({ "id": h.id, "cwd": h.cwd.to_string_lossy() })),
        )
            .into_response(),
        Err(e) => json_err(StatusCode::BAD_REQUEST, &e),
    }
}

async fn saved_sessions(
    State(m): State<Arc<Manager>>,
    Query(q): Query<SavedQuery>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    match m.saved_sessions(q.cwd.as_deref()).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => json_err(StatusCode::NOT_FOUND, &e),
    }
}

#[derive(Debug, Deserialize)]
struct SavedQuery {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

async fn get_session(
    State(m): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    let h = match m.get(&id).await {
        Ok(h) => h,
        Err(e) => return json_err(StatusCode::NOT_FOUND, &e),
    };
    let (st, body) = reply(
        h.request(
            json!({ "type": "get_state" }),
            Duration::from_secs(m.config().request_timeout_secs),
        )
        .await,
    );
    (st, body).into_response()
}

async fn close_session(
    State(m): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    match m.remove(&id).await {
        Ok(h) => {
            h.shutdown().await;
            (StatusCode::OK, Json(json!({ "closed": id }))).into_response()
        }
        Err(e) => json_err(StatusCode::NOT_FOUND, &e),
    }
}

async fn snapshot(
    State(m): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    let h = match m.get(&id).await {
        Ok(h) => h,
        Err(e) => return json_err(StatusCode::NOT_FOUND, &e),
    };
    let (st, body) = reply(
        h.request(
            json!({ "type": "get_messages" }),
            Duration::from_secs(m.config().request_timeout_secs),
        )
        .await,
    );
    (st, body).into_response()
}

async fn commands(
    State(m): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    let h = match m.get(&id).await {
        Ok(h) => h,
        Err(e) => return json_err(StatusCode::NOT_FOUND, &e),
    };
    let (st, body) = reply(
        h.request(
            json!({ "type": "get_commands" }),
            Duration::from_secs(m.config().request_timeout_secs),
        )
        .await,
    );
    (st, body).into_response()
}

async fn models(
    State(m): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    let h = match m.get(&id).await {
        Ok(h) => h,
        Err(e) => return json_err(StatusCode::NOT_FOUND, &e),
    };
    let (st, body) = reply(
        h.request(
            json!({ "type": "get_available_models" }),
            Duration::from_secs(m.config().request_timeout_secs),
        )
        .await,
    );
    (st, body).into_response()
}

async fn stderr_tail(
    State(m): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    match m.get(&id).await {
        Ok(h) => (StatusCode::OK, Json(json!({ "stderr": h.stderr_tail().await }))).into_response(),
        Err(e) => json_err(StatusCode::NOT_FOUND, &e),
    }
}

async fn raw_command(
    State(m): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(q): Query<TokenQuery>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    // Accept either the raw RPC object, or `{"command": {...}}`.
    let cmd = if body.get("type").is_some() {
        body.clone()
    } else if let Some(c) = body.get("command") {
        c.clone()
    } else {
        return json_err(StatusCode::BAD_REQUEST, "command must be a JSON RPC object");
    };
    let h = match m.get(&id).await {
        Ok(h) => h,
        Err(e) => return json_err(StatusCode::NOT_FOUND, &e),
    };
    let (st, body) = reply(
        h.request(cmd, Duration::from_secs(m.config().request_timeout_secs))
            .await,
    );
    (st, body).into_response()
}

async fn prompt(
    State(m): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(q): Query<TokenQuery>,
    Json(req): Json<PromptReq>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    let h = match m.get(&id).await {
        Ok(h) => h,
        Err(e) => return json_err(StatusCode::NOT_FOUND, &e),
    };
    let (st, body) = reply(
        h.request(
            json!({ "type": "prompt", "message": req.text, "streamingBehavior": req.streaming.as_deref() }),
            Duration::from_secs(m.config().request_timeout_secs),
        )
        .await,
    );
    (st, body).into_response()
}

async fn abort(
    State(m): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    let h = match m.get(&id).await {
        Ok(h) => h,
        Err(e) => return json_err(StatusCode::NOT_FOUND, &e),
    };
    let (st, body) = reply(h.request(json!({ "type": "abort" }), Duration::from_secs(10)).await);
    (st, body).into_response()
}

async fn run_bash(
    State(m): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(q): Query<TokenQuery>,
    Json(req): Json<BashReq>,
) -> Response {
    if let Some(r) = auth(&q.token, &m) {
        return r;
    }
    let h = match m.get(&id).await {
        Ok(h) => h,
        Err(e) => return json_err(StatusCode::NOT_FOUND, &e),
    };
    let (st, body) = reply(
        h.request(
            json!({ "type": "bash", "command": req.command }),
            Duration::from_secs(m.config().request_timeout_secs),
        )
        .await,
    );
    (st, body).into_response()
}
