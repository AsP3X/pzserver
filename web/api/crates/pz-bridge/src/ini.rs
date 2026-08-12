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
}

#[derive(Debug, thiserror::Error)]
pub enum IniError {
    #[error("server.ini at {path} could not be read: {source}")]
    Read {
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
}
