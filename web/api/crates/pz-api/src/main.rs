//! Knox County control plane — HTTP API for the Project Zomboid server.

mod config;
mod db;
mod error;
mod extract;
mod routes;
mod services;
mod state;

use std::process::ExitCode;

use tokio::signal;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> ExitCode {
    // Local runs read .env; in Docker the environment is already populated.
    dotenvy::dotenv().ok();

    init_tracing();

    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!("{error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    tracing::info!(bind = %config.bind, "starting pz-api");

    let db = db::connect(&config.database_url, config.database_max_connections).await?;
    db::migrate(&db).await?;
    tracing::info!("database ready");

    bootstrap_admin(&db, &config).await;

    let state = AppState::new(db, config);
    report_backup_directory(&state);
    let tasks = services::tasks::spawn_all(state.clone());

    let listener = tokio::net::TcpListener::bind(state.config.bind).await?;
    tracing::info!(addr = %listener.local_addr()?, "listening");

    axum::serve(listener, routes::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    for task in tasks {
        task.abort();
    }

    tracing::info!("shutdown complete");

    Ok(())
}

/// Create the first administrator, if configured and none exists.
///
/// A failure here is logged and shrugged off: a bad `ADMIN_*` value should not
/// stop the public site from serving.
async fn bootstrap_admin(db: &sqlx::PgPool, config: &Config) {
    let Some(admin) = config.admin_bootstrap.as_ref() else {
        return;
    };

    match services::auth::ensure_admin(db, &admin.username, &admin.email, &admin.password).await {
        Ok(true) => tracing::info!(username = %admin.username, "created the first administrator"),
        Ok(false) => tracing::debug!("an administrator already exists"),
        Err(error) => tracing::error!(%error, "could not create the first administrator"),
    }
}

/// Say at boot whether world archives can actually be written.
///
/// This container cannot repair the directory itself — read-only rootfs, uid
/// 10001, every capability dropped — so this log line and the failing
/// `/api/health` are the whole remedy. The `backups-init` service in
/// `docker-compose.web.yml` is what normally keeps the mode right.
fn report_backup_directory(state: &AppState) {
    let path = state.config.backup_path.display();

    match state.backups_error.as_deref() {
        None => tracing::info!(%path, "backup directory is writable"),
        Some(error) => tracing::error!(
            %path,
            %error,
            "backup directory is NOT writable — scheduled backups and deletes \
             will fail. Fix the mode on the host (chmod 0777) and restart this \
             container."
        ),
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_env("RUST_LOG")
        .unwrap_or_else(|_| EnvFilter::new("pz_api=info,tower_http=info,warn"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .init();
}

/// Docker sends SIGTERM on `stop`; Ctrl-C is for local runs.
async fn shutdown_signal() {
    let interrupt = async {
        signal::ctrl_c().await.expect("install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => tracing::info!("interrupt received, shutting down"),
        () = terminate => tracing::info!("SIGTERM received, shutting down"),
    }
}
