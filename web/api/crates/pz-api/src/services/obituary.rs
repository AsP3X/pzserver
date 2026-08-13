//! The public record of who died and what killed them.
//!
//! Reads `game_events`, which the deaths sync fills from the mod's rolling
//! export. The mod knows things the server log cannot: a log line says someone
//! died, but only the game knows at the moment of death whether it was a bite,
//! a fire or another player.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool};

/// One entry in the obituary.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Obit {
    pub username: String,
    /// `player`, `fire`, `infection` or `unknown`.
    pub cause: String,
    /// Set only when another player was credited.
    pub killer: Option<String>,
    /// The item type, as the game names it — `Base.Axe`, not "Fire Axe".
    pub weapon: Option<String>,
    pub hours_survived: f64,
    pub zombie_kills: i64,
    pub x: Option<f32>,
    pub y: Option<f32>,
    /// The in-game date, as the mod wrote it. Reads 1993.
    pub world_time: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

/// How the dead were lost, most recent first.
///
/// `before` pages backwards through time rather than by offset: the table is
/// append-only and an import landing mid-scroll would otherwise shift every
/// later page by one and duplicate a row across the seam.
pub async fn recent(
    db: &PgPool,
    limit: i64,
    before: Option<DateTime<Utc>>,
) -> Result<Vec<Obit>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
            player                                        AS username,
            coalesce(detail ->> 'cause', 'unknown')       AS cause,
            detail ->> 'killer'                           AS killer,
            detail ->> 'weapon'                           AS weapon,
            coalesce((detail ->> 'hours_survived')::double precision, 0) AS hours_survived,
            coalesce((detail ->> 'zombie_kills')::bigint, 0)             AS zombie_kills,
            x,
            y,
            detail ->> 'world_time'                       AS world_time,
            occurred_at
        FROM game_events
        WHERE event_type = 'death'
          AND player IS NOT NULL
          AND ($2::timestamptz IS NULL OR occurred_at < $2)
        ORDER BY occurred_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit)
    .bind(before)
    .fetch_all(db)
    .await
}

/// Server-wide totals for the band above the roll.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ObituarySummary {
    pub total_deaths: i64,
    /// Deaths credited to another player.
    pub total_pvp_deaths: i64,
    /// The longest anyone lasted before dying, in hours.
    pub longest_life: f64,
    /// Who has killed the most other players, and how many.
    pub deadliest_survivor: Option<String>,
    pub deadliest_survivor_kills: i64,
}

pub async fn summary(db: &PgPool) -> Result<ObituarySummary, sqlx::Error> {
    sqlx::query_as(
        r#"
        WITH deaths AS (
            SELECT detail, player FROM game_events WHERE event_type = 'death'
        ),
        deadliest AS (
            SELECT player, count(*) AS kills
            FROM game_events
            WHERE event_type = 'pvp_kill' AND player IS NOT NULL
            GROUP BY player
            ORDER BY kills DESC, player ASC
            LIMIT 1
        )
        SELECT
            (SELECT count(*) FROM deaths)::bigint AS total_deaths,
            (SELECT count(*) FROM deaths WHERE detail ->> 'killer' IS NOT NULL)::bigint
                AS total_pvp_deaths,
            (SELECT coalesce(max((detail ->> 'hours_survived')::double precision), 0)
             FROM deaths) AS longest_life,
            (SELECT player FROM deadliest) AS deadliest_survivor,
            (SELECT coalesce(kills, 0) FROM deadliest)::bigint AS deadliest_survivor_kills
        "#,
    )
    .fetch_one(db)
    .await
}
