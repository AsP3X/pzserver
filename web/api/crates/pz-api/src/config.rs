//! Configuration, read once from the environment at startup.
//!
//! Variable names deliberately match the ones the existing stack already uses
//! (`PZ_RCON_*`, `DOCKER_PROXY_URL`, `PZ_DATA_PATH`, …) so one `.env` can feed
//! both stacks while they run side by side.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{name} is required but not set")]
    Missing { name: &'static str },

    #[error("{name} is not a valid {expected}: {value}")]
    Invalid {
        name: &'static str,
        expected: &'static str,
        value: String,
    },
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_url: String,
    pub database_max_connections: u32,
    pub cors_origins: Vec<String>,

    pub rcon: pz_rcon::RconConfig,
    pub docker_proxy_url: String,
    pub game_server_container: String,

    /// Game data directory (`Zomboid/`), parent of `Server/` and `Logs/`.
    pub data_path: PathBuf,
    /// `server.ini` / whitelist DB stem (`ZomboidServer` here).
    pub server_name: String,
    /// Directory the KnoxRelay mod writes its JSON exports into.
    pub lua_bridge_path: PathBuf,
    pub backup_path: PathBuf,
    /// Packed isometric tile pyramid. `/map-tiles` in the container, from the
    /// `pz-map-tiles-sqlite` volume — not the host bind. Render scratch still
    /// uses `map_tiles_host`.
    pub map_tiles_path: PathBuf,
    /// Sprite isometric catalogue (`make map-sprites`). Parallel to the JPEG pack.
    pub map_sprites_path: PathBuf,
    /// Image used to spawn a one-shot `pz-map-tiles` renderer.
    pub map_tiles_image: String,
    /// Host paths for the renderer binds (Docker API `HostConfig.Binds`).
    pub pz_server_host: String,
    pub pz_texturepacks_host: String,
    pub map_tiles_host: String,
    /// Host path of `Zomboid/` (`./data/zomboid`). The renderer bind-mounts
    /// `Saves/` from here so a region job can snapshot live chunks.
    pub pz_data_host: String,
    /// Save folder relative to `Saves/`, e.g. `Multiplayer/ZomboidServer`.
    pub pz_save_game: String,
    /// Docker volume that holds `tiles.sqlite`. API and renderer share it so a
    /// region job updates the same pack the site is serving.
    pub map_tiles_volume: String,
    /// Docker volume that holds `sprites.sqlite` and `live.bin`.
    pub map_sprites_volume: String,
    pub pz_game_version: String,
    pub steam_branch: Option<String>,
    /// Path to the live `server.ini`.
    pub server_ini_path: PathBuf,
    /// Workshop id of the Knox Relay mod — never removable from the load list.
    pub bridge_workshop_id: Option<String>,
    pub bridge_mod_id: String,
    /// Steam Workshop cache (`steamapps/workshop`). None when the API cannot
    /// see the game install, so the mod list still loads without versions.
    pub workshop_path: Option<PathBuf>,

    /// Address players type into the game client.
    pub connect_host: Option<String>,
    pub connect_port: u16,

    /// `Secure` flag on the session cookie. Browsers treat localhost as a
    /// secure origin, so this can stay on in development too.
    pub session_cookie_secure: bool,
    /// Failed logins allowed per username inside `login_window`.
    pub login_max_attempts: usize,
    pub login_window: Duration,

    /// First administrator, created on boot when no admin exists yet.
    pub admin_bootstrap: Option<AdminBootstrap>,

    /// How long a resolved server status is reused before re-polling.
    pub status_cache_ttl: Duration,
    /// How often a population sample is written to the history table.
    pub status_sample_interval: Duration,
    /// How often the background task folds the mod's stats export into Postgres.
    pub stats_sync_interval: Duration,
    /// A live-position export older than this no longer proves the mod is alive.
    pub bridge_stale_after: Duration,

    /// Coins paid by the daily wallet drop. Zero disables it.
    pub daily_reward_coins: i64,

    /// Public origin of the site, e.g. `https://knox.example`.
    ///
    /// Steam's OpenID needs an absolute `realm` and `return_to`, and it checks
    /// that one is a prefix of the other — so this cannot be derived from the
    /// request, which an attacker controls the Host header of. Defaults to the
    /// first CORS origin, which is the same value in every deployment so far.
    pub public_url: String,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let data_path = string("PZ_DATA_PATH", "/pz-data");
        let server_name = string("PZ_SERVER_NAME", "ZomboidServer");
        let cors_origins = list("WEB_CORS_ORIGINS", "http://localhost:5174");

        let public_url = optional("WEB_PUBLIC_URL")
            .or_else(|| cors_origins.first().cloned())
            .unwrap_or_else(|| "http://localhost:5174".to_owned())
            // A trailing slash would produce `//auth/steam/callback`, which
            // Steam compares literally against the realm and rejects.
            .trim_end_matches('/')
            .to_owned();

        let server_ini_path = optional("PZ_SERVER_INI_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(&data_path)
                    .join("Server")
                    .join(format!("{server_name}.ini"))
            });

        // Defaults to the subdirectory of PZ_DATA_PATH the game writes into, so
        // running outside Docker needs no extra configuration.
        let lua_bridge_path = optional("LUA_BRIDGE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&data_path).join("Lua"));

        let save_game_default = format!("Multiplayer/{server_name}");

        Ok(Self {
            bind: parse("API_BIND", "0.0.0.0:8080", "socket address")?,
            database_url: require("DATABASE_URL")?,
            database_max_connections: parse("DATABASE_MAX_CONNECTIONS", "10", "integer")?,
            cors_origins,

            rcon: pz_rcon::RconConfig {
                host: string("PZ_RCON_HOST", "game-server"),
                port: parse("PZ_RCON_PORT", "27015", "port number")?,
                password: string("PZ_RCON_PASSWORD", ""),
                timeout: seconds("PZ_RCON_TIMEOUT", "5")?,
            },
            docker_proxy_url: string("DOCKER_PROXY_URL", "http://docker-socket-proxy:2375"),
            game_server_container: string("GAME_SERVER_CONTAINER_NAME", "pz-game-server"),

            data_path: PathBuf::from(&data_path),
            server_name,
            lua_bridge_path,
            backup_path: PathBuf::from(string("BACKUP_PATH", "/backups")),
            map_tiles_path: PathBuf::from(string("MAP_TILES_PATH", "/map-tiles/tiles.sqlite")),
            map_sprites_path: PathBuf::from(string(
                "MAP_SPRITES_PATH",
                "/map-sprites/sprites.sqlite",
            )),
            map_tiles_image: string("MAP_TILES_IMAGE", "pzserver-map-tiles:local"),
            pz_server_host: string("PZ_SERVER_HOST", "./data/server"),
            pz_texturepacks_host: string(
                "PZ_TEXTUREPACKS_HOST",
                "./data/server/media/texturepacks",
            ),
            map_tiles_host: string("PZ_MAP_TILES_HOST", "./data/map-tiles"),
            pz_data_host: string("PZ_DATA_HOST", "./data/zomboid"),
            pz_save_game: string("PZ_SAVE_GAME", &save_game_default),
            map_tiles_volume: string("MAP_TILES_VOLUME", "pz-map-tiles-sqlite"),
            map_sprites_volume: string("MAP_SPRITES_VOLUME", "pz-map-sprites"),
            pz_game_version: string("PZ_GAME_VERSION", "42.20.0"),
            steam_branch: optional("PZ_STEAM_BRANCH"),
            server_ini_path,
            bridge_workshop_id: optional("PZ_BRIDGE_WORKSHOP_ID"),
            bridge_mod_id: string("PZ_BRIDGE_MOD_ID", "KnoxRelay"),
            workshop_path: optional("PZ_WORKSHOP_PATH").map(PathBuf::from),

            connect_host: optional("PZ_CONNECT_HOST"),
            connect_port: parse("PZ_GAME_PORT", "16261", "port number")?,

            session_cookie_secure: boolean("SESSION_COOKIE_SECURE", true)?,
            login_max_attempts: parse("LOGIN_MAX_ATTEMPTS", "8", "integer")?,
            login_window: seconds("LOGIN_WINDOW_SECONDS", "900")?,

            admin_bootstrap: AdminBootstrap::from_env(),

            status_cache_ttl: seconds("STATUS_CACHE_TTL", "5")?,
            status_sample_interval: seconds("STATUS_SAMPLE_INTERVAL", "300")?,
            // Five seconds, not thirty. Both sync loops gate on the export's
            // mtime, so a tick with nothing new costs one stat() and no parse
            // — there is nothing to save by waiting, and the page is read by
            // somebody who is playing right now and expects to see themselves.
            stats_sync_interval: seconds("STATS_SYNC_INTERVAL", "5")?,
            bridge_stale_after: seconds("BRIDGE_STALE_AFTER", "120")?,
            daily_reward_coins: parse("PZ_DAILY_REWARD_COINS", "25", "integer")?,
            public_url,
        })
    }

    /// The dedicated server's whitelist SQLite file, if it is on disk.
    pub fn whitelist_db_path(&self) -> Option<std::path::PathBuf> {
        pz_bridge::whitelist::resolve_db_path(&self.data_path, &self.server_name)
    }
}

