//! Aggregate queries behind the public stat band, leaderboard and history graph.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

/// Server-wide totals shown in the landing page's stat band.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct StatsSummary {
    pub total_players: i64,
    pub total_zombie_kills: i64,
    pub total_hours_survived: f64,
    pub total_deaths: i64,
    pub total_pvp_kills: i64,
    pub most_popular_profession: Option<String>,
}

/// Which column a leaderboard sorts by.
///
/// This is an enum rather than a string because the value reaches an
/// `ORDER BY`; only these two variants can ever name a column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LeaderboardStat {
    #[default]
    ZombieKills,
    HoursSurvived,
}

/// Builds a leaderboard query with the ordering baked in at compile time.
///
/// sqlx 0.9 only accepts `&'static str` as SQL, which rules out formatting a
/// column name into the query at runtime — and that is the right constraint:
/// each ordering becomes a fixed string the planner can match against the
/// matching index on `player_stats`.
macro_rules! leaderboard_sql {
    ($ordering:literal) => {
        concat!(
            "SELECT row_number() OVER (ORDER BY ",
            $ordering,
            ")::bigint AS rank, \
             username, \
             zombie_kills, \
             hours_survived::double precision AS hours_survived, \
             profession, \
             is_dead \
             FROM player_stats \
             ORDER BY ",
            $ordering,
            " LIMIT $1"
        )
    };
}

impl LeaderboardStat {
    /// The pre-built query that sorts by this stat.
    fn query(self) -> &'static str {
        match self {
            Self::ZombieKills => leaderboard_sql!("zombie_kills DESC, username ASC"),
            Self::HoursSurvived => leaderboard_sql!("hours_survived DESC, username ASC"),
        }
    }
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct LeaderboardEntry {
    pub rank: i64,
    pub username: String,
    pub zombie_kills: i32,
    pub hours_survived: f64,
    pub profession: Option<String>,
    pub is_dead: bool,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct StatusSample {
    pub sampled_at: DateTime<Utc>,
    pub online: bool,
    pub player_count: i32,
}

/// Everything the stat band needs, in one round trip.
pub async fn summary(db: &PgPool) -> Result<StatsSummary, sqlx::Error> {
    // Casts are explicit because sum() over integer/real returns bigint/real,
    // and the decoded Rust types have to line up exactly.
    sqlx::query_as::<_, StatsSummary>(
        r#"
        SELECT
            (SELECT count(*) FROM player_stats)::bigint AS total_players,
            (SELECT coalesce(sum(zombie_kills), 0) FROM player_stats)::bigint AS total_zombie_kills,
            (SELECT coalesce(sum(hours_survived), 0) FROM player_stats)::double precision AS total_hours_survived,
            (SELECT count(*) FROM game_events WHERE event_type = 'death')::bigint AS total_deaths,
            (SELECT count(*) FROM game_events WHERE event_type = 'pvp_kill')::bigint AS total_pvp_kills,
            (
                SELECT profession
                FROM player_stats
                WHERE profession IS NOT NULL
                GROUP BY profession
                ORDER BY count(*) DESC, profession ASC
                LIMIT 1
            ) AS most_popular_profession
        "#,
    )
    .fetch_one(db)
    .await
}

pub async fn leaderboard(
    db: &PgPool,
    stat: LeaderboardStat,
    limit: i64,
) -> Result<Vec<LeaderboardEntry>, sqlx::Error> {
    sqlx::query_as::<_, LeaderboardEntry>(stat.query())
        .bind(limit)
        .fetch_all(db)
        .await
}

/// Population samples for the last `hours`, oldest first.
pub async fn history(db: &PgPool, hours: i32) -> Result<Vec<StatusSample>, sqlx::Error> {
    sqlx::query_as::<_, StatusSample>(
        r#"
        SELECT sampled_at, online, player_count
        FROM server_status_samples
        WHERE sampled_at > now() - make_interval(hours => $1)
        ORDER BY sampled_at ASC
        "#,
    )
    .bind(hours)
    .fetch_all(db)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_stat_orders_by_its_own_column() {
        assert!(
            LeaderboardStat::ZombieKills
                .query()
                .contains("ORDER BY zombie_kills DESC")
        );
        assert!(
            LeaderboardStat::HoursSurvived
                .query()
                .contains("ORDER BY hours_survived DESC")
        );
    }

    #[test]
    fn stat_deserialises_from_the_query_string_form() {
        let stat: LeaderboardStat =
            serde_json::from_str(r#""hours_survived""#).expect("deserialise");

        assert_eq!(stat, LeaderboardStat::HoursSurvived);
        assert!(serde_json::from_str::<LeaderboardStat>(r#""; DROP TABLE""#).is_err());
    }
}
