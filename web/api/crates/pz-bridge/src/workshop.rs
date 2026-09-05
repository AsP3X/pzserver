//! Public Steam Workshop lookup — no API key.
//!
//! PZ modders put `Mod ID:` and `Map Folder:` lines in the Workshop
//! description. That is how a Workshop file id becomes the `Mods=` token.
//! Required items are Steam `children` on the published file, walked
//! recursively so a dependency of a dependency is not missed.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};

use serde::Serialize;

const ENDPOINT: &str =
    "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const WORKSHOP_PAGE: &str = "https://steamcommunity.com/sharedfiles/filedetails/?id=";
/// Project Zomboid's Steam app. Workshop items land under `content/108600/`.
const WORKSHOP_APP_ID: &str = "108600";

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
    /// Unix seconds Steam last published this file. Absent when the lookup
    /// missed, and skipped on the wire when we have nothing to say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_updated: Option<u64>,
    #[serde(skip)]
    pub description: String,
    #[serde(skip)]
    pub collection: bool,
}

/// What SteamCMD last wrote for an item in `appworkshop_108600.acf`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkshopAcf {
    /// `WorkshopItemsInstalled.<id>.timeupdated` — the copy on disk.
    pub installed: BTreeMap<String, u64>,
    /// `WorkshopItemDetails.<id>.latest_timeupdated` — what SteamCMD last
    /// saw on Steam. Falls back to that block's `timeupdated`.
    pub latest: BTreeMap<String, u64>,
}

/// Local Workshop cache for one load-list row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkshopInstall {
    pub version: Option<String>,
    pub time_updated: Option<u64>,
    pub latest_time_updated: Option<u64>,
    pub cached: bool,
    /// The API could see the Workshop tree. Without this, "not on disk" is
    /// indistinguishable from "we did not look".
    pub readable: bool,
}

impl WorkshopInstall {
    /// Steam has a newer publish than the copy on disk, or the item is on
    /// the load list but has not been downloaded yet.
    pub fn update_available(&self, steam_time: Option<u64>) -> bool {
        if let Some(steam) = steam_time
            && let Some(installed) = self.time_updated
        {
            return steam > installed;
        }
        if let (Some(latest), Some(installed)) = (self.latest_time_updated, self.time_updated) {
            if latest > installed {
                return true;
            }
        }
        self.readable && !self.cached
    }
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
    let client = steam_client(std::time::Duration::from_secs(8))?;
    let mut items = fetch_published_files(&client, ids).await?;

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

/// What Steam last published for a Workshop file, without scraping HTML.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkshopRemote {
    pub time_updated: Option<u64>,
    /// Best-effort version parsed from the Workshop description or title.
    pub version: Option<String>,
}

/// Steam `time_updated` (and a version string when the description has one).
/// Used by the mod list so a missing Required-items sidebar cannot stall it.
pub async fn published_meta(
    ids: &[String],
) -> Result<BTreeMap<String, WorkshopRemote>, reqwest::Error> {
    let mut out = BTreeMap::new();
    if ids.is_empty() {
        return Ok(out);
    }

    let client = steam_client(std::time::Duration::from_secs(4))?;
    for chunk in ids.chunks(LOOKUP_BATCH) {
        for item in fetch_published_files(&client, chunk).await? {
            if !item.found {
                continue;
            }
            out.insert(
                item.workshop_id,
                WorkshopRemote {
                    time_updated: item.time_updated,
                    version: parse_modversion(&item.title)
                        .or_else(|| parse_modversion(&item.description)),
                },
            );
        }
    }
    Ok(out)
}

fn steam_client(timeout: std::time::Duration) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder().timeout(timeout).build()
}

async fn fetch_published_files(
    client: &reqwest::Client,
    ids: &[String],
) -> Result<Vec<WorkshopDetails>, reqwest::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

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

    Ok(ids
        .iter()
        .map(|id| by_id.remove(id).unwrap_or_else(|| not_found(id)))
        .collect())
}

