//! Postgres pool and migrations.
//!
//! Queries use the runtime-checked `query_as` API rather than the `query!`
//! macros on purpose: the macros need a reachable database at *compile* time,
//! which would mean standing up Postgres inside the Docker build.

use std::time::Duration;

use sqlx::postgres::{PgPool, PgPoolOptions};

pub async fn connect(url: &str, max_connections: u32) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .connect(url)
        .await
}

/// Apply any migrations the database has not seen yet.
///
/// Path is relative to this crate's manifest, so it points at `web/api/migrations`.
pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("../../migrations").run(pool).await
}
