//! Reader for PZ's `server.ini`.
//!
//! The format is flat `key=value` with `#` comments and no sections. Note that
//! PZ uses **semicolons** as list separators (`Mods=`, `WorkshopItems=`,
//! `Map=`), not commas.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct ServerIni {
    values: BTreeMap<String, String>,
}

impl ServerIni {
    /// Read and parse the file, or `None` when it does not exist yet.
    ///
    /// A server that has never booted has no ini, which is a normal state and
    /// not an error.
    pub async fn read(path: impl AsRef<Path>) -> Result<Option<Self>, IniError> {
        let path = path.as_ref();

        match tokio::fs::read_to_string(path).await {
            Ok(contents) => Ok(Some(Self::parse(&contents))),
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(IniError::Read {
                path: path.to_path_buf(),
                source,
            }),
        }
    }

    pub fn parse(contents: &str) -> Self {
        let mut values = BTreeMap::new();

        for line in contents.lines() {
            let line = line.trim();

            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            let Some((key, value)) = line.split_once('=') else {
                continue;
            };

            values.insert(key.trim().to_owned(), value.trim().to_owned());
        }

        Self { values }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    /// A value that is present but empty reads as absent — PZ writes bare
    /// `Key=` for "unset", and callers want `None` rather than `""`.
    pub fn get_non_empty(&self, key: &str) -> Option<&str> {
        self.get(key).filter(|value| !value.is_empty())
    }

    pub fn get_int(&self, key: &str) -> Option<i64> {
        self.get_non_empty(key)?.parse().ok()
    }

    pub fn get_bool(&self, key: &str) -> Option<bool> {
        match self.get_non_empty(key)?.to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        }
    }

    /// Split one of PZ's semicolon-separated list values.
    pub fn get_list(&self, key: &str) -> Vec<String> {
        self.get_non_empty(key)
            .map(|value| {
                value
                    .split(';')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Every key currently in the file, in name order.
    pub fn keys(&self) -> impl Iterator<Item = (&str, &str)> {
        self.values
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }

    /// Rewrite `key=value` lines in `contents`, keeping comments and order.
    ///
    /// Keys that are not already in the file are appended at the end. This is
    /// the only write path: a full rewrite would drop the comments operators
    /// use to remember why a value is set.
    pub fn apply(contents: &str, updates: &BTreeMap<String, String>) -> String {
        let mut remaining = updates.clone();
        let mut lines: Vec<String> = contents
            .lines()
            .map(|line| {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    return line.to_owned();
                }

                let Some((key, _)) = trimmed.split_once('=') else {
                    return line.to_owned();
                };

                let key = key.trim();
                match remaining.remove(key) {
                    Some(value) => format!("{key}={value}"),
                    None => line.to_owned(),
                }
            })
            .collect();

        if !contents.is_empty() && !contents.ends_with('\n') {
            // Keep a trailing newline so the next append is a new line.
        }

        if !remaining.is_empty() {
            if let Some(last) = lines.last() {
                if !last.is_empty() {
                    lines.push(String::new());
                }
            }
            for (key, value) in remaining {
                lines.push(format!("{key}={value}"));
            }
        }

        let mut out = lines.join("\n");
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out
    }

    /// Read, apply `updates`, write back atomically.
    pub async fn write_updates(
        path: impl AsRef<Path>,
        updates: &BTreeMap<String, String>,
    ) -> Result<(), IniError> {
        let path = path.as_ref();
        if updates.is_empty() {
            return Ok(());
        }

        let contents = match tokio::fs::read_to_string(path).await {
            Ok(contents) => contents,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(source) => {
                return Err(IniError::Read {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };

        let next = Self::apply(&contents, updates);
        let tmp = path.with_extension("ini.tmp");

        tokio::fs::write(&tmp, next.as_bytes())
            .await
            .map_err(|source| IniError::Write {
                path: tmp.clone(),
                source,
            })?;

        tokio::fs::rename(&tmp, path)
            .await
            .map_err(|source| IniError::Write {
                path: path.to_path_buf(),
                source,
            })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IniError {
    #[error("server.ini at {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("server.ini at {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# Comment line
PublicName=Knox County
MaxPlayers=16

Map=Muldraugh, KY
Mods=KnoxRelay;Brita
WorkshopItems=3777446787;2822286426
Open=true
PVP=false
Password=
";

    #[test]
    fn reads_plain_values_and_skips_comments() {
        let ini = ServerIni::parse(SAMPLE);

        assert_eq!(ini.get("PublicName"), Some("Knox County"));
        assert_eq!(ini.get("# Comment line"), None);
    }

    #[test]
    fn splits_lists_on_semicolons_not_commas() {
        let ini = ServerIni::parse(SAMPLE);

        assert_eq!(ini.get_list("Mods"), vec!["KnoxRelay", "Brita"]);
        // A map name legitimately contains a comma.
        assert_eq!(ini.get_list("Map"), vec!["Muldraugh, KY"]);
    }

    #[test]
    fn treats_an_empty_value_as_absent() {
        let ini = ServerIni::parse(SAMPLE);

        assert_eq!(ini.get("Password"), Some(""));
        assert_eq!(ini.get_non_empty("Password"), None);
        assert!(!ini.get_list("Mods").is_empty());
        assert!(ini.get_list("Password").is_empty());
    }

    #[test]
    fn parses_typed_values() {
        let ini = ServerIni::parse(SAMPLE);

        assert_eq!(ini.get_int("MaxPlayers"), Some(16));
        assert_eq!(ini.get_bool("Open"), Some(true));
        assert_eq!(ini.get_bool("PVP"), Some(false));
        assert_eq!(ini.get_int("PublicName"), None);
    }

    #[test]
    fn apply_rewrites_existing_keys_and_keeps_comments() {
        let mut updates = BTreeMap::new();
        updates.insert("MaxPlayers".to_owned(), "32".to_owned());

        let next = ServerIni::apply(SAMPLE, &updates);

        assert!(next.contains("# Comment line"));
        assert!(next.contains("MaxPlayers=32"));
        assert!(next.contains("PublicName=Knox County"));
        assert!(next.ends_with('\n'));
    }

    #[test]
    fn apply_appends_keys_that_were_not_in_the_file() {
        let mut updates = BTreeMap::new();
        updates.insert("NightLength".to_owned(), "3".to_owned());

        let next = ServerIni::apply(SAMPLE, &updates);

        assert!(next.contains("NightLength=3"));
    }
}
