mod api;
mod config;
mod manager;
mod pi_process;
mod ws;

use std::sync::Arc;

use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::api::build_router;
use crate::config::Config;
use crate::manager::Manager;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let cfg = Config::from_env();
    let manager = Arc::new(Manager::new(cfg.clone()));

    if let Some(cwd) = cfg.default_cwd.clone() {
        match manager.create(&cwd, None, None, false, None, None, &[]).await {
            Ok(h) => tracing::info!("default session {} in {}", h.id, cwd),
            Err(e) => tracing::warn!("could not create default session: {e}"),
        }
    }

    let app = build_router(manager.clone());
    let listener = TcpListener::bind((cfg.host.clone(), cfg.port)).await?;
    tracing::info!(
        "pi-web listening on http://{}:{}  (pi bin: {})",
        cfg.host,
        cfg.port,
        cfg.pi_bin
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutdown requested");
        })
        .await?;

    for handle in manager.list().await {
        handle.shutdown().await;
    }
    tracing::info!("pi-web stopped, all pi sessions terminated");
    Ok(())
}
