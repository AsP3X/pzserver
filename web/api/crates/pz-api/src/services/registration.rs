//! Registration, which starts in game.
//!
//! A player runs `/account register` on the server. The mod reports the
//! character that ran it, this stack opens a registration and hands back a
//! short code, and the mod shows that code to the player. They then finish on
//! the website with an email and a password.
//!
//! The character is proven before the account exists, which is the point: there
//! is no way to end up with an account that has no character behind it.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool};

use crate::error::ApiError;
use crate::services::auth::{self, User};

/// Excludes characters that are easy to misread aloud or in a console font:
/// no I, L, O, 0 or 1.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const CODE_LENGTH: usize = 6;

/// Long enough to finish on the website after a play session, short enough
/// that a code left on screen is not useful the next day.
pub const CODE_LIFETIME_MINUTES: i64 = 12 * 60;

/// What came of a player running the command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OpenOutcome {
    /// A code the mod should show to the player.
    Issued {
        code: String,
        expires_at: DateTime<Utc>,
    },
    /// That character already has an account. Nothing to do.
    ///
    /// No longer produced by [`open`]: a second `/account register` issues a
    /// recovery code instead. Kept so older result ledgers still deserialise.
    #[allow(dead_code)]
    AlreadyRegistered,
}

#[derive(FromRow)]
struct RegistrationRow {
    username: String,
    steam_id: Option<String>,
    expires_at: DateTime<Utc>,
    consumed_at: Option<DateTime<Utc>>,
}

/// Open a registration for a character.
///
/// Always issues a code, even when the character already has a website row.
/// Completing that code updates the email and password, which is how a player
/// recovers a login. Running the command twice replaces the outstanding code
/// rather than adding a second, so only one code is ever live for a character.
pub async fn open(
    db: &PgPool,
    username: &str,
    steam_id: Option<&str>,
) -> Result<OpenOutcome, ApiError> {
    let username = username.trim();

    let code = generate_code()?;
    let expires_at = Utc::now() + Duration::minutes(CODE_LIFETIME_MINUTES);

    let mut transaction = db.begin().await?;

    sqlx::query(
        "DELETE FROM account_registrations WHERE lower(username) = lower($1) AND consumed_at IS NULL",
    )
    .bind(username)
    .execute(&mut *transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO account_registrations (code, username, steam_id, expires_at)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(&code)
    .bind(username)
    .bind(steam_id)
    .bind(expires_at)
    .execute(&mut *transaction)
    .await?;

    transaction.commit().await?;

    Ok(OpenOutcome::Issued { code, expires_at })
}

/// Turn a code plus credentials into an account.
///
/// Deliberately vague about why a code is no good: an attacker guessing codes
/// should not learn whether one exists, has expired or was already used.
pub async fn complete(
    db: &PgPool,
    code: &str,
    email: &str,
    password: &str,
) -> Result<User, ApiError> {
    let code = code.trim().to_uppercase();

    let mut transaction = db.begin().await?;

    let row = sqlx::query_as::<_, RegistrationRow>(
        r#"
        SELECT username, steam_id, expires_at, consumed_at
        FROM account_registrations
        WHERE code = $1
        FOR UPDATE
        "#,
    )
    .bind(&code)
    .fetch_optional(&mut *transaction)
    .await?;

    let usable = row.as_ref().is_some_and(|registration| {
        registration.consumed_at.is_none() && registration.expires_at > Utc::now()
    });

    let Some(registration) = row.filter(|_| usable) else {
        return Err(ApiError::Conflict {
            field: "code",
            message: "That code is not valid. Run /account register in game for a new one."
                .to_owned(),
        });
    };

    let user = auth::apply_registration(
        &mut transaction,
        &registration.username,
        registration.steam_id.as_deref(),
        email,
        password,
    )
    .await?;

    sqlx::query("UPDATE account_registrations SET consumed_at = now() WHERE code = $1")
        .bind(&code)
        .execute(&mut *transaction)
        .await?;

    transaction.commit().await?;

    Ok(user)
}

/// Remove codes that expired without being used.
pub async fn prune_codes(db: &PgPool) -> Result<u64, ApiError> {
    let result = sqlx::query(
        "DELETE FROM account_registrations WHERE consumed_at IS NULL AND expires_at < now()",
    )
    .execute(db)
    .await?;

    Ok(result.rows_affected())
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
        assert_ne!(
            generate_code().expect("code"),
            generate_code().expect("code")
        );
    }

    #[test]
    fn an_issued_outcome_carries_the_code_for_the_mod() {
        let outcome = OpenOutcome::Issued {
            code: "NYUY2Z".to_owned(),
            expires_at: Utc::now(),
        };

        let json = serde_json::to_string(&outcome).expect("serialise");

        assert!(json.contains(r#""status":"issued""#));
        assert!(json.contains(r#""code":"NYUY2Z""#));
    }

    #[test]
    fn an_already_registered_outcome_carries_no_code() {
        let json = serde_json::to_string(&OpenOutcome::AlreadyRegistered).expect("serialise");

        assert_eq!(json, r#"{"status":"already_registered"}"#);
    }
}
