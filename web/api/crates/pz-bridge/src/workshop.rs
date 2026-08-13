//! Public Steam Workshop lookup — no API key.
//!
//! PZ modders put `Mod ID:` and `Map Folder:` lines in the Workshop
//! description. That is how a Workshop file id becomes the `Mods=` token.

use serde::Serialize;

const ENDPOINT: &str = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";

#[derive(Debug, Clone, Serialize)]
pub struct WorkshopDetails {
    pub workshop_id: String,
    pub found: bool,
    pub title: String,
    pub preview_url: Option<String>,
    pub mod_ids: Vec<String>,
    pub map_folders: Vec<String>,
}

/// Digits, or a Steam sharedfiles URL that contains `id=`.
pub fn parse_workshop_id(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if is_workshop_id(trimmed) {
        return Some(trimmed.to_owned());
    }

    let after_id = trimmed.split("id=").nth(1)?;
    let candidate = after_id
        .split(|ch: char| !ch.is_ascii_digit())
        .next()
        .unwrap_or("");

    is_workshop_id(candidate).then(|| candidate.to_owned())
}

pub fn is_workshop_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.chars().all(|ch| ch.is_ascii_digit())
}

pub async fn lookup(workshop_id: &str) -> Result<WorkshopDetails, reqwest::Error> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()?;

    let body = format!("itemcount=1&publishedfileids[0]={workshop_id}");
    let response = client
        .post(ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok(not_found(workshop_id));
    }

    let payload: serde_json::Value = response.json().await?;
    let file = &payload["response"]["publishedfiledetails"][0];

    if file["result"].as_i64() != Some(1) {
        return Ok(not_found(workshop_id));
    }

    let description = file["description"].as_str().unwrap_or("");

    Ok(WorkshopDetails {
        workshop_id: workshop_id.to_owned(),
        found: true,
        title: file["title"].as_str().unwrap_or("").to_owned(),
        preview_url: file["preview_url"]
            .as_str()
            .filter(|url| !url.is_empty())
            .map(str::to_owned),
        mod_ids: extract_labels(description, "Mod ID"),
        map_folders: extract_labels(description, "Map Folder"),
    })
}

fn not_found(workshop_id: &str) -> WorkshopDetails {
    WorkshopDetails {
        workshop_id: workshop_id.to_owned(),
        found: false,
        title: String::new(),
        preview_url: None,
        mod_ids: Vec::new(),
        map_folders: Vec::new(),
    }
}

fn extract_labels(description: &str, label: &str) -> Vec<String> {
    let needle = format!("{}:", label.to_ascii_lowercase());
    let mut found = Vec::new();

    for line in description.lines() {
        let lower = line.to_ascii_lowercase();
        let Some(offset) = lower.find(&needle) else {
            continue;
        };
        let rest = line[offset + needle.len()..].trim();
        let token: String = rest
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
            .collect();
        if !token.is_empty() && !found.iter().any(|existing| existing == &token) {
            found.push(token);
        }
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_plain_id() {
        assert_eq!(parse_workshop_id("3777446787").as_deref(), Some("3777446787"));
    }

    #[test]
    fn pulls_the_id_out_of_a_steam_url() {
        assert_eq!(
            parse_workshop_id(
                "https://steamcommunity.com/sharedfiles/filedetails/?id=3777446787&searchtext="
            )
            .as_deref(),
            Some("3777446787")
        );
    }

    #[test]
    fn reads_mod_ids_from_a_description() {
        let text = "Workshop ID: 1\nMod ID: KnoxRelay\nMod ID: KnoxRelayExtra\nMap Folder: RavenCreek";
        assert_eq!(
            extract_labels(text, "Mod ID"),
            vec!["KnoxRelay", "KnoxRelayExtra"]
        );
        assert_eq!(extract_labels(text, "Map Folder"), vec!["RavenCreek"]);
    }
}
