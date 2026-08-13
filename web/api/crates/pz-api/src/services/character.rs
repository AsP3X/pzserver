//! A single player's character, as folded in from the mod's export.
//!
//! Web accounts and in-game characters are joined on the username — which is
//! why registration asks for the name you play under. The match is
//! case-insensitive, like the login lookup.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool};

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Character {
    pub username: String,
    pub zombie_kills: i32,
    pub hours_survived: f64,
    pub profession: Option<String>,

    /// Perk name to level. Untrained perks are absent, not zero.
    pub skills: Value,
    /// Absent on KnoxRelay builds older than 1.3.
    pub traits: Option<Value>,
    /// `{ health, bleeding_parts, infected, has_cold }`.
    pub vitals: Option<Value>,
    /// Hair, skin and hat as the mod last reported them.
    pub appearance: Option<Value>,

    pub is_dead: bool,

    /// Position on the kills leaderboard. Ties share a place.
    pub rank: i64,
    /// When the mod last reported this character.
    pub last_synced_at: DateTime<Utc>,
}

/// Look up a character by the name its owner plays under.
///
/// `None` means the account has never been seen in game — someone who
/// registered on the site before joining, which the UI explains rather than
/// treating as an error.
pub async fn for_username(db: &PgPool, username: &str) -> Result<Option<Character>, sqlx::Error> {
    sqlx::query_as::<_, Character>(
        r#"
        WITH ranked AS (
            SELECT username,
                   zombie_kills,
                   hours_survived::double precision AS hours_survived,
                   profession,
                   skills,
                   traits,
                   vitals,
                   appearance,
                   is_dead,
                   last_synced_at,
                   rank() OVER (ORDER BY zombie_kills DESC)::bigint AS rank
            FROM player_stats
        )
        SELECT username, zombie_kills, hours_survived, profession, skills, traits,
               vitals, appearance, is_dead, last_synced_at, rank
        FROM ranked
        WHERE lower(username) = lower($1)
        "#,
    )
    .bind(username)
    .fetch_optional(db)
    .await
}

/// Last tile the live roster reported for this character, if any.
#[derive(Debug, Clone, Copy)]
pub struct LastPosition {
    pub x: f64,
    pub y: f64,
    pub z: i32,
}

pub async fn last_position(db: &PgPool, username: &str) -> Result<Option<LastPosition>, sqlx::Error> {
    sqlx::query_as::<_, (Option<f64>, Option<f64>, Option<i32>)>(
        r#"
        SELECT x, y, z
        FROM player_stats
        WHERE lower(username) = lower($1)
        "#,
    )
    .bind(username)
    .fetch_optional(db)
    .await
    .map(|row| {
        row.and_then(|(x, y, z)| {
            Some(LastPosition {
                x: x?,
                y: y?,
                z: z.unwrap_or(0),
            })
        })
    })
}

/// Whether a name appears in the current online roster.
///
/// PZ usernames are case-sensitive in game but accounts are not, so the
/// comparison is case-insensitive on both sides to avoid telling someone they
/// are offline while they are standing in Muldraugh.
pub fn is_online(online_players: &[String], username: &str) -> bool {
    online_players
        .iter()
        .any(|player| player.eq_ignore_ascii_case(username))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_roster_regardless_of_case() {
        let roster = vec!["Rook".to_owned(), "vesper".to_owned()];

        assert!(is_online(&roster, "rook"));
        assert!(is_online(&roster, "ROOK"));
        assert!(is_online(&roster, "Vesper"));
    }

    #[test]
    fn reports_absent_names_as_offline() {
        let roster = vec!["Rook".to_owned()];

        assert!(!is_online(&roster, "marlowe"));
        assert!(!is_online(&[], "rook"));
    }
}
