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

pub mod catalog;
pub mod delivery;
pub mod deposit;
pub mod docker;
pub mod ini;
pub mod inventory;
pub mod links;
pub mod lua;
pub mod player_file;
pub mod respawn;
pub mod sanctuary;
pub mod steam;
pub mod steam_update;
pub mod tickets;
pub mod vitals;
pub mod whitelist;
pub mod workshop;

pub use catalog::{ITEMS_CATALOG_FILE, ItemCatalogEntry, ItemCatalogExport, ItemCatalogReader};
pub use delivery::{
    DeliveryChannel, DeliveryEntry, DeliveryError, DeliveryQueue, DeliveryResult, DeliveryResults,
};
pub use deposit::{
    DepositChannel, DepositError, DepositRates, DepositRequest, DepositRequests, DepositResult,
    DepositResults,
};
pub use docker::{ContainerState, ContainerStatus, DockerClient, DockerError, parse_docker_logs};
pub use ini::ServerIni;
pub use inventory::{InventoryReader, InventorySnapshot};
pub use links::{LinkChannel, LinkRequest, LinkResult, LinkResults};
pub use lua::{
    Death, DeathsExport, LivePlayer, LuaBridge, PlayerStatsExport, PlayersLiveExport, StatsPlayer,
};
pub use player_file::PlayerFile;
pub use respawn::{RespawnChannel, RespawnConfig, RespawnError, RespawnKick};
pub use steam::{SteamClient, SteamError};
pub use steam_update::{PublicUpdate, UpdateReport, UpdateVerdict};
pub use tickets::{
    ReportChannel, ReportRequest, ReportResult, ReportResults, TicketAction, TicketInbox,
    TicketMessage, TicketOutbox, TicketPlayerInbox, TicketSnapshot,
};
pub use vitals::{PlayerVitals, VitalsReader};
pub use whitelist::{WhitelistAccount, authenticate as authenticate_whitelist};
pub use workshop::{WorkshopDetails, parse_workshop_id};
