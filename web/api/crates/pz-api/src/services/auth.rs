//! Accounts, passwords and server-side sessions.
//!
//! Sessions are opaque random tokens stored as SHA-256 digests, which makes
//! them revocable one by one and keeps a database dump from handing anyone a
//! working login. Passwords are Argon2id.

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::error::ApiError;

/// How long a session stays valid. Fixed rather than sliding: a month of
/// inactivity is a reasonable point to ask someone to log in again.
pub const SESSION_LIFETIME_DAYS: i64 = 30;

/// Shortest password we accept. Longer than the eight the PHP stack inherited
/// from Fortify's defaults — this is a fresh user base, so the bar can start
/// where it should be.
const MIN_PASSWORD_LENGTH: usize = 10;

/// Argon2 happily hashes a megabyte of input and takes its time doing so.
const MAX_PASSWORD_LENGTH: usize = 200;

const MAX_USERNAME_LENGTH: usize = 50;

/// A user as the rest of the application sees them — no password hash.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct User {
    pub id: Uuid,
    /// The PZ name. Always present: accounts are only created for a character
    /// that has already proven itself in game.
    pub username: String,
    pub email: String,
    pub role: String,
    pub steam_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct Credentials {
    id: Uuid,
    password_hash: String,
}

/// Create the account behind a completed in-game registration.
///
/// Takes the caller's transaction because the row that authorised this — the
/// registration code — is consumed in the same one: either both happen or
/// neither does, so a failure cannot burn a code without producing an account.
///
/// There is no other way to create a user. Accounts exist only for characters
/// that have proven themselves on the server.
pub async fn create_from_registration(
    transaction: &mut Transaction<'_, Postgres>,
    username: &str,
    steam_id: Option<&str>,
    email: &str,
    password: &str,
) -> Result<User, ApiError> {
    let username = username.trim();
    let email = email.trim();

    validate_username(username)?;
    validate_email(email)?;
    validate_password(password)?;

    let password_hash = hash_password(password)?;

    let user = sqlx::query_as::<_, User>(
        r#"
        INSERT INTO users (username, steam_id, email, password_hash)
        VALUES ($1, $2, $3, $4)
        RETURNING id, username, email, role, steam_id, created_at
        "#,
    )
    .bind(username)
    .bind(steam_id)
    .bind(email)
    .bind(&password_hash)
    .fetch_one(&mut **transaction)
    .await
    .map_err(taken_field)?;

    Ok(user)
}

/// Turn a unique-violation into a message pointing at the offending input.
fn taken_field(error: sqlx::Error) -> ApiError {
    let sqlx::Error::Database(ref db_error) = error else {
        return ApiError::Database(error);
    };

    match db_error.constraint() {
        Some("users_username_lower_key") => ApiError::Conflict {
            field: "username",
            message: "That character is already linked to another account.".to_owned(),
        },
        Some("users_email_lower_key") => ApiError::Conflict {
            field: "email",
            message: "An account with that email already exists.".to_owned(),
        },
        _ => ApiError::Database(error),
    }
}

/// Check an email and password, returning the user when they match.
///
/// Email rather than username, because a freshly registered account has no
/// username at all until a character is linked. Lookups are case-insensitive,
/// and a miss still pays for a hash verification so that "no such account" and
/// "wrong password" take the same time — otherwise the endpoint answers whether
/// an address is registered.
pub async fn authenticate(
    db: &PgPool,
    email: &str,
    password: &str,
) -> Result<Option<User>, ApiError> {
    let credentials = sqlx::query_as::<_, Credentials>(
        "SELECT id, password_hash FROM users WHERE lower(email) = lower($1)",
    )
    .bind(email.trim())
    .fetch_optional(db)
    .await?;

    let Some(credentials) = credentials else {
        burn_time();
        return Ok(None);
    };

    if !verify_password(password, &credentials.password_hash) {
        return Ok(None);
    }

    let user = sqlx::query_as::<_, User>(
        "SELECT id, username, email, role, steam_id, created_at FROM users WHERE id = $1",
    )
    .bind(credentials.id)
    .fetch_one(db)
    .await?;

    Ok(Some(user))
}

