//! Shared application state, cloned into every handler.

use std::sync::Arc;

use pz_bridge::{DockerClient, LuaBridge};
use sqlx::PgPool;

use crate::config::Config;
use crate::services::rate_limit::AttemptLimiter;
use crate::services::status::StatusService;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub status: Arc<StatusService>,
    /// Failed-login counter. In-process, so each replica limits independently;
    /// with one API container that is the whole picture.
    pub login_limiter: Arc<AttemptLimiter>,
    /// Longer-timeout client for start/stop/restart. Status polling keeps the
    /// short one inside `StatusService`.
    pub docker: DockerClient,
    pub bridge: LuaBridge,
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> Self {
        let config = Arc::new(config);

        let docker_status = DockerClient::new(
            &config.docker_proxy_url,
            &config.game_server_container,
            // The proxy is a container away; anything slower than this and the
            // page is better off rendering "unknown" than waiting.
            std::time::Duration::from_secs(3),
        );
        let docker = DockerClient::new(
            &config.docker_proxy_url,
            &config.game_server_container,
            // Stop/restart wait on PZ flushing the world. The HTTP timeout
            // layer above this is 15s; keep this under that.
            std::time::Duration::from_secs(12),
        );
        let bridge = LuaBridge::new(&config.lua_bridge_path);

        let status = Arc::new(StatusService::new(
            Arc::clone(&config),
            docker_status,
            bridge.clone(),
        ));
        let login_limiter = Arc::new(AttemptLimiter::new(
            config.login_max_attempts,
            config.login_window,
        ));

        Self {
            db,
            config,
            status,
            login_limiter,
            docker,
            bridge,
        }
    }
}
