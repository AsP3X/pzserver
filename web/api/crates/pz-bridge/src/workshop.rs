//! Public Steam Workshop lookup — no API key.
//!
//! PZ modders put `Mod ID:` and `Map Folder:` lines in the Workshop
//! description. That is how a Workshop file id becomes the `Mods=` token.
//! Required items are Steam `children` on the published file, walked
//! recursively so a dependency of a dependency is not missed.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::Serialize;

const ENDPOINT: &str =
    "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const WORKSHOP_PAGE: &str = "https://steamcommunity.com/sharedfiles/filedetails/?id=";

/// Steam `k_EWorkshopFileTypeCollection`. Collections are bags of files, not
/// a `Mods=` token, so they are walked but never added to the load list.
const COLLECTION_FILE_TYPE: u64 = 2;

const MAX_WALK: usize = 40;
const LOOKUP_BATCH: usize = 20;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WorkshopDetails {
    pub workshop_id: String,
    pub found: bool,
    pub title: String,
    pub preview_url: Option<String>,
    pub mod_ids: Vec<String>,
    pub map_folders: Vec<String>,
    #[serde(default)]
    pub required_workshop_ids: Vec<String>,
    #[serde(skip)]
    pub collection: bool,
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
    Ok(lookup_many(&[workshop_id.to_owned()])
        .await?
        .into_iter()
        .next()
        .unwrap_or_else(|| not_found(workshop_id)))
}

pub async fn lookup_many(ids: &[String]) -> Result<Vec<WorkshopDetails>, reqwest::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()?;

    let mut body = format!("itemcount={}", ids.len());
    for (index, id) in ids.iter().enumerate() {
        body.push_str(&format!("&publishedfileids[{index}]={id}"));
    }

    let response = client
        .post(ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok(ids.iter().map(|id| not_found(id)).collect());
    }

    let payload: serde_json::Value = response.json().await?;
    let files = payload["response"]["publishedfiledetails"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let mut by_id: BTreeMap<String, WorkshopDetails> = BTreeMap::new();
    for file in &files {
        let id = json_id(&file["publishedfileid"]).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        by_id.insert(id.clone(), parse_published_file(&id, file));
    }

    let mut items: Vec<WorkshopDetails> = ids
        .iter()
        .map(|id| by_id.remove(id).unwrap_or_else(|| not_found(id)))
        .collect();

    // GetPublishedFileDetails often omits `children` even when the Workshop
    // page has a Required items sidebar. Knox Buildworks is one of those.
    for item in &mut items {
        if !item.found || !item.required_workshop_ids.is_empty() {
            continue;
        }
        if let Ok(required) = scrape_required_items(&client, &item.workshop_id).await
            && !required.is_empty()
        {
            item.required_workshop_ids = required;
        }
    }

    Ok(items)
}

/// Required items that are not already on the load list, deepest first so
/// they can be appended before the mod that needs them.
pub async fn missing_dependencies(
    root_id: &str,
    loaded: &BTreeSet<String>,
) -> Result<Vec<WorkshopDetails>, reqwest::Error> {
    let details = walk_details(root_id).await?;
    Ok(missing_from_graph(root_id, loaded, &details))
}

async fn walk_details(root_id: &str) -> Result<BTreeMap<String, WorkshopDetails>, reqwest::Error> {
    let mut details = BTreeMap::new();
    let mut pending = VecDeque::new();
    let mut seen = BTreeSet::new();
    pending.push_back(root_id.to_owned());
    seen.insert(root_id.to_owned());

    while !pending.is_empty() && details.len() < MAX_WALK {
        let take = LOOKUP_BATCH
            .min(pending.len())
            .min(MAX_WALK.saturating_sub(details.len()));
        let batch: Vec<String> = pending.drain(..take).collect();
        for item in lookup_many(&batch).await? {
            for child in &item.required_workshop_ids {
                if seen.insert(child.clone()) {
                    pending.push_back(child.clone());
                }
            }
            details.insert(item.workshop_id.clone(), item);
        }
    }

    Ok(details)
}

/// Post-order walk: children, then the node. The root is never returned —
/// the caller is already adding it. Collections are walked, not installed.
pub fn missing_from_graph(
    root: &str,
    loaded: &BTreeSet<String>,
    details: &BTreeMap<String, WorkshopDetails>,
) -> Vec<WorkshopDetails> {
    let mut visited = BTreeSet::new();
    let mut out = Vec::new();
    visit(root, root, loaded, details, &mut visited, &mut out);
    out
}

fn visit(
    id: &str,
    root: &str,
    loaded: &BTreeSet<String>,
    details: &BTreeMap<String, WorkshopDetails>,
    visited: &mut BTreeSet<String>,
    out: &mut Vec<WorkshopDetails>,
) {
    if !visited.insert(id.to_owned()) {
        return;
    }
    let Some(item) = details.get(id) else {
        return;
    };
    for child in &item.required_workshop_ids {
        visit(child, root, loaded, details, visited, out);
    }
    if id == root || loaded.contains(id) || item.collection || !item.found {
        return;
    }
    out.push(item.clone());
}

