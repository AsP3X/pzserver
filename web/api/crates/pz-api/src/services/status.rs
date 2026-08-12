//! Resolves what the game server is currently doing.
//!
//! Three sources are consulted in order of trustworthiness:
//!
//! 1. the mod's live-position export — proves the world is ticking
//! 2. RCON — a successful command proves the server is responsive
//! 3. the container's own healthcheck — only proves Docker is alive
//!
//! Nothing here returns an error. A stopped server, an unreachable Docker proxy
//! and a wrong RCON password are all *states*, reported as such, because the
//! public site has to render either way.

use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use pz_bridge::{ContainerState, ContainerStatus, DockerClient, LuaBridge, ServerIni};
use pz_rcon::RconConnection;
use serde::Serialize;
use tokio::sync::RwLock;

use crate::config::Config;

/// Readiness of the game itself, as opposed to its container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GameState {
    /// Container is not running, or not there at all.
    Offline,
    /// Container is up but the game has not finished loading the world yet.
    Starting,
    /// The game answered us.
    Online,
}

/// Which source the player list came from — also how much to trust it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DataSource {
    LuaBridge,
    Rcon,
    None,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub state: GameState,
    pub online: bool,
    pub container: ContainerState,
    pub player_count: usize,
    pub players: Vec<String>,
    pub max_players: Option<i64>,
    pub map: Option<String>,
    pub uptime_seconds: Option<u64>,
    pub data_source: DataSource,
    pub checked_at: DateTime<Utc>,
}

impl ServerStatus {
    fn offline(container: ContainerState) -> Self {
        Self {
            state: GameState::Offline,
            online: false,
            container,
            player_count: 0,
            players: Vec::new(),
            max_players: None,
            map: None,
            uptime_seconds: None,
            data_source: DataSource::None,
            checked_at: Utc::now(),
        }
    }
}

struct Cached {
    status: ServerStatus,
    resolved_at: Instant,
}

pub struct StatusService {
    config: Arc<Config>,
    docker: DockerClient,
    bridge: LuaBridge,
    cache: RwLock<Option<Cached>>,
}

impl StatusService {
    pub fn new(config: Arc<Config>, docker: DockerClient, bridge: LuaBridge) -> Self {
        Self {
            config,
            docker,
            bridge,
            cache: RwLock::new(None),
        }
    }

    /// Current status, re-resolved only once the cached copy has aged out.
    ///
    /// The cache is what makes a polling landing page safe: a hundred visitors
    /// refreshing every few seconds still cost one RCON round-trip per TTL.
    pub async fn current(&self) -> ServerStatus {
        if let Some(cached) = self.cache.read().await.as_ref()
            && cached.resolved_at.elapsed() < self.config.status_cache_ttl
        {
            return cached.status.clone();
        }

        let status = self.resolve().await;

        *self.cache.write().await = Some(Cached {
            status: status.clone(),
            resolved_at: Instant::now(),
        });

        status
    }

    async fn resolve(&self) -> ServerStatus {
        let container = match self.docker.status().await {
            Ok(status) => status,
            Err(error) => {
                // Losing sight of Docker is worth a log line, but the site still
                // needs an answer.
                tracing::warn!(%error, "docker status unavailable");
                ContainerStatus::unknown()
            }
        };

        if !container.running {
            return ServerStatus::offline(container.state);
        }

        let (players, data_source) = self.read_players().await;

        let state = match data_source {
            DataSource::LuaBridge | DataSource::Rcon => GameState::Online,
            // Only Docker's word for it: healthy means loaded, anything else
            // means the world is still coming up.
            DataSource::None => match container.health.as_deref() {
                Some("healthy") => GameState::Online,
                _ => GameState::Starting,
            },
        };

        let ini = ServerIni::read(&self.config.server_ini_path)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "server.ini unreadable");
                None
            })
            .unwrap_or_default();

        ServerStatus {
            state,
            online: state == GameState::Online,
            container: container.state,
            player_count: players.len(),
            players,
            max_players: ini.get_int("MaxPlayers"),
            map: ini.get_non_empty("Map").map(str::to_owned),
            uptime_seconds: container.uptime().map(|uptime| uptime.as_secs()),
            data_source,
            checked_at: Utc::now(),
        }
    }

    /// Who is online, and how we found out.
    async fn read_players(&self) -> (Vec<String>, DataSource) {
        if let Some(players) = self.read_players_from_bridge().await {
            return (players, DataSource::LuaBridge);
        }

        if let Some(players) = self.read_players_from_rcon().await {
            return (players, DataSource::Rcon);
        }

        (Vec::new(), DataSource::None)
    }

    /// The mod's export, if it is both fresh and non-empty.
    ///
    /// Freshness comes from the file's mtime, not from the `timestamp` field
    /// inside it — that one is in-game time, so it reads 1993 and freezes
    /// whenever the world is paused.
    async fn read_players_from_bridge(&self) -> Option<Vec<String>> {
        let read = match self.bridge.players_live().await {
            Ok(read) => read?,
            Err(error) => {
                tracing::warn!(%error, "live player export unreadable");
                return None;
            }
        };

        if read.data.players.is_empty() || read.is_stale(self.config.bridge_stale_after) {
            return None;
        }

        Some(
            read.data
                .players
                .into_iter()
                .map(|player| player.username)
                .collect(),
        )
    }

    /// An empty-but-valid RCON reply still counts: it proves the game answered.
    async fn read_players_from_rcon(&self) -> Option<Vec<String>> {
        let mut connection = match RconConnection::connect(&self.config.rcon).await {
            Ok(connection) => connection,
            Err(error) => {
                tracing::debug!(%error, "rcon unavailable");
                return None;
            }
        };

        match connection.command("players").await {
            Ok(response) => pz_rcon::parse_players(&response),
            Err(error) => {
                tracing::debug!(%error, "rcon players command failed");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_offline_status_reports_no_players() {
        let status = ServerStatus::offline(ContainerState::Exited);

        assert_eq!(status.state, GameState::Offline);
        assert!(!status.online);
        assert_eq!(status.player_count, 0);
        assert_eq!(status.data_source, DataSource::None);
    }

    #[test]
    fn status_serialises_with_snake_case_states() {
        let json = serde_json::to_string(&ServerStatus::offline(ContainerState::NotFound))
            .expect("serialise");

        assert!(json.contains(r#""state":"offline""#));
        assert!(json.contains(r#""container":"not_found""#));
        assert!(json.contains(r#""data_source":"none""#));
    }
}
