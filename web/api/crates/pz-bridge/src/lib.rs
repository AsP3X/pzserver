//! Readers for everything the game server exposes on disk or over the Docker API.
//!
//! Three sources, all of which can be absent or stale at any moment:
//!
//! - the KnoxRelay Lua bridge exports (`players_live.json`, `player_stats.json`)
//! - the PZ `server.ini` config file
//! - container state, read through the Docker socket proxy
//!
//! Every reader returns `Option`/`Result` rather than panicking. A missing file
//! is the normal state of a stopped server, not an error worth surfacing.

pub mod docker;
pub mod ini;
pub mod links;
pub mod lua;

pub use docker::{ContainerState, ContainerStatus, DockerClient, DockerError};
pub use ini::ServerIni;
pub use links::{LinkChannel, LinkRequest, LinkResult, LinkResults};
pub use lua::{LivePlayer, LuaBridge, PlayerStatsExport, PlayersLiveExport, StatsPlayer};
