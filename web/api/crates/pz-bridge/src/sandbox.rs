//! Reader for PZ's `SandboxVars.lua`.
//!
//! The file is one Lua table, `SandboxVars = { ... }`, with `#` never used
//! and `--` comments carrying the in-game labels, enums, and min/max. Nested
//! tables (`ZombieLore`, `Map`, …) flatten to dotted keys so the panel can
//! treat them like the rest of the settings.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxKind {
    Boolean,
    Number,
    String,
    Enum,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SandboxOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SandboxField {
    pub key: String,
    pub value: String,
    pub kind: SandboxKind,
    pub help: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub options: Vec<SandboxOption>,
    pub group: &'static str,
    pub read_only: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SandboxVars {
    fields: Vec<SandboxField>,
    values: BTreeMap<String, String>,
}

impl SandboxVars {
    pub fn parse(contents: &str) -> Self {
        let mut fields = Vec::new();
        let mut values = BTreeMap::new();
        let mut stack: Vec<String> = Vec::new();
        let mut comments: Vec<String> = Vec::new();

        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                comments.clear();
                continue;
            }
            if trimmed.starts_with("--") {
                comments.push(strip_comment(trimmed));
                continue;
            }
            if trimmed.starts_with('}') {
                stack.pop();
                comments.clear();
                continue;
            }

            let Some((key, rhs)) = split_assignment(trimmed) else {
                comments.clear();
                continue;
            };

            if rhs.starts_with('{') {
                if key != "SandboxVars" {
                    stack.push(key.to_owned());
                }
                comments.clear();
                continue;
            }

            let dotted = dotted_key(&stack, key);
            let display = display_value(rhs);
            let meta = comment_meta(&comments);
            let kind = infer_kind(rhs, &meta.options);
            let field = SandboxField {
                key: dotted.clone(),
                value: display.clone(),
                kind,
                help: meta.help,
                min: meta.min,
                max: meta.max,
                options: meta.options,
                group: group_for(&dotted),
                read_only: key == "VERSION",
            };
            values.insert(dotted, display);
            fields.push(field);
            comments.clear();
        }

        Self { fields, values }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    pub fn fields(&self) -> &[SandboxField] {
        &self.fields
    }

    /// Rewrite values in place, keeping comments, order, and nested tables.
    ///
    /// Unknown keys are an error: unlike `server.ini`, sandbox options are
    /// defined by the game (and mods), and inventing one at the root would
    /// silently do nothing.
    pub fn apply(contents: &str, updates: &BTreeMap<String, String>) -> Result<String, SandboxError> {
        if updates.is_empty() {
            return Ok(with_trailing_newline(contents));
        }

        let parsed = Self::parse(contents);
        for key in updates.keys() {
            if !parsed.values.contains_key(key) {
                return Err(SandboxError::UnknownKey(key.clone()));
            }
        }

        let mut remaining = updates.clone();
        let mut stack: Vec<String> = Vec::new();
        let lines: Vec<String> = contents
            .lines()
            .map(|line| rewrite_line(line, &mut stack, &mut remaining))
            .collect();

        let mut out = lines.join("\n");
        if !out.ends_with('\n') {
            out.push('\n');
        }
        Ok(out)
    }

    /// Read and parse the file, or `None` when it does not exist yet.
    pub async fn read(path: impl AsRef<Path>) -> Result<Option<Self>, SandboxError> {
        let path = path.as_ref();
        match tokio::fs::read_to_string(path).await {
            Ok(contents) => Ok(Some(Self::parse(&contents))),
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(SandboxError::Read {
                path: path.to_path_buf(),
                source,
            }),
        }
    }

    /// Read, apply `updates`, write back atomically.
    pub async fn write_updates(
        path: impl AsRef<Path>,
        updates: &BTreeMap<String, String>,
    ) -> Result<(), SandboxError> {
        let path = path.as_ref();
        if updates.is_empty() {
            return Ok(());
        }

        let contents = match tokio::fs::read_to_string(path).await {
            Ok(contents) => contents,
            Err(source) => {
                return Err(SandboxError::Read {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };

        let next = Self::apply(&contents, updates)?;
        let tmp = path.with_extension("lua.tmp");
        tokio::fs::write(&tmp, next.as_bytes())
            .await
            .map_err(|source| SandboxError::Write {
                path: tmp.clone(),
                source,
            })?;
        tokio::fs::rename(&tmp, path)
            .await
            .map_err(|source| SandboxError::Write {
                path: path.to_path_buf(),
                source,
            })
    }
}

fn rewrite_line(
    line: &str,
    stack: &mut Vec<String>,
    remaining: &mut BTreeMap<String, String>,
) -> String {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("--") {
        return line.to_owned();
    }
    if trimmed.starts_with('}') {
        stack.pop();
        return line.to_owned();
    }

    let Some((key, rhs)) = split_assignment(trimmed) else {
        return line.to_owned();
    };

    if rhs.starts_with('{') {
        if key != "SandboxVars" {
            stack.push(key.to_owned());
        }
        return line.to_owned();
    }

    let dotted = dotted_key(stack, key);
    match remaining.remove(&dotted) {
        Some(value) => replace_value(line, key, rhs, &value),
        None => line.to_owned(),
    }
}

fn replace_value(line: &str, key: &str, rhs: &str, new_value: &str) -> String {
    let indent_len = line.len() - line.trim_start().len();
    let indent = &line[..indent_len];
    let comma = if trimmed_ends_with_comma(line) { "," } else { "" };
    format!("{indent}{key} = {formatted}{comma}", formatted = format_like(rhs, new_value))
}

fn trimmed_ends_with_comma(line: &str) -> bool {
    line.trim_end().ends_with(',')
}

fn format_like(original: &str, new_value: &str) -> String {
    if original == "true" || original == "false" {
        return if new_value.eq_ignore_ascii_case("true") {
            "true".to_owned()
        } else {
            "false".to_owned()
        };
    }
    if original.starts_with('"') {
        return format!("\"{}\"", escape_lua(&unquote_input(new_value)));
    }
    new_value.trim().to_owned()
}

fn unquote_input(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        unescape_lua(&trimmed[1..trimmed.len() - 1])
    } else {
        trimmed.to_owned()
    }
}

fn escape_lua(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn unescape_lua(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some(next) => out.push(next),
                None => out.push('\\'),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn split_assignment(trimmed: &str) -> Option<(&str, &str)> {
    let (key, rest) = trimmed.split_once('=')?;
    let key = key.trim();
    if !is_ident(key) {
        return None;
    }
    let rest = rest.trim();
    let rhs = if rest.ends_with(',') {
        rest[..rest.len() - 1].trim()
    } else {
        rest
    };
    Some((key, rhs))
}

fn is_ident(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphabetic() || ch == '_' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn dotted_key(stack: &[String], key: &str) -> String {
    if stack.is_empty() {
        key.to_owned()
    } else {
        format!("{}.{key}", stack.join("."))
    }
}

fn display_value(rhs: &str) -> String {
    if rhs.len() >= 2 && rhs.starts_with('"') && rhs.ends_with('"') {
        unescape_lua(&rhs[1..rhs.len() - 1])
    } else {
        rhs.to_owned()
    }
}

fn strip_comment(trimmed: &str) -> String {
    trimmed
        .trim_start_matches('-')
        .trim()
        .to_owned()
}

struct CommentMeta {
    help: Option<String>,
    min: Option<f64>,
    max: Option<f64>,
    options: Vec<SandboxOption>,
}

fn comment_meta(comments: &[String]) -> CommentMeta {
    let mut options = Vec::new();
    let mut help_parts = Vec::new();
    for body in comments {
        if let Some(option) = enum_option(body) {
            options.push(option);
        } else if !body.is_empty() {
            help_parts.push(body.as_str());
        }
    }

    let joined = help_parts.join(" ");
    let (min, max) = extract_min_max(&joined);
    let help = {
        let cleaned = strip_markup(&strip_min_max_clause(&joined));
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    };

    CommentMeta {
        help,
        min,
        max,
        options,
    }
}

fn enum_option(body: &str) -> Option<SandboxOption> {
    let (num, label) = body.split_once('=')?;
    let num = num.trim();
    if num.is_empty() || !num.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let label = label.trim();
    if label.is_empty() {
        return None;
    }
    Some(SandboxOption {
        value: num.to_owned(),
        label: label.to_owned(),
    })
}

fn extract_min_max(text: &str) -> (Option<f64>, Option<f64>) {
    (number_after(text, "Min:"), number_after(text, "Max:"))
}

fn number_after(text: &str, label: &str) -> Option<f64> {
    let idx = text.find(label)?;
    let rest = text[idx + label.len()..].trim_start();
    let token: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.' || *ch == '-')
        .collect();
    token.parse().ok()
}

fn strip_min_max_clause(text: &str) -> String {
    match text.find("Min:") {
        Some(idx) => text[..idx].trim().to_owned(),
        None => text.to_owned(),
    }
}

fn strip_markup(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch == '<' {
            for next in chars.by_ref() {
                if next == '>' {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn infer_kind(rhs: &str, options: &[SandboxOption]) -> SandboxKind {
    if !options.is_empty() {
        return SandboxKind::Enum;
    }
    if rhs == "true" || rhs == "false" {
        return SandboxKind::Boolean;
    }
    if rhs.starts_with('"') {
        return SandboxKind::String;
    }
    SandboxKind::Number
}

fn group_for(key: &str) -> &'static str {
    if key == "VERSION" {
        return "other";
    }

    if let Some((parent, _)) = key.split_once('.') {
        return match parent {
            "ZombieLore" => "lore",
            "ZombieConfig" => "population",
            "MultiplierConfig" => "skills",
            "Map" | "Basement" => "map",
            _ => "mods",
        };
    }

    classify_top_level(key)
}

fn classify_top_level(key: &str) -> &'static str {
    if matches!(
        key,
        "Zombies" | "Distribution" | "ZombieVoronoiNoise" | "ZombieRespawn" | "ZombieMigrate"
    ) {
        return "population";
    }
    if matches!(
        key,
        "DayLength"
            | "StartYear"
            | "StartMonth"
            | "StartDay"
            | "StartTime"
            | "DayNightCycle"
            | "NightLength"
            | "NightDarkness"
            | "TimeSinceApo"
    ) {
        return "time";
    }
    if key.contains("Loot")
        || key.contains("RollsMultiplier")
        || key.contains("SeenHoursPrevent")
        || key.contains("MaximumLooted")
        || key.contains("RuralLooted")
        || key.contains("DiminishedLoot")
        || key == "HoursForLootRespawn"
        || key == "MaxItemsForLootRespawn"
        || key == "ConstructionPreventsLootRespawn"
    {
        return "loot";
    }
    if key.contains("WaterShut")
        || key.contains("ElecShut")
        || key.contains("AlarmDecay")
        || key.contains("Generator")
        || key.contains("LightBulb")
    {
        return "utilities";
    }
    if matches!(
        key,
        "Temperature"
            | "Rain"
            | "ClimateCycle"
            | "FogCycle"
            | "ErosionSpeed"
            | "ErosionDays"
            | "MaxFogIntensity"
            | "MaxRainFxIntensity"
            | "EnableSnowOnGround"
    ) {
        return "climate";
    }
    if key.starts_with("Car")
        || key.starts_with("Fuel")
        || key.starts_with("Vehicle")
        || key.contains("Gas")
        || matches!(
            key,
            "LockedCar"
                | "TrafficJam"
                | "EnableVehicles"
                | "PlayerDamageFromCrash"
                | "ChanceHasGas"
                | "RecentlySurvivorVehicles"
                | "DamageToPlayerFromHitByACar"
        )
        || key.contains("Siren")
    {
        return "vehicles";
    }
    if key.starts_with("Animal") || key.contains("Rat") {
        return "animals";
    }
    if key.starts_with("Firearm")
        || matches!(
            key,
            "MultiHitZombies" | "RearVulnerability" | "AttackBlockMovements"
        )
    {
        return "combat";
    }
    if matches!(
        key,
        "StarterKit"
            | "CharacterFreePoints"
            | "NegativeTraitsPenalty"
            | "AllClothesUnlocked"
            | "Nutrition"
            | "MinutesPerPage"
            | "LiteratureCooldown"
    ) || key.starts_with("LevelFor")
    {
        return "character";
    }
    "world"
}

fn with_trailing_newline(contents: &str) -> String {
    if contents.ends_with('\n') {
        contents.to_owned()
    } else {
        format!("{contents}\n")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("SandboxVars.lua at {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("SandboxVars.lua at {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("unknown sandbox setting: {0}")]
    UnknownKey(String),
}

pub fn sandbox_path(ini_path: &Path) -> PathBuf {
    let stem = ini_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "ZomboidServer".to_owned());
    ini_path.with_file_name(format!("{stem}_SandboxVars.lua"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"SandboxVars = {
    VERSION = 6,
    -- Changing this also sets the "Population Multiplier" in Advanced Zombie Options. Default = Normal
    -- 1 = Insane
    -- 2 = Very High
    -- 3 = High
    -- 4 = Normal
    -- 5 = Low
    -- 6 = None
    Zombies = 4,
    -- Default = 1 Hour, 30 Minutes
    -- 1 = 15 Minutes
    -- 2 = 30 Minutes
    -- 3 = 1 Hour
    -- 4 = 1 Hour, 30 Minutes
    DayLength = 4,
    -- When greater than 0, after X hours, all containers in towns and trailer parks in the world will respawn loot. Min: 0 Max: 2147483647 Default: 0
    HoursForLootRespawn = 0,
    -- Any food that can rot or spoil. Min: 0.00 Max: 4.00 Default: 0.80
    FoodLootNew = 0.8,
    -- Spawn with Chips, a Water Bottle, a Small Backpack, a Baseball Bat, and a Hammer.
    StarterKit = false,
    -- A comma-separated list of item types that won't spawn as ordinary loot.
    LootItemRemovalList = "",
    ZombieLore = {
        -- How fast zombies move. Default = Random
        -- 1 = Sprinters
        -- 2 = Fast Shamblers
        -- 3 = Shamblers
        -- 4 = Random
        Speed = 4,
        -- If zombies can destroy player constructions and defenses.
        ThumpOnConstruction = true,
    },
    ZombieConfig = {
        -- Set by the "Zombie Count" population option. Min: 0.00 Max: 4.00 Default: 0.65
        PopulationMultiplier = 0.65,
    },
    Map = {
        -- If enabled, a mini-map window will be available.
        AllowMiniMap = false,
    },
    CHStatusHUD = {
        RestrictStats = false,
    },
}
"#;

    #[test]
    fn reads_top_level_and_nested_dotted_keys() {
        let vars = SandboxVars::parse(SAMPLE);

        assert_eq!(vars.get("Zombies"), Some("4"));
        assert_eq!(vars.get("DayLength"), Some("4"));
        assert_eq!(vars.get("HoursForLootRespawn"), Some("0"));
        assert_eq!(vars.get("FoodLootNew"), Some("0.8"));
        assert_eq!(vars.get("StarterKit"), Some("false"));
        assert_eq!(vars.get("LootItemRemovalList"), Some(""));
        assert_eq!(vars.get("ZombieLore.Speed"), Some("4"));
        assert_eq!(vars.get("ZombieLore.ThumpOnConstruction"), Some("true"));
        assert_eq!(vars.get("ZombieConfig.PopulationMultiplier"), Some("0.65"));
        assert_eq!(vars.get("Map.AllowMiniMap"), Some("false"));
        assert_eq!(vars.get("CHStatusHUD.RestrictStats"), Some("false"));
        assert_eq!(vars.get("Speed"), None);
    }

    #[test]
    fn attaches_enum_options_and_help_from_comments() {
        let vars = SandboxVars::parse(SAMPLE);
        let zombies = vars
            .fields()
            .iter()
            .find(|field| field.key == "Zombies")
            .expect("Zombies");

        assert_eq!(zombies.kind, SandboxKind::Enum);
        assert_eq!(zombies.options.len(), 6);
        assert_eq!(zombies.options[0].value, "1");
        assert_eq!(zombies.options[0].label, "Insane");
        assert_eq!(zombies.options[3].label, "Normal");
        assert!(
            zombies
                .help
                .as_deref()
                .is_some_and(|help| help.contains("Population Multiplier")),
            "help: {:?}",
            zombies.help
        );
    }

    #[test]
    fn parses_min_max_for_numeric_fields() {
        let vars = SandboxVars::parse(SAMPLE);
        let loot = vars
            .fields()
            .iter()
            .find(|field| field.key == "FoodLootNew")
            .expect("FoodLootNew");

        assert_eq!(loot.kind, SandboxKind::Number);
        assert_eq!(loot.min, Some(0.0));
        assert_eq!(loot.max, Some(4.0));
    }

    #[test]
    fn groups_nested_tables_and_top_level_themes() {
        let vars = SandboxVars::parse(SAMPLE);
        let group = |key: &str| {
            vars.fields()
                .iter()
                .find(|field| field.key == key)
                .map(|field| field.group)
        };

        assert_eq!(group("Zombies"), Some("population"));
        assert_eq!(group("DayLength"), Some("time"));
        assert_eq!(group("HoursForLootRespawn"), Some("loot"));
        assert_eq!(group("FoodLootNew"), Some("loot"));
        assert_eq!(group("StarterKit"), Some("character"));
        assert_eq!(group("ZombieLore.Speed"), Some("lore"));
        assert_eq!(group("ZombieConfig.PopulationMultiplier"), Some("population"));
        assert_eq!(group("Map.AllowMiniMap"), Some("map"));
        assert_eq!(group("CHStatusHUD.RestrictStats"), Some("mods"));
        assert_eq!(group("VERSION"), Some("other"));
    }

    #[test]
    fn version_is_read_only() {
        let vars = SandboxVars::parse(SAMPLE);
        let version = vars
            .fields()
            .iter()
            .find(|field| field.key == "VERSION")
            .expect("VERSION");
        assert!(version.read_only);
        assert_eq!(version.value, "6");
    }

    #[test]
    fn apply_rewrites_existing_keys_and_keeps_comments() {
        let mut updates = BTreeMap::new();
        updates.insert("Zombies".to_owned(), "2".to_owned());
        updates.insert("ZombieLore.Speed".to_owned(), "1".to_owned());
        updates.insert("FoodLootNew".to_owned(), "1.2".to_owned());
        updates.insert("StarterKit".to_owned(), "true".to_owned());

        let next = SandboxVars::apply(SAMPLE, &updates).expect("apply");

        assert!(next.contains("-- 1 = Insane"));
        assert!(next.contains("Zombies = 2,"));
        assert!(next.contains("Speed = 1,"));
        assert!(next.contains("FoodLootNew = 1.2,"));
        assert!(next.contains("StarterKit = true,"));
        assert!(next.contains("DayLength = 4,"));
        assert!(next.contains("ThumpOnConstruction = true,"));
        assert!(!next.contains("Zombies = 4,"));
        assert!(!next.contains("Speed = 4,"));
    }

    #[test]
    fn apply_rejects_keys_that_are_not_in_the_file() {
        let mut updates = BTreeMap::new();
        updates.insert("NoSuchKey".to_owned(), "1".to_owned());

        let error = SandboxVars::apply(SAMPLE, &updates).expect_err("unknown");
        assert!(matches!(error, SandboxError::UnknownKey(key) if key == "NoSuchKey"));
    }

    #[test]
    fn sandbox_path_is_next_to_the_ini() {
        let ini = Path::new("/pz-data/Server/ZomboidServer.ini");
        assert_eq!(
            sandbox_path(ini),
            PathBuf::from("/pz-data/Server/ZomboidServer_SandboxVars.lua")
        );
    }

    #[test]
    fn parses_a_live_b42_sandbox_file_when_present() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../data/zomboid/Server/ZomboidServer_SandboxVars.lua");
        let Ok(contents) = std::fs::read_to_string(&path) else {
            return;
        };
        let vars = SandboxVars::parse(&contents);
        assert!(
            vars.fields().len() > 200,
            "expected a full B42 sandbox, got {}",
            vars.fields().len()
        );
        assert!(vars.get("ZombieLore.Speed").is_some());
        assert!(vars.get("HoursForLootRespawn").is_some());
        assert!(vars.get("NightLength").is_some());
        assert!(
            vars.fields()
                .iter()
                .any(|field| field.key == "ZombieLore.Speed" && field.kind == SandboxKind::Enum)
        );

        let current = vars.get("HoursForLootRespawn").unwrap().to_owned();
        let mut updates = BTreeMap::new();
        updates.insert("HoursForLootRespawn".to_owned(), current);
        let next = SandboxVars::apply(&contents, &updates).expect("no-op apply");
        assert_eq!(SandboxVars::parse(&next).fields().len(), vars.fields().len());
    }
}