/// Issue a session and return the raw token, which is only ever seen here and
/// in the cookie — the database keeps its digest.
pub async fn create_session(
    db: &PgPool,
    user_id: Uuid,
    user_agent: Option<&str>,
) -> Result<SessionToken, ApiError> {
    let token = generate_token()?;
    let expires_at = Utc::now() + Duration::days(SESSION_LIFETIME_DAYS);

    sqlx::query(
        r#"
        INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(user_id)
    .bind(digest(&token))
    .bind(expires_at)
    .bind(user_agent)
    .execute(db)
    .await?;

    Ok(SessionToken { token, expires_at })
}

pub struct SessionToken {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

/// Resolve a cookie value to its user, or `None` if the session is unknown or
/// expired.
///
/// The `last_seen_at` touch rides along in the same round trip, and only fires
/// when the stored value is already stale, so an active session costs one
/// query and at most one write per quarter hour.
pub async fn user_for_token(db: &PgPool, token: &str) -> Result<Option<User>, ApiError> {
    let token_hash = digest(token);

    let user = sqlx::query_as::<_, User>(
        r#"
        WITH touched AS (
            UPDATE sessions
            SET last_seen_at = now()
            WHERE token_hash = $1
              AND expires_at > now()
              AND last_seen_at < now() - interval '15 minutes'
            RETURNING user_id
        )
        SELECT u.id, u.username, u.email, u.role, u.steam_id, u.created_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > now()
        "#,
    )
    .bind(&token_hash)
    .fetch_optional(db)
    .await?;

    Ok(user)
}

/// Drop a single session. Logging out must not sign the user out everywhere.
pub async fn revoke_session(db: &PgPool, token: &str) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
        .bind(digest(token))
        .execute(db)
        .await?;

    Ok(())
}

/// Replace a user's password, then drop every session except the one making
/// the request. Returns how many sessions were revoked.
pub async fn change_password(
    db: &PgPool,
    user_id: Uuid,
    current_password: &str,
    new_password: &str,
    keep_token: &str,
) -> Result<u64, ApiError> {
    let credentials =
        sqlx::query_as::<_, Credentials>("SELECT id, password_hash FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(db)
            .await?;

    if !verify_password(current_password, &credentials.password_hash) {
        return Err(ApiError::Validation(
            "Your current password is not correct.".to_owned(),
        ));
    }

    validate_password(new_password)?;

    let mut transaction = db.begin().await?;

    sqlx::query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1")
        .bind(user_id)
        .bind(hash_password(new_password)?)
        .execute(&mut *transaction)
        .await?;

    let revoked = sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2")
        .bind(user_id)
        .bind(digest(keep_token))
        .execute(&mut *transaction)
        .await?
        .rows_affected();

    transaction.commit().await?;

    Ok(revoked)
}

/// Delete sessions that are past their expiry.
pub async fn prune_sessions(db: &PgPool) -> Result<u64, ApiError> {
    let result = sqlx::query("DELETE FROM sessions WHERE expires_at < now()")
        .execute(db)
        .await?;

    Ok(result.rows_affected())
}

/// Create the first administrator from the environment, if there is none yet.
///
/// Mirrors what the PHP stack's entrypoint does, so a fresh deployment has a
/// way in without anyone opening a database console. Does nothing once any
/// admin exists, so it cannot be used to reset a forgotten password.
///
/// This is the one account whose username is set without an in-game claim:
/// `ADMIN_USERNAME` pre-links the operator's own character. Everyone else gets
/// their name from `/account register`.
pub async fn ensure_admin(
    db: &PgPool,
    username: &str,
    email: &str,
    password: &str,
) -> Result<bool, ApiError> {
    let admin_exists: bool = sqlx::query_scalar(
        "SELECT exists (SELECT 1 FROM users WHERE role IN ('admin', 'super_admin'))",
    )
    .fetch_one(db)
    .await?;

    if admin_exists {
        return Ok(false);
    }

    validate_username(username)?;
    validate_email(email)?;
    validate_password(password)?;

    sqlx::query(
        r#"
        INSERT INTO users (username, email, password_hash, role)
        VALUES ($1, $2, $3, 'super_admin')
        "#,
    )
    .bind(username.trim())
    .bind(email.trim())
    .bind(hash_password(password)?)
    .execute(db)
    .await
    .map_err(taken_field)?;

    Ok(true)
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

fn hash_password(password: &str) -> Result<String, ApiError> {
    // Salt bytes come straight from the OS rather than through argon2's
    // re-exported RNG, which keeps this off the rand_core version treadmill.
    let mut salt_bytes = [0u8; 16];
    os_random(&mut salt_bytes)?;

    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|error| ApiError::Internal(format!("salt encoding failed: {error}")))?;

    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| ApiError::Internal(format!("password hashing failed: {error}")))
}

fn verify_password(password: &str, hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        // A hash we cannot parse is a corrupt row, not a valid login.
        tracing::error!("stored password hash is unparseable");
        return false;
    };

    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// Spend roughly what a real verification costs, so a missing account is not
/// detectable by how fast the answer comes back.
fn burn_time() {
    const DUMMY: &str = "$argon2id$v=19$m=19456,t=2,p=1\
        $c29tZXNhbHRzb21lc2FsdA$KIL9r5wKvQ7hZ4hSN0Zj0oq8vXk1oQnJZ0Y3wJbHqUE";

    if let Ok(parsed) = PasswordHash::new(DUMMY) {
        let _ = Argon2::default().verify_password(b"not the password", &parsed);
    }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// 256 bits from the OS, hex encoded — cookie-safe without any escaping.
fn generate_token() -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    os_random(&mut bytes)?;

    Ok(to_hex(&bytes))
}

/// Fill a buffer with OS entropy.
///
/// A failure here means the system has no usable randomness, which must abort
/// whatever we were doing — never fall back to a weaker source for a session
/// token or a salt.
fn os_random(buffer: &mut [u8]) -> Result<(), ApiError> {
    getrandom::fill(buffer)
        .map_err(|error| ApiError::Internal(format!("no system randomness available: {error}")))
}

fn digest(token: &str) -> String {
    to_hex(&Sha256::digest(token.as_bytes()))
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;

    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn validate_username(username: &str) -> Result<(), ApiError> {
    if username.is_empty() || username.len() > MAX_USERNAME_LENGTH {
        return Err(ApiError::Validation(format!(
            "Name must be between 1 and {MAX_USERNAME_LENGTH} characters."
        )));
    }

    // Matches the database constraint and the PHP stack's route patterns. PZ
    // itself is unhappy with anything more adventurous.
    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(ApiError::Validation(
            "Name can only contain letters, numbers and underscores.".to_owned(),
        ));
    }

    Ok(())
}

fn validate_email(email: &str) -> Result<(), ApiError> {
    // Deliberately shallow. Anything stricter rejects addresses that work, and
    // the only real proof is sending mail to it.
    let looks_like_an_address = email.len() >= 3
        && email.len() <= 254
        && !email.starts_with('@')
        && !email.ends_with('@')
        && email.matches('@').count() == 1
        && !email.contains(' ');

    if !looks_like_an_address {
        return Err(ApiError::Validation(
            "That does not look like an email address.".to_owned(),
        ));
    }

    Ok(())
}

fn validate_password(password: &str) -> Result<(), ApiError> {
    if password.len() < MIN_PASSWORD_LENGTH {
        return Err(ApiError::Validation(format!(
            "Password must be at least {MIN_PASSWORD_LENGTH} characters."
        )));
    }

    if password.len() > MAX_PASSWORD_LENGTH {
        return Err(ApiError::Validation(format!(
            "Password must be at most {MAX_PASSWORD_LENGTH} characters."
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hashed_password_verifies_against_itself() {
        let hash = hash_password("correct horse battery").expect("hash");

        assert!(verify_password("correct horse battery", &hash));
        assert!(!verify_password("Correct horse battery", &hash));
    }

    #[test]
    fn hashing_the_same_password_twice_gives_different_hashes() {
        let first = hash_password("correct horse battery").expect("hash");
        let second = hash_password("correct horse battery").expect("hash");

        assert_ne!(first, second, "salt should differ per hash");
    }

    #[test]
    fn a_corrupt_hash_never_verifies() {
        assert!(!verify_password("anything", "not-a-hash"));
        assert!(!verify_password("anything", ""));
    }

    #[test]
    fn the_dummy_verification_hash_is_parseable() {
        // If this hash ever stops parsing, burn_time() silently stops costing
        // anything and the timing side channel quietly comes back.
        const DUMMY: &str = "$argon2id$v=19$m=19456,t=2,p=1\
            $c29tZXNhbHRzb21lc2FsdA$KIL9r5wKvQ7hZ4hSN0Zj0oq8vXk1oQnJZ0Y3wJbHqUE";

        assert!(PasswordHash::new(DUMMY).is_ok());
    }

    #[test]
    fn tokens_are_unique_and_full_length() {
        let first = generate_token().expect("token");
        let second = generate_token().expect("token");

        assert_eq!(first.len(), 64, "32 bytes, hex encoded");
        assert_ne!(first, second);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn digests_are_stable_and_not_the_token() {
        let token = generate_token().expect("token");

        assert_eq!(digest(&token), digest(&token));
        assert_ne!(digest(&token), token);
        assert_eq!(digest(&token).len(), 64);
    }

    #[test]
    fn usernames_match_the_database_constraint() {
        assert!(validate_username("giorgi_99").is_ok());
        assert!(validate_username("").is_err());
        assert!(validate_username("has space").is_err());
        assert!(validate_username("drop;table").is_err());
        assert!(validate_username(&"a".repeat(51)).is_err());
        assert!(validate_username(&"a".repeat(50)).is_ok());
    }

    #[test]
    fn passwords_have_a_floor_and_a_ceiling() {
        assert!(validate_password("123456789").is_err());
        assert!(validate_password("1234567890").is_ok());
        assert!(validate_password(&"a".repeat(201)).is_err());
    }

    #[test]
    fn obvious_non_addresses_are_rejected() {
        assert!(validate_email("player@example.ge").is_ok());
        assert!(validate_email("player+tag@example.co.uk").is_ok());
        assert!(validate_email("@example.ge").is_err());
        assert!(validate_email("player@").is_err());
        assert!(validate_email("two@at@signs").is_err());
        assert!(validate_email("no at sign").is_err());
    }
}