fn parse_published_file(workshop_id: &str, file: &serde_json::Value) -> WorkshopDetails {
    if file["result"].as_i64() != Some(1) {
        return not_found(workshop_id);
    }

    let description = file["description"].as_str().unwrap_or("");
    let file_type = file["file_type"].as_u64().unwrap_or(0);

    WorkshopDetails {
        workshop_id: workshop_id.to_owned(),
        found: true,
        title: file["title"].as_str().unwrap_or("").to_owned(),
        preview_url: file["preview_url"]
            .as_str()
            .filter(|url| !url.is_empty())
            .map(str::to_owned),
        mod_ids: extract_labels(description, "Mod ID"),
        map_folders: extract_labels(description, "Map Folder"),
        required_workshop_ids: extract_children(file),
        collection: file_type == COLLECTION_FILE_TYPE,
    }
}

async fn scrape_required_items(
    client: &reqwest::Client,
    workshop_id: &str,
) -> Result<Vec<String>, reqwest::Error> {
    let url = format!("{WORKSHOP_PAGE}{workshop_id}");
    let response = client
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (compatible; knox-panel/1.0; +https://github.com)",
        )
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok(Vec::new());
    }

    let html = response.text().await?;
    Ok(extract_required_from_html(&html))
}

/// Steam's public file-details JSON often has no `children`. The Workshop
/// page still lists them under `#RequiredItems`.
pub fn extract_required_from_html(html: &str) -> Vec<String> {
    let start = html
        .find("id=\"RequiredItems\"")
        .or_else(|| html.find("requiredItemsContainer"));
    let Some(start) = start else {
        return Vec::new();
    };

    let rest = &html[start..];
    let rest = &rest[..rest.len().min(12_000)];
    let window = rest.split("creatorsBlock").next().unwrap_or(rest);

    let mut ids = Vec::new();
    for piece in window.split("filedetails/?id=") {
        let id: String = piece.chars().take_while(|ch| ch.is_ascii_digit()).collect();
        if is_workshop_id(&id) && !ids.iter().any(|existing| existing == &id) {
            ids.push(id);
        }
    }
    ids
}

fn extract_children(file: &serde_json::Value) -> Vec<String> {
    let Some(children) = file["children"].as_array() else {
        return Vec::new();
    };

    let mut ids = Vec::new();
    for child in children {
        let Some(id) = json_id(&child["publishedfileid"]) else {
            continue;
        };
        if !ids.iter().any(|existing| existing == &id) {
            ids.push(id);
        }
    }
    ids
}

fn json_id(value: &serde_json::Value) -> Option<String> {
    if let Some(id) = value.as_str() {
        return is_workshop_id(id).then(|| id.to_owned());
    }
    value
        .as_u64()
        .map(|id| id.to_string())
        .filter(|id| is_workshop_id(id))
}