/// Credentials for the first administrator.
///
/// Variable names match the ones the PHP stack's entrypoint already reads, so
/// an existing `.env` needs no new keys.
#[derive(Debug, Clone)]
pub struct AdminBootstrap {
    pub username: String,
    pub email: String,
    pub password: String,
}

impl AdminBootstrap {
    fn from_env() -> Option<Self> {
        let username = optional("ADMIN_USERNAME")?;
        let password = optional("ADMIN_PASSWORD")?;

        // The PHP stack leaves ADMIN_EMAIL blank in its own .env, and an
        // account still needs an address, so fall back to a local one.
        let email =
            optional("ADMIN_EMAIL").unwrap_or_else(|| format!("{username}@localhost.invalid"));

        Some(Self {
            username,
            email,
            password,
        })
    }
}

fn optional(name: &'static str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn require(name: &'static str) -> Result<String, ConfigError> {
    optional(name).ok_or(ConfigError::Missing { name })
}

fn string(name: &'static str, default: &str) -> String {
    optional(name).unwrap_or_else(|| default.to_owned())
}

fn parse<T>(name: &'static str, default: &str, expected: &'static str) -> Result<T, ConfigError>
where
    T: std::str::FromStr,
{
    let value = string(name, default);

    value.parse().map_err(|_| ConfigError::Invalid {
        name,
        expected,
        value,
    })
}

fn boolean(name: &'static str, default: bool) -> Result<bool, ConfigError> {
    let Some(value) = optional(name) else {
        return Ok(default);
    };

    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => Err(ConfigError::Invalid {
            name,
            expected: "boolean",
            value,
        }),
    }
}

fn seconds(name: &'static str, default: &str) -> Result<Duration, ConfigError> {
    Ok(Duration::from_secs(parse(
        name,
        default,
        "number of seconds",
    )?))
}

fn list(name: &'static str, default: &str) -> Vec<String> {
    string(name, default)
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}
