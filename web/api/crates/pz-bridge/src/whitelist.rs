//! The dedicated server's whitelist (`ZomboidServer.db`), which is what a
//! player actually types when they join the game.
//!
//! The website used to accept those same credentials (Laravel's
//! `PzAccountAuthenticator`). The Rust login must do the same: a survivor who
//! can get into the server should be able to get into the site, even if they
//! never finished `/account register`.

use std::path::Path;

use md5::{Digest, Md5};
use rusqlite::{Connection, OpenFlags};

/// A row from the game's `whitelist` table that we have already checked a
/// password against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhitelistAccount {
    pub username: String,
    pub steam_id: Option<String>,
}

/// Look the name up in the game DB and verify the password the way PZ does.
///
/// Returns `None` when the file is missing, locked, the name is unknown, or
/// the password is wrong. Those are all "this is not a game login" — the
/// caller must not turn a missing SQLite file into a 500.
pub fn authenticate(db_path: &Path, username: &str, password: &str) -> Option<WhitelistAccount> {
    let username = username.trim();
    if username.is_empty() || password.is_empty() {
        return None;
    }

    let (stored_name, stored_password, steam_id) = match read_row(db_path, username) {
        Some(row) => row,
        None => return None,
    };

    if !verify_password(password, &stored_password) {
        return None;
    }

    Some(WhitelistAccount {
        username: stored_name,
        steam_id,
    })
}

/// Paths the game (and the old PHP config) have used for the whitelist file.
pub fn candidate_paths(data_path: &Path, server_name: &str) -> Vec<std::path::PathBuf> {
    let db_dir = data_path.join("db");
    let mut paths = vec![
        db_dir.join(format!("{server_name}.db")),
        db_dir.join("serverPZ.db"),
    ];
    paths.dedup();
    paths
}

/// First existing candidate, if any.
pub fn resolve_db_path(data_path: &Path, server_name: &str) -> Option<std::path::PathBuf> {
    candidate_paths(data_path, server_name)
        .into_iter()
        .find(|path| path.is_file())
}

/// PZ stores `bcrypt(md5(password))`. Accounts written by the old web app may
/// be plain bcrypt of the password, or (rarely) the password in the clear.
pub fn verify_password(password: &str, stored: &str) -> bool {
    if stored.is_empty() {
        return false;
    }

    if stored.starts_with("$2") {
        let md5 = md5_hex(password);
        if bcrypt_matches(&md5, stored) {
            return true;
        }
        return bcrypt_matches(password, stored);
    }

    password == stored
}

/// Every name on the game's whitelist.
///
/// Read-only, like everything else here: rows are added and removed over RCON
/// so the running server sees the change immediately. Writing this file behind
/// its back would leave the in-memory list stale until a restart.
///
/// Returns an empty list when the file is missing or unreadable — a server that
/// has never booted has no whitelist, which is not an error.
pub fn list(db_path: &Path) -> Vec<WhitelistAccount> {
    let Ok(connection) = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };

    let Ok(mut statement) =
        connection.prepare("SELECT username, steamid FROM whitelist ORDER BY lower(username)")
    else {
        return Vec::new();
    };

    let rows = statement.query_map([], |row| {
        Ok(WhitelistAccount {
            username: row.get(0)?,
            steam_id: empty_to_none(row.get(1)?),
        })
    });

    match rows {
        Ok(rows) => rows.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

fn read_row(db_path: &Path, username: &str) -> Option<(String, String, Option<String>)> {
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;

    connection
        .query_row(
            "SELECT username, password, steamid
             FROM whitelist
             WHERE lower(username) = lower(?1)
             LIMIT 1",
            [username],
            |row| {
                let name: String = row.get(0)?;
                let password: Option<String> = row.get(1)?;
                let steam_id: Option<String> = row.get(2)?;
                Ok((name, password.unwrap_or_default(), empty_to_none(steam_id)))
            },
        )
        .ok()
}

fn empty_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

fn md5_hex(input: &str) -> String {
    format!("{:x}", Md5::digest(input.as_bytes()))
}

fn bcrypt_matches(candidate: &str, hash: &str) -> bool {
    bcrypt::verify(candidate, hash).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn pz_scheme_accepts_the_password_and_rejects_a_wrong_one() {
        let digest = md5_hex("correct-horse");
        let hash = bcrypt::hash(digest, 4).expect("hash");

        assert!(verify_password("correct-horse", &hash));
        assert!(!verify_password("Correct-horse", &hash));
        assert!(!verify_password("wrong-password", &hash));
    }

    #[test]
    fn plain_bcrypt_still_verifies_for_web_written_rows() {
        let hash = bcrypt::hash("correct-horse", 4).expect("hash");

        assert!(verify_password("correct-horse", &hash));
        assert!(!verify_password("nope", &hash));
    }

    #[test]
    fn plaintext_rows_compare_exactly() {
        assert!(verify_password("open-sesame", "open-sesame"));
        assert!(!verify_password("open-sesame", "Open-sesame"));
        assert!(!verify_password("anything", ""));
    }

    #[test]
    fn a_missing_file_is_a_miss_not_a_panic() {
        assert!(authenticate(Path::new("/no/such/whitelist.db"), "ASP3X", "secret").is_none());
    }

    #[test]
    fn authenticate_reads_the_whitelist_case_insensitively() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("ZomboidServer.db");
        let connection = Connection::open(&path).expect("open");
        connection
            .execute(
                "CREATE TABLE whitelist (
                    username TEXT,
                    password TEXT,
                    steamid TEXT
                )",
                [],
            )
            .expect("create");

        let digest = md5_hex("survivor-pass");
        let hash = bcrypt::hash(digest, 4).expect("hash");
        connection
            .execute(
                "INSERT INTO whitelist (username, password, steamid) VALUES (?1, ?2, ?3)",
                rusqlite::params!["ASP3X", hash, "76561198000000000"],
            )
            .expect("insert");

        let account = authenticate(&path, "asp3x", "survivor-pass").expect("match");
        assert_eq!(account.username, "ASP3X");
        assert_eq!(account.steam_id.as_deref(), Some("76561198000000000"));
        assert!(authenticate(&path, "ASP3X", "wrong").is_none());
    }

    #[test]
    fn candidates_prefer_the_named_server_file() {
        let paths = candidate_paths(Path::new("/pz-data"), "ZomboidServer");
        assert_eq!(
            paths[0],
            Path::new("/pz-data/db/ZomboidServer.db")
        );
        assert!(paths.iter().any(|p| p.ends_with("serverPZ.db")));
    }
}