fn not_found(workshop_id: &str) -> WorkshopDetails {
    WorkshopDetails {
        workshop_id: workshop_id.to_owned(),
        found: false,
        title: String::new(),
        preview_url: None,
        mod_ids: Vec::new(),
        map_folders: Vec::new(),
        required_workshop_ids: Vec::new(),
        collection: false,
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
    use std::collections::{BTreeMap, BTreeSet};

    use super::*;

    #[test]
    fn accepts_a_plain_id() {
        assert_eq!(
            parse_workshop_id("3777446787").as_deref(),
            Some("3777446787")
        );
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
        let text =
            "Workshop ID: 1\nMod ID: KnoxRelay\nMod ID: KnoxRelayExtra\nMap Folder: RavenCreek";
        assert_eq!(
            extract_labels(text, "Mod ID"),
            vec!["KnoxRelay", "KnoxRelayExtra"]
        );
        assert_eq!(extract_labels(text, "Map Folder"), vec!["RavenCreek"]);
    }

    fn item(id: &str, required: &[&str]) -> WorkshopDetails {
        WorkshopDetails {
            workshop_id: id.to_owned(),
            found: true,
            title: id.to_owned(),
            preview_url: None,
            mod_ids: vec![format!("Mod{id}")],
            map_folders: Vec::new(),
            required_workshop_ids: required.iter().map(|value| (*value).to_owned()).collect(),
            collection: false,
        }
    }

    fn collection(id: &str, required: &[&str]) -> WorkshopDetails {
        let mut details = item(id, required);
        details.collection = true;
        details.mod_ids.clear();
        details
    }

    #[test]
    fn reads_required_items_from_children_as_strings_or_numbers() {
        let file = serde_json::json!({
            "result": 1,
            "publishedfileid": "10",
            "title": "Parent",
            "description": "Mod ID: ParentMod",
            "file_type": 0,
            "children": [
                {"publishedfileid": "20", "file_type": 0},
                {"publishedfileid": 30, "file_type": 0},
                {"publishedfileid": "20", "file_type": 0}
            ]
        });

        let parsed = parse_published_file("10", &file);
        assert_eq!(parsed.required_workshop_ids, vec!["20", "30"]);
        assert_eq!(parsed.mod_ids, vec!["ParentMod"]);
        assert!(!parsed.collection);
    }

    #[test]
    fn missing_dependencies_are_deepest_first_and_skip_the_root() {
        let mut details = BTreeMap::new();
        details.insert("A".to_owned(), item("A", &["B"]));
        details.insert("B".to_owned(), item("B", &["C"]));
        details.insert("C".to_owned(), item("C", &[]));

        let missing = missing_from_graph("A", &BTreeSet::new(), &details);
        assert_eq!(
            missing
                .iter()
                .map(|entry| entry.workshop_id.as_str())
                .collect::<Vec<_>>(),
            vec!["C", "B"]
        );
    }

    #[test]
    fn already_loaded_items_are_not_offered_but_their_missing_children_are() {
        let mut details = BTreeMap::new();
        details.insert("A".to_owned(), item("A", &["B"]));
        details.insert("B".to_owned(), item("B", &["C"]));
        details.insert("C".to_owned(), item("C", &[]));
        let loaded = BTreeSet::from(["B".to_owned()]);

        let missing = missing_from_graph("A", &loaded, &details);
        assert_eq!(
            missing
                .iter()
                .map(|entry| entry.workshop_id.as_str())
                .collect::<Vec<_>>(),
            vec!["C"]
        );
    }

    #[test]
    fn cycles_do_not_loop() {
        let mut details = BTreeMap::new();
        details.insert("A".to_owned(), item("A", &["B"]));
        details.insert("B".to_owned(), item("B", &["A"]));

        let missing = missing_from_graph("A", &BTreeSet::new(), &details);
        assert_eq!(
            missing
                .iter()
                .map(|entry| entry.workshop_id.as_str())
                .collect::<Vec<_>>(),
            vec!["B"]
        );
    }

    #[test]
    fn collections_are_walked_but_not_installed() {
        let mut details = BTreeMap::new();
        details.insert("A".to_owned(), item("A", &["Pack"]));
        details.insert("Pack".to_owned(), collection("Pack", &["B", "C"]));
        details.insert("B".to_owned(), item("B", &[]));
        details.insert("C".to_owned(), item("C", &[]));

        let missing = missing_from_graph("A", &BTreeSet::new(), &details);
        assert_eq!(
            missing
                .iter()
                .map(|entry| entry.workshop_id.as_str())
                .collect::<Vec<_>>(),
            vec!["B", "C"]
        );
    }

    #[test]
    fn unpublished_children_are_skipped() {
        let mut details = BTreeMap::new();
        details.insert("A".to_owned(), item("A", &["gone"]));
        details.insert("gone".to_owned(), not_found("gone"));

        let missing = missing_from_graph("A", &BTreeSet::new(), &details);
        assert!(missing.is_empty());
    }

    #[test]
    fn json_without_children_is_not_enough_for_knox_buildworks() {
        let file = serde_json::json!({
            "result": 1,
            "publishedfileid": "3772269882",
            "title": "[B42] Knox Buildworks",
            "description": "[b]Requires ElyonLib[/b]\nWorkshop ID: 3772269882\nMod ID: KnoxBuildworks",
            "file_type": 0
        });

        let parsed = parse_published_file("3772269882", &file);
        assert!(
            parsed.required_workshop_ids.is_empty(),
            "Steam's file-details JSON has no children for this item"
        );
    }

    #[test]
    fn reads_required_items_from_the_workshop_sidebar() {
        // Trimmed from the live Knox Buildworks page: Required items lists
        // Elyon Lib, while the JSON API returned no `children` at all.
        let html = r#"
            <div class="panel">
                <div class="rightSectionTopTitle condensed">Required items</div>
                <div class="requiredItemsContainer" id="RequiredItems">
                    <a href="https://steamcommunity.com/workshop/filedetails/?id=3384377738" target="_blank">
                        <div class="requiredItem">[B41/B42] Elyon Lib</div>
                    </a>
                </div>
            </div>
            <div class="creatorsBlock">
                <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3772269882">self</a>
            </div>
            Workshop ID: 3772269882
        "#;

        assert_eq!(extract_required_from_html(html), vec!["3384377738"]);
    }

    #[test]
    fn required_items_section_absent_is_no_dependencies() {
        let html = r#"<div class="workshopItemDescription">Requires ElyonLib
            Workshop ID: 3772269882
            <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3463116811">docs</a>
            </div>"#;
        assert!(extract_required_from_html(html).is_empty());
    }
}
