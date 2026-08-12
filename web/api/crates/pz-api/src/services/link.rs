//! Linking a website account to an in-game character.
//!
//! The site issues a short one-time code to a signed-in account. The player
//! types `/account register <code>` in game, the mod records the claim, and the
//! consumer in `services::tasks` stamps the PZ username onto the account.
//!
//! A code rather than an email address on purpose: whatever is typed goes into
//! the chat channel and the server log, where other players can read it.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::ApiError;

/// Excludes characters that are easy to misread aloud or in a console font:
/// no I, L, O, 0 or 1.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const CODE_LENGTH: usize = 6;

/// Long enough to alt-tab into the game and type it, short enough that a code
/// read over someone's shoulder is not worth much.
pub const CODE_LIFETIME_MINUTES: i64 = 30;

#[derive(Debug, Clone, Serialize)]
pub struct LinkCode {
    pub code: String,
    pub expires_at: DateTime<Utc>,
}

/// What became of a claim from in game.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimOutcome {
    /// The account now carries this character's name.
    Linked,
    /// No such code. Mistyped, or never issued.
    UnknownCode,
    Expired,
    /// Already used — codes are single-use.
    AlreadyClaimed,
    /// The account behind the code already has a character.
    AccountAlreadyLinked,
    /// Another account already claimed this character name.
    NameTaken,
}

impl ClaimOutcome {
    pub fn is_success(self) -> bool {
        self == Self::Linked
    }
}

#[derive(FromRow)]
struct CodeRow {
    user_id: Uuid,
    expires_at: DateTime<Utc>,
    claimed_at: Option<DateTime<Utc>>,
}

/// Issue a code for an account that has no character yet.
///
/// Any previous unclaimed code for the account is dropped, so asking twice
/// replaces rather than accumulates — there is only ever one live code per
/// account to guess at.
pub async fn issue(db: &PgPool, user_id: Uuid) -> Result<LinkCode, ApiError> {
    let existing_username: Option<String> =
        sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(db)
            .await?;

    if let Some(username) = existing_username {
        return Err(ApiError::Validation(format!(
            "This account is already linked to {username}."
        )));
    }

    let code = generate_code()?;
    let expires_at = Utc::now() + Duration::minutes(CODE_LIFETIME_MINUTES);

    let mut transaction = db.begin().await?;

    sqlx::query("DELETE FROM account_link_codes WHERE user_id = $1 AND claimed_at IS NULL")
        .bind(user_id)
        .execute(&mut *transaction)
        .await?;

    sqlx::query("INSERT INTO account_link_codes (code, user_id, expires_at) VALUES ($1, $2, $3)")
        .bind(&code)
        .bind(user_id)
        .bind(expires_at)
        .execute(&mut *transaction)
        .await?;

    transaction.commit().await?;

    Ok(LinkCode { code, expires_at })
}

/// Claim a code with the name of the character that typed it.
pub async fn claim(db: &PgPool, code: &str, username: &str) -> Result<ClaimOutcome, ApiError> {
    let code = code.trim().to_uppercase();
    let username = username.trim();

    if username.is_empty() {
        return Ok(ClaimOutcome::UnknownCode);
    }

    let mut transaction = db.begin().await?;

    // Locked for the duration: two claims racing on one code must not both win.
    let row = sqlx::query_as::<_, CodeRow>(
        "SELECT user_id, expires_at, claimed_at FROM account_link_codes WHERE code = $1 FOR UPDATE",
    )
    .bind(&code)
    .fetch_optional(&mut *transaction)
    .await?;

    let Some(row) = row else {
        return Ok(ClaimOutcome::UnknownCode);
    };

    if row.claimed_at.is_some() {
        return Ok(ClaimOutcome::AlreadyClaimed);
    }

    if row.expires_at < Utc::now() {
        return Ok(ClaimOutcome::Expired);
    }

    let current: Option<String> =
        sqlx::query_scalar("SELECT username FROM users WHERE id = $1 FOR UPDATE")
            .bind(row.user_id)
            .fetch_one(&mut *transaction)
            .await?;

    if current.is_some() {
        return Ok(ClaimOutcome::AccountAlreadyLinked);
    }

    let linked = sqlx::query("UPDATE users SET username = $2, updated_at = now() WHERE id = $1")
        .bind(row.user_id)
        .bind(username)
        .execute(&mut *transaction)
        .await;

    if let Err(error) = linked {
        if is_username_conflict(&error) {
            return Ok(ClaimOutcome::NameTaken);
        }

        return Err(ApiError::Database(error));
    }

    sqlx::query(
        "UPDATE account_link_codes SET claimed_at = now(), claimed_username = $2 WHERE code = $1",
    )
    .bind(&code)
    .bind(username)
    .execute(&mut *transaction)
    .await?;

    transaction.commit().await?;

    Ok(ClaimOutcome::Linked)
}

/// Remove codes that expired without being claimed.
pub async fn prune_codes(db: &PgPool) -> Result<u64, ApiError> {
    let result = sqlx::query(
        "DELETE FROM account_link_codes WHERE claimed_at IS NULL AND expires_at < now()",
    )
    .execute(db)
    .await?;

    Ok(result.rows_affected())
}

fn is_username_conflict(error: &sqlx::Error) -> bool {
    let sqlx::Error::Database(db_error) = error else {
        return false;
    };

    db_error.constraint() == Some("users_username_lower_key")
}

/// Six characters of OS randomness over the alphabet above.
///
/// Rejection sampling rather than a plain modulo: 256 is not a multiple of 31,
/// so `byte % 31` would make the first few letters measurably likelier.
fn generate_code() -> Result<String, ApiError> {
    let alphabet_len = CODE_ALPHABET.len() as u8;
    let ceiling = u8::MAX - (u8::MAX % alphabet_len);

    let mut code = String::with_capacity(CODE_LENGTH);
    let mut buffer = [0u8; CODE_LENGTH * 2];

    while code.len() < CODE_LENGTH {
        getrandom::fill(&mut buffer).map_err(|error| {
            ApiError::Internal(format!("no system randomness available: {error}"))
        })?;

        for byte in buffer {
            if code.len() == CODE_LENGTH {
                break;
            }

            if byte < ceiling {
                code.push(CODE_ALPHABET[(byte % alphabet_len) as usize] as char);
            }
        }
    }

    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_the_right_shape() {
        let code = generate_code().expect("code");

        assert_eq!(code.len(), CODE_LENGTH);
        assert!(
            code.bytes().all(|byte| CODE_ALPHABET.contains(&byte)),
            "unexpected character in {code}",
        );
    }

    #[test]
    fn codes_avoid_characters_that_get_misread() {
        for _ in 0..200 {
            let code = generate_code().expect("code");

            assert!(
                !code.contains(['I', 'L', 'O', '0', '1']),
                "{code} contains an ambiguous character",
            );
        }
    }

    #[test]
    fn codes_differ_between_calls() {
        let first = generate_code().expect("code");
        let second = generate_code().expect("code");

        assert_ne!(first, second);
    }

    #[test]
    fn only_linking_counts_as_success() {
        assert!(ClaimOutcome::Linked.is_success());
        assert!(!ClaimOutcome::Expired.is_success());
        assert!(!ClaimOutcome::UnknownCode.is_success());
        assert!(!ClaimOutcome::NameTaken.is_success());
    }

    #[test]
    fn outcomes_serialise_for_the_result_ledger() {
        let json = serde_json::to_string(&ClaimOutcome::AccountAlreadyLinked).expect("serialise");

        assert_eq!(json, r#""account_already_linked""#);
    }
}