/// `appworkshop_108600.acf` next to `content/`. Missing is empty, not an error.
pub fn read_acf(workshop_root: &Path) -> WorkshopAcf {
    let path = workshop_root.join(format!("appworkshop_{WORKSHOP_APP_ID}.acf"));
    let Ok(body) = std::fs::read_to_string(path) else {
        return WorkshopAcf::default();
    };
    parse_workshop_acf(&body)
}

/// Valve KeyValues as SteamCMD writes it for the Workshop cache.
pub fn parse_workshop_acf(body: &str) -> WorkshopAcf {
    #[derive(Clone, Copy)]
    enum Section {
        None,
        Installed,
        Details,
    }

    let mut acf = WorkshopAcf::default();
    let mut section = Section::None;
    let mut current_id = String::new();
    let mut depth: i32 = 0;
    let mut section_depth: i32 = 0;

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed == "{" {
            depth += 1;
            continue;
        }
        if trimmed == "}" {
            if depth > 0 {
                depth -= 1;
            }
            if !current_id.is_empty() && depth == section_depth {
                current_id.clear();
            }
            if !matches!(section, Section::None) && depth < section_depth {
                section = Section::None;
                current_id.clear();
            }
            continue;
        }

        let tokens = quoted_values(trimmed);
        if tokens.len() == 1 {
            match tokens[0] {
                "WorkshopItemsInstalled" => {
                    section = Section::Installed;
                    section_depth = depth + 1;
                }
                "WorkshopItemDetails" => {
                    section = Section::Details;
                    section_depth = depth + 1;
                }
                id if is_workshop_id(id)
                    && matches!(section, Section::Installed | Section::Details)
                    && current_id.is_empty() =>
                {
                    current_id = id.to_owned();
                }
                _ => {}
            }
            continue;
        }

        if tokens.len() >= 2 && !current_id.is_empty() {
            let Ok(value) = tokens[1].parse::<u64>() else {
                continue;
            };
            match (section, tokens[0]) {
                (Section::Installed, "timeupdated") => {
                    acf.installed.insert(current_id.clone(), value);
                }
                (Section::Details, "latest_timeupdated") => {
                    acf.latest.insert(current_id.clone(), value);
                }
                (Section::Details, "timeupdated") => {
                    acf.latest.entry(current_id.clone()).or_insert(value);
                }
                _ => {}
            }
        }
    }

    acf
}

/// `modversion=` and whether the Workshop tree is on disk.
pub fn inspect_install(
    workshop_root: Option<&Path>,
    workshop_id: &str,
    mod_id: &str,
    acf: &WorkshopAcf,
    game_version: Option<&str>,
) -> WorkshopInstall {
    if workshop_id.is_empty() {
        return WorkshopInstall::default();
    }

    let mut install = WorkshopInstall {
        time_updated: acf.installed.get(workshop_id).copied(),
        latest_time_updated: acf.latest.get(workshop_id).copied(),
        ..WorkshopInstall::default()
    };

    let Some(root) = workshop_root else {
        return install;
    };
    install.readable = true;

    let item = root.join("content").join(WORKSHOP_APP_ID).join(workshop_id);
    install.cached = item.join("mods").is_dir();
    install.version = read_modversion(&item, mod_id, game_version);
    install
}

fn read_modversion(item: &Path, mod_id: &str, game_version: Option<&str>) -> Option<String> {
    let game = game_version.and_then(parse_dotted_version);
    for path in ranked_mod_info_paths(item, mod_id, game.as_deref()) {
        let Ok(body) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(version) = parse_modversion(&body) {
            return Some(version);
        }
    }
    read_bridge_version(item, mod_id)
}

/// `KR_Bridge.VERSION` when `mod.info` has no `modversion=`. Knox Relay
/// always has one of the two; other mods typically have neither.
fn read_bridge_version(item: &Path, mod_id: &str) -> Option<String> {
    for dir in resolve_mod_dirs(item, mod_id) {
        for rel in [
            "42/media/lua/server/KR_Bridge.lua",
            "media/lua/server/KR_Bridge.lua",
        ] {
            let path = dir.join(rel);
            let Ok(body) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Some(version) = parse_bridge_version(&body) {
                return Some(version);
            }
        }
    }
    None
}

