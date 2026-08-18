//! Opt-in TOTP, and the challenge that sits between password and session.
//!
//! Enrolment is deliberately two steps. Step one hands out a secret and an
//! `otpauth://` URI; step two requires a code generated from it. Only step two
//! sets `two_factor_confirmed_at`, so someone who scans a QR code and then
//! closes the tab is not locked out of their own account.
//!
//! Logging in with 2FA on never issues a session directly. The password check
//! produces a short-lived challenge token instead, which a correct code
//! exchanges for the real thing.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use totp_rs::{Algorithm, Secret, TOTP};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

/// Six digits over thirty seconds — what every authenticator app assumes when
/// it is handed a bare otpauth URI, and what Google Authenticator supports.
const DIGITS: usize = 6;
const STEP_SECONDS: u64 = 30;

/// Accept the neighbouring windows so a phone clock a few seconds out still
/// works. One either side is the usual compromise: it widens the guess space
/// by a factor of three, which the attempt limit below covers.
const DRIFT_STEPS: u8 = 1;

/// How long the half-authenticated state lives. Long enough to fish a phone
/// out of a pocket, short enough that an intercepted token is not useful later.
const CHALLENGE_LIFETIME_MINUTES: i64 = 5;

/// Wrong codes allowed against one challenge before it is burned.
///
/// Kept in the row rather than in memory so restarting the API does not hand
/// an attacker a fresh budget.
const MAX_CHALLENGE_ATTEMPTS: i32 = 5;

const RECOVERY_CODE_COUNT: usize = 8;

/// Crockford-ish: no I, L, O, 0 or 1, for the same reason registration codes
/// avoid them — these get read aloud and copied off paper.
const RECOVERY_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_LENGTH: usize = 10;

