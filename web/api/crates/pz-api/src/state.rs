//! Shared application state, cloned into every handler.

use std::sync::Arc;

use pz_bridge::{DockerClient, LuaBridge};
use sqlx::PgPool;

use crate::config::Config;
use crate::services::backups::{self, JobLock};
use crate::services::datadirs;
use crate::services::items::ItemCatalogService;
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
    /// The item catalogue, parsed once and held until the export changes.
    /// Long-lived because the cache is the point; a per-request reader would
    /// re-parse the file every time the picker opened.
    pub item_catalog: Arc<ItemCatalogService>,
    pub backup_job: JobLock,
    /// Packed isometric basemap. Absent until `make map-tiles` has run.
    pub map_tiles: crate::services::map_tiles::MapTiles,
    pub map_sprites: crate::services::map_sprites::MapSprites,
    /// Why the archive directory is unusable, if it is. `None` means the
    /// start-up probe wrote a file there and removed it again. `/api/health`
    /// reads this, so a bad bind-mount mode surfaces in `docker ps` instead of
    /// as backups that quietly stopped happening.
    pub backups_error: Option<Arc<str>>,
    /// Why the Lua bridge directory is unusable, if it is. The same story as
    /// `backups_error`: uid 10001 writes the account-link, delivery, deposit,
    /// export and ticket files there and cannot repair the mount itself.
    pub lua_bridge_error: Option<Arc<str>>,
    /// SteamCMD is not re-entrant. One Workshop download at a time.
    pub workshop_update: Arc<tokio::sync::Mutex<()>>,
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
        let item_catalog = Arc::new(ItemCatalogService::new(&config.lua_bridge_path));

        let status = Arc::new(StatusService::new(
            Arc::clone(&config),
            docker_status,
            bridge.clone(),
        ));
        let login_limiter = Arc::new(AttemptLimiter::new(
            config.login_max_attempts,
            config.login_window,
        ));

        // Probed once, at start-up. The mode on a bind mount does not change
        // under us, and re-probing per request would put a filesystem write
        // behind an unauthenticated endpoint.
        let backups_error = datadirs::probe_writable(&config.backup_path)
            .err()
            .map(Arc::from);
        let lua_bridge_error = datadirs::probe_writable(&config.lua_bridge_path)
            .err()
            .map(Arc::from);

        let map_tiles = crate::services::map_tiles::MapTiles::open(&config.map_tiles_path);
        let map_sprites = crate::services::map_sprites::MapSprites::open(&config.map_sprites_path);

        Self {
            db,
            config,
            status,
            login_limiter,
            docker,
            bridge,
            item_catalog,
            backup_job: backups::new_job_lock(),
            map_tiles,
            map_sprites,
            backups_error,
            lua_bridge_error,
            workshop_update: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}