fn parse_bridge_version(body: &str) -> Option<String> {
    for line in body.lines() {
        let line = line.trim().trim_end_matches('\r');
        let Some(rest) = line.strip_prefix("KR_Bridge.VERSION") else {
            continue;
        };
        let rest = rest.trim().trim_start_matches('=').trim();
        let rest = rest.trim_matches(|ch| ch == '"' || ch == '\'');
        return display_mod_version(rest);
    }
    None
}

fn ranked_mod_info_paths(item: &Path, mod_id: &str, game: Option<&[u32]>) -> Vec<PathBuf> {
    let mut ranked: Vec<(u8, Vec<u32>, PathBuf)> = Vec::new();
    for dir in resolve_mod_dirs(item, mod_id) {
        let root_info = dir.join("mod.info");
        if root_info.is_file() {
            ranked.push((1, Vec::new(), root_info));
        }
        let common_info = dir.join("common").join("mod.info");
        if common_info.is_file() {
            ranked.push((1, Vec::new(), common_info));
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some(folder) = parse_folder_version(name) else {
                continue;
            };
            let info = entry.path().join("mod.info");
            if !info.is_file() {
                continue;
            }
            let too_new =
                game.is_some_and(|game| cmp_version(&folder, game) == std::cmp::Ordering::Greater);
            let rank = if too_new { 2 } else { 0 };
            ranked.push((rank, folder, info));
        }
    }

    ranked.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| cmp_version(&right.1, &left.1))
    });
    ranked.into_iter().map(|(_, _, path)| path).collect()
}

/// Directory for this Mods= token. The folder name often matches, but some
/// Workshop items (Chuckleberry's alert system) ship a different directory
/// and put the load-list id only inside `mod.info`.
///
/// B42 `Mods=` tokens are often `\KnoxRelay`; strip the slash so the folder
/// still matches.
pub fn normalize_mod_id(id: &str) -> &str {
    id.trim().trim_start_matches(['\\', '/'])
}

fn resolve_mod_dirs(item: &Path, mod_id: &str) -> Vec<PathBuf> {
    let mods = item.join("mods");
    if !mods.is_dir() {
        return Vec::new();
    }

    let mod_id = normalize_mod_id(mod_id);
    if !mod_id.is_empty() {
        let exact = mods.join(mod_id);
        if exact.is_dir() {
            return vec![exact];
        }
    }

    let mut declared = Vec::new();
    let mut all = Vec::new();
    let Ok(entries) = std::fs::read_dir(&mods) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        all.push(path.clone());
        if !mod_id.is_empty() && dir_declares_mod_id(&path, mod_id) {
            declared.push(path);
        }
    }
    if !declared.is_empty() {
        return declared;
    }
    if all.len() == 1 {
        return all;
    }
    all
}

fn dir_declares_mod_id(dir: &Path, mod_id: &str) -> bool {
    for path in immediate_mod_infos(dir) {
        let Ok(body) = std::fs::read_to_string(path) else {
            continue;
        };
        if parse_mod_id(&body).is_some_and(|id| normalize_mod_id(&id).eq_ignore_ascii_case(mod_id))
        {
            return true;
        }
    }
    false
}

fn immediate_mod_infos(dir: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let root = dir.join("mod.info");
    if root.is_file() {
        paths.push(root);
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return paths;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let info = entry.path().join("mod.info");
        if info.is_file() {
            paths.push(info);
        }
    }
    paths
}

fn parse_mod_id(body: &str) -> Option<String> {
    for line in body.lines() {
        let line = line.trim().trim_end_matches('\r');
        let Some(rest) = line.strip_prefix("id=") else {
            continue;
        };
        let id = rest.trim();
        if !id.is_empty() {
            return Some(id.to_owned());
        }
    }
    None
}