/// What the enrolment screen needs. The secret is shown once, here, and never
/// again — after this it only ever leaves the database to verify a code.
#[derive(Debug, Clone, Serialize)]
pub struct Enrolment {
    /// Base32, for someone typing it in by hand.
    pub secret: String,
    /// `otpauth://totp/...`, which the browser renders as a QR code.
    pub uri: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TwoFactorStatus {
    pub enabled: bool,
    /// Null unless enrolment finished.
    pub confirmed_at: Option<DateTime<Utc>>,
    /// How many one-time codes are still unused.
    pub recovery_codes_left: i64,
}

#[derive(Debug, FromRow)]
struct SecretRow {
    two_factor_secret: Option<String>,
    two_factor_confirmed_at: Option<DateTime<Utc>>,
}

/// A challenge token, handed to the client after a correct password.
pub struct Challenge {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

/// Whether this account must answer a code to sign in.
pub async fn is_enabled(db: &PgPool, user_id: Uuid) -> Result<bool, ApiError> {
    let enabled = sqlx::query_scalar::<_, bool>(
        "SELECT two_factor_confirmed_at IS NOT NULL FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .unwrap_or(false);

    Ok(enabled)
}

pub async fn status(db: &PgPool, user_id: Uuid) -> ApiResult<TwoFactorStatus> {
    let row = sqlx::query_as::<_, SecretRow>(
        "SELECT two_factor_secret, two_factor_confirmed_at FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;

    let recovery_codes_left = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM two_factor_recovery_codes WHERE user_id = $1 AND used_at IS NULL",
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;

    Ok(TwoFactorStatus {
        enabled: row.two_factor_confirmed_at.is_some(),
        confirmed_at: row.two_factor_confirmed_at,
        recovery_codes_left,
    })
}

/// Step one: mint a secret and hand back something to scan.
///
/// Overwrites any unconfirmed secret, so restarting a half-finished enrolment
/// works. Refuses once 2FA is on — changing the secret then would be a way to
/// take over an account from a session that is already open.
pub async fn begin(
    db: &PgPool,
    user_id: Uuid,
    username: &str,
    issuer: &str,
) -> ApiResult<Enrolment> {
    if is_enabled(db, user_id).await? {
        return Err(ApiError::Validation(
            "Two-factor is already on. Turn it off first to enrol a new device.".to_owned(),
        ));
    }

    let secret = Secret::generate_secret();
    let base32 = secret.to_encoded().to_string();

    let totp = build(&base32, username, issuer)?;
    let uri = totp.get_url();

    sqlx::query(
        r#"UPDATE users
           SET two_factor_secret = $2, two_factor_confirmed_at = NULL, updated_at = now()
           WHERE id = $1"#,
    )
    .bind(user_id)
    .bind(&base32)
    .execute(db)
    .await?;

    Ok(Enrolment { secret: base32, uri })
}

/// Step two: prove the app works, switch 2FA on, and hand back recovery codes.
///
/// The codes are returned exactly once — only their digests are stored.
pub async fn confirm(
    db: &PgPool,
    user_id: Uuid,
    username: &str,
    issuer: &str,
    code: &str,
) -> ApiResult<Vec<String>> {
    let row = sqlx::query_as::<_, SecretRow>(
        "SELECT two_factor_secret, two_factor_confirmed_at FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;

    if row.two_factor_confirmed_at.is_some() {
        return Err(ApiError::Validation(
            "Two-factor is already on.".to_owned(),
        ));
    }

    let Some(secret) = row.two_factor_secret else {
        return Err(ApiError::Validation(
            "Start the setup again — there is no pending enrolment.".to_owned(),
        ));
    };

    if !check(&secret, username, issuer, code)? {
        return Err(ApiError::Validation(
            "That code is not right. Check your app and try again.".to_owned(),
        ));
    }

    let codes: Vec<String> = (0..RECOVERY_CODE_COUNT)
        .map(|_| recovery_code())
        .collect::<Result<_, _>>()?;

    let mut transaction = db.begin().await?;

    sqlx::query(
        "UPDATE users SET two_factor_confirmed_at = now(), updated_at = now() WHERE id = $1",
    )
    .bind(user_id)
    .execute(&mut *transaction)
    .await?;

    // Enrolling again after a disable must not leave the old codes working.
    sqlx::query("DELETE FROM two_factor_recovery_codes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *transaction)
        .await?;

    for code in &codes {
        sqlx::query(
            "INSERT INTO two_factor_recovery_codes (user_id, code_hash) VALUES ($1, $2)",
        )
        .bind(user_id)
        .bind(digest(code))
        .execute(&mut *transaction)
        .await?;
    }

    transaction.commit().await?;

    tracing::info!(username, "two-factor enabled");

    Ok(codes)
}

/// Turn 2FA off, taking the secret and every recovery code with it.
pub async fn disable(db: &PgPool, user_id: Uuid, username: &str) -> ApiResult<()> {
    let mut transaction = db.begin().await?;

    sqlx::query(
        r#"UPDATE users
           SET two_factor_secret = NULL, two_factor_confirmed_at = NULL, updated_at = now()
           WHERE id = $1"#,
    )
    .bind(user_id)
    .execute(&mut *transaction)
    .await?;

    sqlx::query("DELETE FROM two_factor_recovery_codes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *transaction)
        .await?;

    // Any half-finished login for this account dies with it.
    sqlx::query("DELETE FROM two_factor_challenges WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *transaction)
        .await?;

    transaction.commit().await?;

    tracing::info!(username, "two-factor disabled");

    Ok(())
}

/// Open the half-authenticated window after a correct password.
pub async fn open_challenge(db: &PgPool, user_id: Uuid) -> ApiResult<Challenge> {
    let token = random_hex()?;
    let expires_at = Utc::now() + Duration::minutes(CHALLENGE_LIFETIME_MINUTES);

    sqlx::query(
        "INSERT INTO two_factor_challenges (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    )
    .bind(digest(&token))
    .bind(user_id)
    .bind(expires_at)
    .execute(db)
    .await?;

    Ok(Challenge { token, expires_at })
}

#[derive(Debug, FromRow)]
struct ChallengeRow {
    user_id: Uuid,
    attempts: i32,
}

/// Exchange a challenge token plus a code for the user behind it.
///
/// Accepts either a TOTP code or an unused recovery code. The challenge is
/// consumed on success and burned once the attempt budget runs out, so a
/// stolen token cannot be brute-forced at leisure.
pub async fn answer_challenge(
    db: &PgPool,
    token: &str,
    code: &str,
    username_for: impl AsyncFnOnce(Uuid) -> Result<(String, String), ApiError>,
    issuer: &str,
) -> ApiResult<Uuid> {
    let token_hash = digest(token);

    let row = sqlx::query_as::<_, ChallengeRow>(
        r#"SELECT user_id, attempts FROM two_factor_challenges
           WHERE token_hash = $1 AND expires_at > now()"#,
    )
    .bind(&token_hash)
    .fetch_optional(db)
    .await?;

    let Some(challenge) = row else {
        return Err(ApiError::Validation(
            "That sign-in has expired. Start again.".to_owned(),
        ));
    };

    let (username, secret) = username_for(challenge.user_id).await?;

    let matched = check(&secret, &username, issuer, code)?
        || consume_recovery(db, challenge.user_id, code).await?;

    if !matched {
        let attempts = challenge.attempts + 1;

        if attempts >= MAX_CHALLENGE_ATTEMPTS {
            sqlx::query("DELETE FROM two_factor_challenges WHERE token_hash = $1")
                .bind(&token_hash)
                .execute(db)
                .await?;

            tracing::warn!(username, "two-factor challenge burned after too many wrong codes");

            return Err(ApiError::TooManyRequests);
        }

        sqlx::query("UPDATE two_factor_challenges SET attempts = $2 WHERE token_hash = $1")
            .bind(&token_hash)
            .bind(attempts)
            .execute(db)
            .await?;

        return Err(ApiError::Validation(
            "That code is not right.".to_owned(),
        ));
    }

    sqlx::query("DELETE FROM two_factor_challenges WHERE token_hash = $1")
        .bind(&token_hash)
        .execute(db)
        .await?;

    Ok(challenge.user_id)
}

/// Spend a recovery code, if `code` is one. Each works exactly once.
async fn consume_recovery(db: &PgPool, user_id: Uuid, code: &str) -> Result<bool, ApiError> {
    let normalised = code.trim().to_uppercase().replace(['-', ' '], "");

    let spent = sqlx::query(
        r#"UPDATE two_factor_recovery_codes
           SET used_at = now()
           WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL"#,
    )
    .bind(user_id)
    .bind(digest(&normalised))
    .execute(db)
    .await?
    .rows_affected();

    if spent == 1 {
        tracing::warn!(%user_id, "signed in with a two-factor recovery code");
    }

    Ok(spent == 1)
}

/// The secret for a user mid-challenge. Never leaves this module's callers.
pub async fn secret_for(db: &PgPool, user_id: Uuid) -> Result<(String, String), ApiError> {
    let row = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT username, two_factor_secret FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;

    let secret = row
        .1
        .ok_or_else(|| ApiError::Internal("two-factor challenge for an account with no secret".to_owned()))?;

    Ok((row.0, secret))
}

pub async fn prune_challenges(db: &PgPool) -> Result<u64, ApiError> {
    let result = sqlx::query("DELETE FROM two_factor_challenges WHERE expires_at < now()")
        .execute(db)
        .await?;

    Ok(result.rows_affected())
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

fn build(secret_base32: &str, username: &str, issuer: &str) -> Result<TOTP, ApiError> {
    let bytes = Secret::Encoded(secret_base32.to_owned())
        .to_bytes()
        .map_err(|error| ApiError::Internal(format!("bad two-factor secret: {error}")))?;

    TOTP::new(
        Algorithm::SHA1,
        DIGITS,
        DRIFT_STEPS,
        STEP_SECONDS,
        bytes,
        Some(issuer.to_owned()),
        username.to_owned(),
    )
    .map_err(|error| ApiError::Internal(format!("could not build a TOTP: {error}")))
}

fn check(secret_base32: &str, username: &str, issuer: &str, code: &str) -> Result<bool, ApiError> {
    let code = code.trim().replace(' ', "");

    // Cheap rejection first: anything that is not six digits cannot be a TOTP,
    // and letting it through would spend a hash on an obvious recovery code.
    if code.len() != DIGITS || !code.chars().all(|c| c.is_ascii_digit()) {
        return Ok(false);
    }

    let totp = build(secret_base32, username, issuer)?;

    totp.check_current(&code)
        .map_err(|error| ApiError::Internal(format!("clock error verifying a code: {error}")))
}

// ---------------------------------------------------------------------------
// Codes and digests
// ---------------------------------------------------------------------------

/// Ten characters, grouped for legibility as `XXXXX-XXXXX`.
fn recovery_code() -> Result<String, ApiError> {
    let alphabet_len = RECOVERY_ALPHABET.len() as u8;
    // Rejection sampling: 256 is not a multiple of 31, so a plain modulo would
    // bias the first few letters. Same reasoning as registration codes.
    let ceiling = u8::MAX - (u8::MAX % alphabet_len);

    let mut out = String::with_capacity(RECOVERY_CODE_LENGTH + 1);
    let mut buffer = [0u8; RECOVERY_CODE_LENGTH * 2];
    let mut taken = 0;

    while taken < RECOVERY_CODE_LENGTH {
        getrandom::fill(&mut buffer)
            .map_err(|error| ApiError::Internal(format!("no system randomness: {error}")))?;

        for byte in buffer {
            if taken == RECOVERY_CODE_LENGTH {
                break;
            }

            if byte < ceiling {
                if taken == RECOVERY_CODE_LENGTH / 2 {
                    out.push('-');
                }

                out.push(RECOVERY_ALPHABET[(byte % alphabet_len) as usize] as char);
                taken += 1;
            }
        }
    }

    Ok(out)
}

fn random_hex() -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| ApiError::Internal(format!("no system randomness: {error}")))?;

    Ok(to_hex(&bytes))
}

/// Recovery codes are stored the way session tokens are: digest only, and
/// compared after the same normalisation the user's typing goes through.
fn digest(value: &str) -> String {
    to_hex(&Sha256::digest(value.as_bytes()))
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

#[cfg(test)]
mod tests {
    use super::*;

    const ISSUER: &str = "Knox Relay";

    fn secret() -> String {
        Secret::generate_secret().to_encoded().to_string()
    }

    /// The URI carries the secret and the labels, and nothing else.
    ///
    /// `digits`, `period` and `algorithm` are absent on purpose: totp-rs omits
    /// each one when it matches the otpauth default, which ours all do. An app
    /// reading this URI therefore falls back to 6 digits over 30 seconds on
    /// SHA-1 — the same parameters [`build`] uses. Changing any of them here
    /// would start emitting the matching parameter, so this test is what keeps
    /// the two definitions from drifting silently.
    #[test]
    fn a_generated_secret_builds_a_scannable_uri() {
        let base32 = secret();
        let totp = build(&base32, "rook", ISSUER).expect("totp");
        let uri = totp.get_url();

        assert!(uri.starts_with("otpauth://totp/"), "got {uri}");
        assert!(uri.contains("Knox%20Relay:rook"), "got {uri}");
        assert!(uri.contains(&format!("secret={base32}")), "got {uri}");
        assert!(uri.contains("issuer=Knox%20Relay"), "got {uri}");

        assert!(
            !uri.contains("digits=") && !uri.contains("period=") && !uri.contains("algorithm="),
            "defaults must stay implicit, or DIGITS/STEP_SECONDS have drifted: {uri}",
        );
    }

    #[test]
    fn the_current_code_verifies_and_a_wrong_one_does_not() {
        let base32 = secret();
        let totp = build(&base32, "rook", ISSUER).expect("totp");
        let now = totp.generate_current().expect("code");

        assert!(check(&base32, "rook", ISSUER, &now).expect("check"));
        assert!(!check(&base32, "rook", ISSUER, "000000").expect("check") || now == "000000");
    }

    /// People paste codes with a space in the middle from some apps.
    #[test]
    fn a_code_with_a_space_still_verifies() {
        let base32 = secret();
        let totp = build(&base32, "rook", ISSUER).expect("totp");
        let now = totp.generate_current().expect("code");
        let spaced = format!("{} {}", &now[..3], &now[3..]);

        assert!(check(&base32, "rook", ISSUER, &spaced).expect("check"));
    }

    /// A recovery code must not be run through the TOTP verifier — it is not
    /// six digits, and treating it as one would be a wasted round trip.
    #[test]
    fn anything_that_is_not_six_digits_is_rejected_before_verifying() {
        let base32 = secret();

        assert!(!check(&base32, "rook", ISSUER, "ABCDE-FGHJK").expect("check"));
        assert!(!check(&base32, "rook", ISSUER, "12345").expect("check"));
        assert!(!check(&base32, "rook", ISSUER, "1234567").expect("check"));
        assert!(!check(&base32, "rook", ISSUER, "").expect("check"));
    }

    #[test]
    fn a_secret_belongs_to_one_account() {
        let base32 = secret();
        let totp = build(&base32, "rook", ISSUER).expect("totp");
        let now = totp.generate_current().expect("code");

        // The label differs but the secret is what signs the code, so this
        // still verifies — the assertion documents that the label is cosmetic
        // and must never be relied on for isolation.
        assert!(check(&base32, "someone_else", ISSUER, &now).expect("check"));
    }

    #[test]
    fn recovery_codes_are_the_right_shape_and_unambiguous() {
        for _ in 0..50 {
            let code = recovery_code().expect("code");

            assert_eq!(code.len(), RECOVERY_CODE_LENGTH + 1, "ten chars plus a dash");
            assert_eq!(code.chars().filter(|c| *c == '-').count(), 1);
            assert!(
                !code.contains(['I', 'L', 'O', '0', '1']),
                "{code} contains a character that gets misread",
            );
        }
    }

    #[test]
    fn recovery_codes_differ_between_calls() {
        assert_ne!(
            recovery_code().expect("code"),
            recovery_code().expect("code")
        );
    }

    /// The stored digest has to match what a user types back, including the
    /// dash they will copy along with it and any stray case.
    #[test]
    fn a_recovery_code_normalises_to_the_same_digest_however_it_is_typed() {
        let code = "ABCDE-FGHJK";
        let expected = digest(&code.replace('-', ""));

        for typed in ["abcde-fghjk", "ABCDE FGHJK", " ABCDEFGHJK ", "AbCdE-fGhJk"] {
            let normalised = typed.trim().to_uppercase().replace(['-', ' '], "");

            assert_eq!(digest(&normalised), expected, "{typed} should match");
        }
    }

    #[test]
    fn digests_are_stable_and_not_the_code() {
        let code = recovery_code().expect("code");

        assert_eq!(digest(&code), digest(&code));
        assert_ne!(digest(&code), code);
        assert_eq!(digest(&code).len(), 64);
    }

    #[test]
    fn challenge_tokens_are_full_length_and_unique() {
        let first = random_hex().expect("token");
        let second = random_hex().expect("token");

        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
    }
}