/// `42`, `42.19`, or a range like `42.0-42.12` (upper bound).
pub fn parse_folder_version(name: &str) -> Option<Vec<u32>> {
    let name = name.trim();
    if let Some((left, right)) = name.split_once('-')
        && looks_like_version(left)
        && looks_like_version(right)
    {
        return parse_dotted_version(right);
    }
    parse_dotted_version(name).filter(|_| looks_like_version(name))
}

fn looks_like_version(value: &str) -> bool {
    let mut saw_digit = false;
    for ch in value.chars() {
        if ch.is_ascii_digit() {
            saw_digit = true;
            continue;
        }
        if ch != '.' {
            return false;
        }
    }
    saw_digit
}

pub fn parse_dotted_version(value: &str) -> Option<Vec<u32>> {
    let trimmed = value.trim().trim_start_matches('v').trim_start_matches('V');
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for piece in trimmed.split('.') {
        if piece.is_empty() {
            return None;
        }
        parts.push(piece.parse().ok()?);
    }
    if parts.is_empty() { None } else { Some(parts) }
}

fn cmp_version(left: &[u32], right: &[u32]) -> std::cmp::Ordering {
    let n = left.len().max(right.len());
    for index in 0..n {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        match a.cmp(&b) {
            std::cmp::Ordering::Equal => {}
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// `modversion=` first, then a `version=` that is not `versionMin`, then a
/// `Version:` line of the kind Workshop descriptions use.
///
/// Calendar dates (`2024-08-15`, `2024.08.15`) are not versions — the load
/// list must not show Steam's install day in the Version column.
pub fn parse_modversion(body: &str) -> Option<String> {
    let mut fallback = None;
    for line in body.lines() {
        let line = line.trim().trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("modversion=") {
            if let Some(version) = plausible_mod_version(rest) {
                return Some(version);
            }
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("version=") && !lower.starts_with("versionmin=") {
            if fallback.is_none() {
                fallback = plausible_mod_version(line[8..].trim());
            }
        }
    }
    fallback
        .or_else(|| {
            extract_labels(body, "Version")
                .into_iter()
                .chain(extract_labels(body, "Mod Version"))
                .find_map(|token| plausible_mod_version(&token))
        })
        .or_else(|| trailing_version(body).and_then(|value| plausible_mod_version(&value)))
}

/// A version the Mods Version column may show. Calendar dates (`2024-08-15`)
/// are `None` — Steam's install day is not a mod version.
pub fn display_mod_version(value: &str) -> Option<String> {
    plausible_mod_version(value)
}

fn plausible_mod_version(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || looks_like_calendar_date(trimmed) {
        return None;
    }
    if !trimmed.chars().any(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(trimmed.to_owned())
}

fn looks_like_calendar_date(value: &str) -> bool {
    let pieces: Vec<&str> = value.split(['-', '/', '.']).collect();
    if pieces.len() != 3 {
        return false;
    }
    let Ok(first) = pieces[0].parse::<u32>() else {
        return false;
    };
    let Ok(second) = pieces[1].parse::<u32>() else {
        return false;
    };
    let Ok(third) = pieces[2].parse::<u32>() else {
        return false;
    };
    let year = |n: u32| (1970..=2100).contains(&n);
    let month = |n: u32| (1..=12).contains(&n);
    let day = |n: u32| (1..=31).contains(&n);
    (year(first) && month(second) && day(third)) || (day(first) && month(second) && year(third))
}

/// Last token of a one-line title like `Neat Crafting 1.6.20`. Needs at least
/// two numeric parts so a lone `42` in a sentence is not a mod version.
fn trailing_version(body: &str) -> Option<String> {
    if body.contains('\n') {
        return None;
    }
    let last = body.split_whitespace().last()?;
    let trimmed = last.trim_start_matches(['v', 'V']);
    let parts = parse_dotted_version(trimmed)?;
    (parts.len() >= 2).then(|| trimmed.to_owned())
}

fn quoted_values(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find('"') {
        rest = &rest[start + 1..];
        match rest.find('"') {
            Some(end) => {
                out.push(&rest[..end]);
                rest = &rest[end + 1..];
            }
            None => break,
        }
    }
    out
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
        time_updated: json_u64(&file["time_updated"]),
        description: description.to_owned(),
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

fn json_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))
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
        time_updated: None,
        description: String::new(),
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
            time_updated: None,
            description: String::new(),
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
            "time_updated": 1700000000,
            "children": [
                {"publishedfileid": "20", "file_type": 0},
                {"publishedfileid": 30, "file_type": 0},
                {"publishedfileid": "20", "file_type": 0}
            ]
        });

        let parsed = parse_published_file("10", &file);
        assert_eq!(parsed.required_workshop_ids, vec!["20", "30"]);
        assert_eq!(parsed.mod_ids, vec!["ParentMod"]);
        assert_eq!(parsed.time_updated, Some(1_700_000_000));
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

    #[test]
    fn time_updated_accepts_a_string() {
        let file = serde_json::json!({
            "result": 1,
            "publishedfileid": "10",
            "title": "Parent",
            "description": "",
            "file_type": 0,
            "time_updated": "1700000001"
        });
        assert_eq!(
            parse_published_file("10", &file).time_updated,
            Some(1_700_000_001)
        );
    }

    #[test]
    fn reads_modversion_from_the_first_line_that_has_it() {
        assert_eq!(
            parse_modversion("name=Knox Relay\r\nmodversion=1.24\r\nid=KnoxRelay\n"),
            Some("1.24".to_owned())
        );
        assert_eq!(parse_modversion("name=Elyon Lib\nid=ElyonLib\n"), None);
        assert_eq!(parse_modversion("modversion=   \n"), None);
    }

    #[test]
    fn acf_parser_reads_installed_and_latest_times() {
        let body = r#"
"AppWorkshop"
{
	"appid"		"108600"
	"WorkshopItemsInstalled"
	{
		"3777446787"
		{
			"size"		"389550"
			"timeupdated"		"1787076841"
			"manifest"		"7792658284163926684"
		}
		"3384377738"
		{
			"size"		"1"
			"timeupdated"		"100"
			"manifest"		"1"
		}
	}
	"WorkshopItemDetails"
	{
		"3777446787"
		{
			"manifest"		"7792658284163926684"
			"timeupdated"		"1787076841"
			"latest_timeupdated"		"1787076841"
			"latest_manifest"		"7792658284163926684"
		}
		"3384377738"
		{
			"manifest"		"1"
			"timeupdated"		"100"
			"latest_timeupdated"		"200"
			"latest_manifest"		"2"
		}
	}
}
"#;
        let acf = parse_workshop_acf(body);
        assert_eq!(acf.installed.get("3777446787"), Some(&1_787_076_841));
        assert_eq!(acf.latest.get("3777446787"), Some(&1_787_076_841));
        assert_eq!(acf.installed.get("3384377738"), Some(&100));
        assert_eq!(acf.latest.get("3384377738"), Some(&200));
    }

    #[test]
    fn update_available_is_steam_newer_than_the_cached_copy() {
        let cached = WorkshopInstall {
            version: Some("1.23".into()),
            time_updated: Some(100),
            latest_time_updated: Some(100),
            cached: true,
            readable: true,
        };
        assert!(!cached.update_available(Some(100)));
        assert!(cached.update_available(Some(101)));
        assert!(!cached.update_available(None));

        let stale_acf = WorkshopInstall {
            time_updated: Some(100),
            latest_time_updated: Some(200),
            cached: true,
            readable: true,
            ..WorkshopInstall::default()
        };
        assert!(stale_acf.update_available(None));

        let missing = WorkshopInstall {
            cached: false,
            readable: true,
            ..WorkshopInstall::default()
        };
        assert!(missing.update_available(None));
        assert!(missing.update_available(Some(1)));

        let unseen = WorkshopInstall::default();
        assert!(!unseen.update_available(None));
        assert!(!unseen.update_available(Some(1)));
    }

    #[test]
    fn inspect_install_reads_modversion_from_the_b42_manifest() {
        let root = tempfile::tempdir().expect("scratch workshop root");
        let mod_dir = root
            .path()
            .join("content")
            .join("108600")
            .join("3777446787")
            .join("mods")
            .join("KnoxRelay")
            .join("42");
        std::fs::create_dir_all(&mod_dir).expect("mod dir");
        std::fs::write(
            mod_dir.join("mod.info"),
            "name=Knox Relay\nid=KnoxRelay\nmodversion=1.24\n",
        )
        .expect("mod.info");

        let mut acf = WorkshopAcf::default();
        acf.installed.insert("3777446787".into(), 100);

        let install = inspect_install(
            Some(root.path()),
            "3777446787",
            "KnoxRelay",
            &acf,
            Some("42.20.0"),
        );
        assert!(install.cached);
        assert!(install.readable);
        assert_eq!(install.version.as_deref(), Some("1.24"));
        assert_eq!(install.time_updated, Some(100));
        assert!(!install.update_available(Some(100)));
        assert!(install.update_available(Some(101)));
    }

    #[test]
    fn inspect_install_prefers_the_folder_that_matches_the_game() {
        let root = tempfile::tempdir().expect("scratch workshop root");
        let mod_dir = root
            .path()
            .join("content")
            .join("108600")
            .join("3437629766")
            .join("mods")
            .join("CleanUI");
        std::fs::create_dir_all(mod_dir.join("42.15")).expect("42.15");
        std::fs::create_dir_all(mod_dir.join("42.19")).expect("42.19");
        std::fs::write(
            mod_dir.join("42.15").join("mod.info"),
            "id=CleanUI\nmodversion=2.6.0\n",
        )
        .expect("old");
        std::fs::write(
            mod_dir.join("42.19").join("mod.info"),
            "id=CleanUI\nmodversion=2.7.6\n",
        )
        .expect("new");

        let install = inspect_install(
            Some(root.path()),
            "3437629766",
            "CleanUI",
            &WorkshopAcf::default(),
            Some("42.20.0"),
        );
        assert_eq!(install.version.as_deref(), Some("2.7.6"));
    }

    #[test]
    fn inspect_install_finds_a_mod_whose_folder_is_not_the_load_id() {
        let root = tempfile::tempdir().expect("scratch workshop root");
        let mod_dir = root
            .path()
            .join("content")
            .join("108600")
            .join("3077900375")
            .join("mods")
            .join("chuckleberryModdingAlertSystem")
            .join("42.0");
        std::fs::create_dir_all(&mod_dir).expect("mod dir");
        std::fs::write(
            mod_dir.join("mod.info"),
            "id=ChuckleberryFinnAlertSystem\nname=Alert\nmodversion=1.3\n",
        )
        .expect("mod.info");

        let install = inspect_install(
            Some(root.path()),
            "3077900375",
            "ChuckleberryFinnAlertSystem",
            &WorkshopAcf::default(),
            Some("42.20.0"),
        );
        assert!(install.cached);
        assert_eq!(install.version.as_deref(), Some("1.3"));
    }

    #[test]
    fn folder_versions_read_ranges_and_skip_names() {
        assert_eq!(
            parse_folder_version("42.19").as_deref(),
            Some(&[42, 19][..])
        );
        assert_eq!(
            parse_folder_version("42.0-42.12").as_deref(),
            Some(&[42, 12][..])
        );
        assert_eq!(parse_folder_version("42").as_deref(), Some(&[42][..]));
        assert_eq!(parse_folder_version("common"), None);
        assert_eq!(parse_folder_version("media"), None);
    }

    #[test]
    fn parse_modversion_reads_workshop_description_lines() {
        assert_eq!(
            parse_modversion("A UI overhaul.\nVersion: 1.6.20\nMod ID: Neat_Crafting\n"),
            Some("1.6.20".to_owned())
        );
        assert_eq!(parse_modversion("versionMin=42.15\n"), None);
        assert_eq!(
            parse_modversion("Neat Crafting 1.6.20"),
            Some("1.6.20".to_owned())
        );
    }

    #[test]
    fn parse_modversion_rejects_calendar_dates() {
        assert_eq!(parse_modversion("Version: 2024-08-15"), None);
        assert_eq!(parse_modversion("Version: 2024.08.15"), None);
        assert_eq!(parse_modversion("modversion=15.08.2024"), None);
        assert_eq!(parse_modversion("Updated HUD 2024.08.15"), None);
        assert_eq!(parse_modversion("modversion=1.35"), Some("1.35".to_owned()));
        assert_eq!(
            parse_modversion("modversion=v2.7.6"),
            Some("v2.7.6".to_owned())
        );
        assert_eq!(
            parse_modversion("modversion=1.3.14.0-B42UNSTABLE"),
            Some("1.3.14.0-B42UNSTABLE".to_owned())
        );
        assert_eq!(
            parse_modversion("modversion=42-1.4.3"),
            Some("42-1.4.3".to_owned())
        );
        assert_eq!(display_mod_version("1.35"), Some("1.35".to_owned()));
        assert_eq!(display_mod_version("2024-08-15"), None);
        assert_eq!(
            parse_bridge_version("KR_Bridge.VERSION = \"1.35\"\n"),
            Some("1.35".to_owned())
        );
    }

    #[test]
    fn inspect_install_reads_knox_version_from_the_lua_bridge_when_modinfo_omits_it() {
        let root = tempfile::tempdir().expect("scratch workshop root");
        let mod_dir = root
            .path()
            .join("content")
            .join("108600")
            .join("3777446787")
            .join("mods")
            .join("KnoxRelay");
        let lua = mod_dir.join("42/media/lua/server");
        std::fs::create_dir_all(&lua).expect("lua dir");
        std::fs::write(
            mod_dir.join("42/mod.info"),
            "name=Knox Relay\nid=KnoxRelay\n",
        )
        .expect("mod.info without modversion");
        std::fs::write(
            lua.join("KR_Bridge.lua"),
            "KR_Bridge = {}\nKR_Bridge.VERSION = \"1.35\"\n",
        )
        .expect("bridge");

        let install = inspect_install(
            Some(root.path()),
            "3777446787",
            "KnoxRelay",
            &WorkshopAcf::default(),
            Some("42.20.0"),
        );
        assert_eq!(install.version.as_deref(), Some("1.35"));
    }

    #[test]
    fn live_cache_reads_versioned_b42_folders() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../data/server/steamapps/workshop");
        if !root.join("content/108600/3437629766").is_dir() {
            return;
        }
        let acf = WorkshopAcf::default();
        let clean = inspect_install(Some(&root), "3437629766", "CleanUI", &acf, Some("42.20.0"));
        assert_eq!(
            clean.version.as_deref(),
            Some("2.7.6"),
            "CleanUI ships modversion in 42.19/, not 42/"
        );
        let bags = inspect_install(
            Some(&root),
            "2996978365",
            "LazoloDynamicBackpackUpgrades",
            &acf,
            Some("42.20.0"),
        );
        assert_eq!(bags.version.as_deref(), Some("1.0.2"));
        let alert = inspect_install(
            Some(&root),
            "3077900375",
            "ChuckleberryFinnAlertSystem",
            &acf,
            Some("42.20.0"),
        );
        assert!(
            alert.cached,
            "folder is chuckleberryModdingAlertSystem, id is ChuckleberryFinnAlertSystem"
        );
    }

    #[test]
    fn live_knox_relay_version_is_1_35() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../data/server/steamapps/workshop");
        let item = root.join("content/108600/3777446787");
        if !item.is_dir() {
            return;
        }
        let install = inspect_install(
            Some(&root),
            "3777446787",
            "KnoxRelay",
            &WorkshopAcf::default(),
            Some("42.20.0"),
        );
        assert_eq!(install.version.as_deref(), Some("1.35"));
        let slashed = inspect_install(
            Some(&root),
            "3777446787",
            "\\KnoxRelay",
            &WorkshopAcf::default(),
            Some("42.20.0"),
        );
        assert_eq!(
            slashed.version.as_deref(),
            Some("1.35"),
            "B42 Mods= tokens are prefixed with a backslash"
        );
    }
}
