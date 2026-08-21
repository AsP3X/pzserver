//! Staged flows. Staff draw a graph; players walk execution left to right.

use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::character;
use crate::services::economy::{self, inventory, measure, wallet};
use crate::state::AppState;

const NODE_TYPES: &[&str] = &[
    "start", "stage", "task", "objective", "reward", "end", "area", "find", "collect", "kills",
];
const CONDITIONS: &[&str] = &["task", "objective", "area", "find", "collect", "kills"];
const AUDIENCES: &[&str] = &["all", "players", "group", "claimable"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Graph {
    #[serde(default)]
    pub nodes: Vec<GraphNode>,
    #[serde(default)]
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub data: NodeData,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NodeData {
    pub description: Option<String>,
    pub measure: Option<String>,
    pub goal: Option<i32>,
    pub cadence: Option<String>,
    pub xp: Option<i32>,
    pub coins: Option<i64>,
    pub item_type: Option<String>,
    pub area_x: Option<f64>,
    pub area_y: Option<f64>,
    pub area_z: Option<i32>,
    pub area_radius: Option<f64>,
    pub area_cells: Option<Vec<AreaCell>>,
    pub area_cell_size: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AreaCell {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub id: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Quest {
    pub id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub audience: String,
    pub audience_usernames: Vec<String>,
    pub audience_group_id: Option<Uuid>,
    pub active: bool,
    pub graph: Graph,
    pub created_at: chrono::DateTime<Utc>,
    pub updated_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct QuestPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub audience: Option<String>,
    pub audience_usernames: Option<Vec<String>>,
    pub audience_group_id: Option<Option<Uuid>>,
    pub active: Option<bool>,
    pub graph: Option<Graph>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QuestProgress {
    pub id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub stage: Option<String>,
    pub nodes: Vec<QuestNodeView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QuestNodeView {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub description: Option<String>,
    pub measure: Option<String>,
    pub cadence: String,
    pub xp: i32,
    pub coins: i64,
    pub progress: i64,
    pub goal: i64,
    pub item_type: Option<String>,
    pub area_x: Option<f64>,
    pub area_y: Option<f64>,
    pub area_radius: Option<f64>,
    pub unlocked: bool,
    pub complete: bool,
    pub claimed: bool,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct PlayerGroup {
    pub id: Uuid,
    pub name: String,
    pub members: i64,
    pub created_at: chrono::DateTime<Utc>,
}

pub async fn list_admin(db: &PgPool) -> ApiResult<Vec<Quest>> {
    let rows = sqlx::query_as::<_, QuestRow>(
        r#"SELECT id, title, description, audience, audience_usernames, audience_group_id,
                  active, graph, created_at, updated_at
           FROM quests ORDER BY updated_at DESC"#,
    )
    .fetch_all(db)
    .await?;
    rows.into_iter().map(Quest::try_from).collect()
}

pub async fn get(db: &PgPool, id: Uuid) -> ApiResult<Quest> {
    let row = sqlx::query_as::<_, QuestRow>(
        r#"SELECT id, title, description, audience, audience_usernames, audience_group_id,
                  active, graph, created_at, updated_at
           FROM quests WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::Validation("That flow is gone.".to_owned()))?;
    Quest::try_from(row)
}

pub async fn create(db: &PgPool, patch: QuestPatch) -> ApiResult<Quest> {
    let title = patch
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::Validation("Give the flow a title.".to_owned()))?;
    let graph = patch.graph.unwrap_or_else(default_graph);
    validate_graph(&graph)?;
    let audience = patch.audience.unwrap_or_else(|| "all".to_owned());
    if !AUDIENCES.contains(&audience.as_str()) {
        return Err(ApiError::Validation("Unknown audience.".to_owned()));
    }
    let usernames = patch.audience_usernames.unwrap_or_default();
    let row = sqlx::query_as::<_, QuestRow>(
        r#"INSERT INTO quests
            (title, description, audience, audience_usernames, audience_group_id, active, graph)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, title, description, audience, audience_usernames, audience_group_id,
                     active, graph, created_at, updated_at"#,
    )
    .bind(title)
    .bind(patch.description)
    .bind(audience)
    .bind(&usernames)
    .bind(patch.audience_group_id.flatten())
    .bind(patch.active.unwrap_or(false))
    .bind(sqlx::types::Json(&graph))
    .fetch_one(db)
    .await?;
    Quest::try_from(row)
}

pub async fn update(db: &PgPool, id: Uuid, patch: QuestPatch) -> ApiResult<Quest> {
    let current = get(db, id).await?;
    let title = patch
        .title
        .unwrap_or(current.title)
        .trim()
        .to_owned();
    if title.is_empty() || title.len() > 80 {
        return Err(ApiError::Validation("Title must be 1–80 characters.".to_owned()));
    }
    let graph = patch.graph.unwrap_or(current.graph);
    validate_graph(&graph)?;
    let audience = patch.audience.unwrap_or(current.audience);
    if !AUDIENCES.contains(&audience.as_str()) {
        return Err(ApiError::Validation("Unknown audience.".to_owned()));
    }
    let usernames = patch.audience_usernames.unwrap_or(current.audience_usernames);
    let group_id = match patch.audience_group_id {
        Some(value) => value,
        None => current.audience_group_id,
    };
    let row = sqlx::query_as::<_, QuestRow>(
        r#"UPDATE quests SET
            title = $2, description = $3, audience = $4, audience_usernames = $5,
            audience_group_id = $6, active = $7, graph = $8, updated_at = now()
           WHERE id = $1
           RETURNING id, title, description, audience, audience_usernames, audience_group_id,
                     active, graph, created_at, updated_at"#,
    )
    .bind(id)
    .bind(title)
    .bind(patch.description.or(current.description))
    .bind(audience)
    .bind(&usernames)
    .bind(group_id)
    .bind(patch.active.unwrap_or(current.active))
    .bind(sqlx::types::Json(&graph))
    .fetch_one(db)
    .await?;
    Quest::try_from(row)
}

pub async fn delete(db: &PgPool, id: Uuid) -> ApiResult<()> {
    let result = sqlx::query("DELETE FROM quests WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::Validation("That flow is gone.".to_owned()));
    }
    Ok(())
}

pub async fn for_player(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    today: NaiveDate,
) -> ApiResult<Vec<QuestProgress>> {
    let rows = sqlx::query_as::<_, QuestRow>(
        r#"SELECT id, title, description, audience, audience_usernames, audience_group_id,
                  active, graph, created_at, updated_at
           FROM quests WHERE active"#,
    )
    .fetch_all(&state.db)
    .await?;

    let mut out = Vec::new();
    for row in rows {
        let quest = Quest::try_from(row)?;
        if !visible_to(&state.db, &quest, user_id, username).await? {
            continue;
        }
        if let Some(view) = progress(state, user_id, username, today, &quest).await? {
            out.push(view);
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct QuestOffer {
    pub id: Uuid,
    pub title: String,
    pub description: Option<String>,
}

pub async fn offers_for(db: &PgPool, user_id: Uuid) -> ApiResult<Vec<QuestOffer>> {
    let rows = sqlx::query_as::<_, (Uuid, String, Option<String>)>(
        r#"SELECT q.id, q.title, q.description
           FROM quests q
           WHERE q.active
             AND q.audience = 'claimable'
             AND NOT EXISTS (
                 SELECT 1 FROM quest_claims c
                 WHERE c.quest_id = q.id AND c.user_id = $1
             )
           ORDER BY q.title"#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, title, description)| QuestOffer {
            id,
            title,
            description,
        })
        .collect())
}

pub async fn claim_offer(db: &PgPool, user_id: Uuid, quest_id: Uuid) -> ApiResult<()> {
    let quest = get(db, quest_id).await?;
    if !quest.active || quest.audience != "claimable" {
        return Err(ApiError::Validation(
            "That flow is not open to pick up.".to_owned(),
        ));
    }
    if claimed_by(db, quest_id, user_id).await? {
        return Err(ApiError::Validation("You already have that flow.".to_owned()));
    }
    sqlx::query(
        r#"INSERT INTO quest_claims (quest_id, user_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING"#,
    )
    .bind(quest_id)
    .bind(user_id)
    .execute(db)
    .await?;
    Ok(())
}

async fn claimed_by(db: &PgPool, quest_id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT EXISTS(
               SELECT 1 FROM quest_claims
               WHERE quest_id = $1 AND user_id = $2
           )"#,
    )
    .bind(quest_id)
    .bind(user_id)
    .fetch_one(db)
    .await
}

pub async fn claim_node(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    quest_id: Uuid,
    node_id: &str,
    today: NaiveDate,
) -> ApiResult<(i32, i64)> {
    let quest = get(&state.db, quest_id).await?;
    if !quest.active {
        return Err(ApiError::Validation("That flow is not live.".to_owned()));
    }
    if !visible_to(&state.db, &quest, user_id, username).await? {
        return Err(ApiError::Validation("That flow is not for you.".to_owned()));
    }
    let view = progress(state, user_id, username, today, &quest)
        .await?
        .ok_or_else(|| ApiError::Validation("That flow is not for you.".to_owned()))?;
    let node = view
        .nodes
        .iter()
        .find(|item| item.id == node_id)
        .ok_or_else(|| ApiError::Validation("Unknown node.".to_owned()))?;
    if !node.unlocked {
        return Err(ApiError::Validation("That stage is still locked.".to_owned()));
    }
    if node.claimed {
        return Err(ApiError::Validation("Already claimed.".to_owned()));
    }
    if node.kind == "reward" {
        return award_node(state, user_id, quest_id, node, today).await;
    }
    if !CONDITIONS.contains(&node.kind.as_str()) {
        return Err(ApiError::Validation("That node cannot be collected.".to_owned()));
    }
    if node.measure.as_deref() == Some("manual") {
        return Err(ApiError::Validation("Staff have to mark that done.".to_owned()));
    }
    if !node.complete {
        return Err(ApiError::Validation("That step is not finished yet.".to_owned()));
    }
    award_node(state, user_id, quest_id, node, today).await
}

/// Staff marking a step done on a player's behalf.
///
/// A `manual` node has no measure the server can read, so `claim_node` refuses
/// it and tells the player staff will handle it — but until this existed there
/// was nothing for staff to call, and manual nodes could never be completed by
/// anyone. It also doubles as the unstick for a node whose measure has drifted.
///
/// Deliberately still honours `unlocked` and audience: granting past a locked
/// prerequisite would leave the flow in a state its own graph disallows.
pub async fn grant_node(
    state: &AppState,
    username: &str,
    quest_id: Uuid,
    node_id: &str,
) -> ApiResult<(i32, i64)> {
    let target: (Uuid, String) =
        sqlx::query_as("SELECT id, username FROM users WHERE lower(username) = lower($1)")
            .bind(username.trim())
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| ApiError::Validation("No account with that name.".to_owned()))?;
    let (user_id, resolved) = target;

    let quest = get(&state.db, quest_id).await?;
    if !visible_to(&state.db, &quest, user_id, &resolved).await? {
        return Err(ApiError::Validation("That flow is not for that player.".to_owned()));
    }

    let today = Utc::now().date_naive();
    let view = progress(state, user_id, &resolved, today, &quest)
        .await?
        .ok_or_else(|| ApiError::Validation("That flow is not for that player.".to_owned()))?;
    let node = view
        .nodes
        .iter()
        .find(|item| item.id == node_id)
        .ok_or_else(|| ApiError::Validation("Unknown node.".to_owned()))?;

    if !CONDITIONS.contains(&node.kind.as_str()) && node.kind != "reward" {
        return Err(ApiError::Validation("That node cannot be granted.".to_owned()));
    }
    if !node.unlocked {
        return Err(ApiError::Validation("That stage is still locked.".to_owned()));
    }
    if node.claimed {
        return Err(ApiError::Validation("Already claimed.".to_owned()));
    }

    award_node(state, user_id, quest_id, node, today).await
}

pub async fn list_groups(db: &PgPool) -> Result<Vec<PlayerGroup>, sqlx::Error> {
    sqlx::query_as::<_, PlayerGroup>(
        r#"SELECT g.id, g.name, COUNT(m.user_id)::bigint AS members, g.created_at
           FROM player_groups g
           LEFT JOIN player_group_members m ON m.group_id = g.id
           GROUP BY g.id
           ORDER BY g.name"#,
    )
    .fetch_all(db)
    .await
}

pub async fn create_group(db: &PgPool, name: &str) -> ApiResult<PlayerGroup> {
    let name = name.trim();
    if name.is_empty() || name.len() > 60 {
        return Err(ApiError::Validation("Group name must be 1–60 characters.".to_owned()));
    }
    let row = sqlx::query_as::<_, PlayerGroup>(
        r#"INSERT INTO player_groups (name) VALUES ($1)
           RETURNING id, name, 0::bigint AS members, created_at"#,
    )
    .bind(name)
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub async fn delete_group(db: &PgPool, id: Uuid) -> ApiResult<()> {
    let result = sqlx::query("DELETE FROM player_groups WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::Validation("That group is gone.".to_owned()));
    }
    Ok(())
}

pub async fn add_member(db: &PgPool, group_id: Uuid, username: &str) -> ApiResult<()> {
    let user_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM users WHERE lower(username) = lower($1)",
    )
    .bind(username.trim())
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::Validation("No account with that name.".to_owned()))?;
    sqlx::query(
        r#"INSERT INTO player_group_members (group_id, user_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING"#,
    )
    .bind(group_id)
    .bind(user_id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn remove_member(db: &PgPool, group_id: Uuid, user_id: Uuid) -> ApiResult<()> {
    sqlx::query("DELETE FROM player_group_members WHERE group_id = $1 AND user_id = $2")
        .bind(group_id)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn remove_member_named(db: &PgPool, group_id: Uuid, username: &str) -> ApiResult<()> {
    let user_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM users WHERE lower(username) = lower($1)",
    )
    .bind(username.trim())
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::Validation("No account with that name.".to_owned()))?;
    remove_member(db, group_id, user_id).await
}

pub async fn group_members(db: &PgPool, group_id: Uuid) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT u.username
           FROM player_group_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.group_id = $1
           ORDER BY u.username"#,
    )
    .bind(group_id)
    .fetch_all(db)
    .await
}

async fn progress(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    today: NaiveDate,
    quest: &Quest,
) -> ApiResult<Option<QuestProgress>> {
    let graph = &quest.graph;
    if graph.nodes.is_empty() {
        return Ok(None);
    }

    let snapshot = character::for_username(&state.db, username).await?;
    let position = current_position(state, username).await;
    let kills_now = snapshot.as_ref().map(|row| row.zombie_kills).unwrap_or(0);

    let mut nodes = Vec::new();
    for node in &graph.nodes {
        let cadence = node
            .data
            .cadence
            .clone()
            .unwrap_or_else(|| "once".to_owned());
        let period = if cadence == "daily" {
            today
        } else {
            NaiveDate::from_ymd_opt(1970, 1, 1).expect("epoch")
        };
        let claimed = node_claimed(&state.db, quest.id, user_id, &node.id, period).await?;
        let measure = node.data.measure.clone();
        let goal = match node.kind.as_str() {
            "area" | "find" => 1,
            _ => i64::from(node.data.goal.unwrap_or(1).max(1)),
        };
        let progress = measure_node(state, user_id, username, today, node, position).await?;
        nodes.push(QuestNodeView {
            id: node.id.clone(),
            kind: node.kind.clone(),
            title: if node.title.trim().is_empty() {
                node.kind.clone()
            } else {
                node.title.clone()
            },
            description: node.data.description.clone(),
            measure: measure.clone(),
            cadence,
            xp: node.data.xp.unwrap_or(0),
            coins: node.data.coins.unwrap_or(0),
            progress: progress.min(goal),
            goal,
            item_type: node.data.item_type.clone(),
            area_x: node.data.area_x,
            area_y: node.data.area_y,
            area_radius: node.data.area_radius,
            unlocked: false,
            complete: match node.kind.as_str() {
                "start" => true,
                "task" | "objective" => claimed || (measure.as_deref() != Some("manual") && progress >= goal),
                "area" | "find" | "collect" | "kills" => claimed || progress >= goal,
                "reward" => claimed,
                _ => false,
            },
            claimed,
        });
    }

    resolve_unlocks(graph, &mut nodes);

    for node in graph.nodes.iter().filter(|node| node.kind == "kills") {
        let Some(view) = nodes.iter_mut().find(|item| item.id == node.id) else {
            continue;
        };
        if !view.unlocked || view.claimed {
            continue;
        }
        let baseline = ensure_kill_baseline(&state.db, quest.id, user_id, &node.id, kills_now).await?;
        let gained = i64::from((kills_now - baseline).max(0));
        view.progress = gained.min(view.goal);
        view.complete = view.progress >= view.goal;
    }

    resolve_unlocks(graph, &mut nodes);

    for index in 0..nodes.len() {
        let auto = {
            let node = &nodes[index];
            (node.kind == "reward" && node.unlocked && !node.claimed && (node.xp > 0 || node.coins > 0))
                || (node.kind == "area"
                    && node.unlocked
                    && node.complete
                    && !node.claimed
                    && node.xp == 0
                    && node.coins == 0)
        };
        if auto {
            let node = nodes[index].clone();
            if award_node(state, user_id, quest.id, &node, today).await.is_ok() {
                nodes[index].claimed = true;
                nodes[index].complete = true;
                resolve_unlocks(graph, &mut nodes);
            }
        }
    }

    let stage = current_stage(graph, &nodes);
    Ok(Some(QuestProgress {
        id: quest.id,
        title: quest.title.clone(),
        description: quest.description.clone(),
        stage,
        nodes,
    }))
}

fn resolve_unlocks(graph: &Graph, nodes: &mut [QuestNodeView]) {
    for _ in 0..nodes.len() + 1 {
        let mut changed = false;
        for index in 0..nodes.len() {
            if nodes[index].kind == "start" {
                if !nodes[index].unlocked {
                    nodes[index].unlocked = true;
                    changed = true;
                }
                continue;
            }

            let incoming: Vec<String> = graph
                .edges
                .iter()
                .filter(|edge| edge.to == nodes[index].id)
                .map(|edge| edge.from.clone())
                .collect();
            let ready = incoming.iter().all(|id| {
                nodes
                    .iter()
                    .find(|item| item.id == *id)
                    .is_some_and(incoming_satisfied)
            });
            let next = incoming.is_empty() || ready;
            if next != nodes[index].unlocked {
                nodes[index].unlocked = next;
                changed = true;
            }
            if matches!(nodes[index].kind.as_str(), "stage" | "end")
                && nodes[index].unlocked
                && !nodes[index].complete
            {
                nodes[index].complete = true;
                nodes[index].claimed = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
}

async fn measure_node(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    today: NaiveDate,
    node: &GraphNode,
    position: Option<(f64, f64, i32)>,
) -> ApiResult<i64> {
    match node.kind.as_str() {
        "task" | "objective" => {
            let Some(kind) = node.data.measure.as_deref() else {
                return Ok(0);
            };
            let cadence = node.data.cadence.as_deref().unwrap_or("once");
            measure::measured_progress(state, user_id, username, today, kind, cadence).await
        }
        "area" => Ok(i64::from(inside_area(node, position))),
        "find" | "collect" => {
            let Some(item_type) = node.data.item_type.as_deref() else {
                return Ok(0);
            };
            let have = i64::from(inventory::carried(state, username, item_type).await?);
            let held = inventory::reserved(&state.db, user_id, item_type).await?;
            Ok((have - held).max(0))
        }
        "kills" => Ok(0),
        _ => Ok(0),
    }
}

fn inside_area(node: &GraphNode, position: Option<(f64, f64, i32)>) -> bool {
    let Some((px, py, pz)) = position else {
        return false;
    };
    if let Some(floor) = node.data.area_z
        && pz != floor {
            return false;
        }
    if let Some(cells) = node.data.area_cells.as_ref()
        && !cells.is_empty() {
            let size = f64::from(node.data.area_cell_size.unwrap_or(16).max(1));
            let cx = (px / size).floor() as i32;
            let cy = (py / size).floor() as i32;
            return cells.iter().any(|cell| cell.x == cx && cell.y == cy);
        }
    let (Some(x), Some(y), Some(radius)) = (node.data.area_x, node.data.area_y, node.data.area_radius)
    else {
        return false;
    };
    let dx = px - x;
    let dy = py - y;
    (dx * dx + dy * dy).sqrt() <= radius
}

async fn current_position(state: &AppState, username: &str) -> Option<(f64, f64, i32)> {
    if let Ok(Some(read)) = pz_bridge::LuaBridge::new(&state.config.lua_bridge_path)
        .players_live()
        .await
        && let Some(player) = read
            .data
            .players
            .iter()
            .find(|player| player.username.eq_ignore_ascii_case(username))
        {
            return Some((player.x, player.y, player.z));
        }
    character::last_position(&state.db, username)
        .await
        .ok()
        .flatten()
        .map(|last| (last.x, last.y, last.z))
}

async fn ensure_kill_baseline(
    db: &PgPool,
    quest_id: Uuid,
    user_id: Uuid,
    node_id: &str,
    kills: i32,
) -> Result<i32, sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO quest_node_baselines (quest_id, user_id, node_id, zombie_kills)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (quest_id, user_id, node_id) DO NOTHING"#,
    )
    .bind(quest_id)
    .bind(user_id)
    .bind(node_id)
    .bind(kills)
    .execute(db)
    .await?;

    sqlx::query_scalar(
        r#"SELECT zombie_kills FROM quest_node_baselines
           WHERE quest_id = $1 AND user_id = $2 AND node_id = $3"#,
    )
    .bind(quest_id)
    .bind(user_id)
    .bind(node_id)
    .fetch_one(db)
    .await
}

fn incoming_satisfied(node: &QuestNodeView) -> bool {
    match node.kind.as_str() {
        "start" | "stage" | "end" => node.unlocked,
        "reward" => node.claimed || (node.unlocked && node.xp == 0 && node.coins == 0),
        "task" | "objective" | "area" | "find" | "collect" | "kills" => node.claimed,
        _ => node.claimed,
    }
}

fn current_stage(graph: &Graph, nodes: &[QuestNodeView]) -> Option<String> {
    let mut best: Option<&GraphNode> = None;
    for node in &graph.nodes {
        if node.kind != "stage" {
            continue;
        }
        let view = nodes.iter().find(|item| item.id == node.id)?;
        if view.unlocked {
            best = Some(node);
        }
    }
    best.map(|node| {
        if node.title.trim().is_empty() {
            node.kind.clone()
        } else {
            node.title.clone()
        }
    })
}

async fn award_node(
    state: &AppState,
    user_id: Uuid,
    quest_id: Uuid,
    node: &QuestNodeView,
    today: NaiveDate,
) -> ApiResult<(i32, i64)> {
    let period = measure::period_of(&node.cadence, today);
    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query(
        r#"INSERT INTO quest_node_completions
            (quest_id, user_id, node_id, period, xp_awarded, coins_awarded)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (quest_id, user_id, node_id, period) DO NOTHING"#,
    )
    .bind(quest_id)
    .bind(user_id)
    .bind(&node.id)
    .bind(period)
    .bind(node.xp)
    .bind(node.coins)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError::Validation("Already claimed.".to_owned()));
    }
    if node.xp > 0 {
        sqlx::query(
            r#"INSERT INTO account_progress (user_id, xp)
               VALUES ($1, $2)
               ON CONFLICT (user_id) DO UPDATE
                 SET xp = account_progress.xp + EXCLUDED.xp,
                     updated_at = now()"#,
        )
        .bind(user_id)
        .bind(i64::from(node.xp))
        .execute(&mut *tx)
        .await?;
    }
    if node.coins > 0 {
        wallet::credit_tx(
            &mut tx,
            user_id,
            node.coins,
            economy::SOURCE_QUEST,
            Some(&node.title),
            Some("quest"),
            Some(quest_id),
        )
        .await?;
    }
    tx.commit().await?;
    Ok((node.xp, node.coins))
}

async fn node_claimed(
    db: &PgPool,
    quest_id: Uuid,
    user_id: Uuid,
    node_id: &str,
    period: NaiveDate,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT EXISTS(
               SELECT 1 FROM quest_node_completions
               WHERE quest_id = $1 AND user_id = $2 AND node_id = $3 AND period = $4
           )"#,
    )
    .bind(quest_id)
    .bind(user_id)
    .bind(node_id)
    .bind(period)
    .fetch_one(db)
    .await
}

async fn visible_to(
    db: &PgPool,
    quest: &Quest,
    user_id: Uuid,
    username: &str,
) -> Result<bool, sqlx::Error> {
    match quest.audience.as_str() {
        "all" => Ok(true),
        "claimable" => claimed_by(db, quest.id, user_id).await,
        "players" => Ok(quest
            .audience_usernames
            .iter()
            .any(|name| name.eq_ignore_ascii_case(username))),
        "group" => {
            let Some(group_id) = quest.audience_group_id else {
                return Ok(false);
            };
            sqlx::query_scalar(
                r#"SELECT EXISTS(
                       SELECT 1 FROM player_group_members
                       WHERE group_id = $1 AND user_id = $2
                   )"#,
            )
            .bind(group_id)
            .bind(user_id)
            .fetch_one(db)
            .await
        }
        _ => Ok(false),
    }
}

fn validate_graph(graph: &Graph) -> ApiResult<()> {
    if graph.nodes.len() > 80 {
        return Err(ApiError::Validation("A flow can have at most 80 nodes.".to_owned()));
    }
    let mut seen = std::collections::HashSet::new();
    let mut starts = 0;
    for node in &graph.nodes {
        if !NODE_TYPES.contains(&node.kind.as_str()) {
            return Err(ApiError::Validation(format!("Unknown node type {}.", node.kind)));
        }
        if !seen.insert(node.id.clone()) {
            return Err(ApiError::Validation("Duplicate node id.".to_owned()));
        }
        if node.kind == "start" {
            starts += 1;
        }
        if matches!(node.kind.as_str(), "task" | "objective") {
            let kind = node.data.measure.as_deref().unwrap_or("");
            if !measure::MEASURES.contains(&kind) {
                return Err(ApiError::Validation(
                    "Every task or objective needs a measure.".to_owned(),
                ));
            }
            // Unvalidated before, so a typo here silently fell through to the
            // `once` branch and the step never reset.
            let cadence = node.data.cadence.as_deref().unwrap_or("once");
            if !measure::CADENCES.contains(&cadence) {
                return Err(ApiError::Validation(
                    "Cadence must be daily or once.".to_owned(),
                ));
            }
        }
        if node.kind == "area" {
            let painted = node
                .data
                .area_cells
                .as_ref()
                .is_some_and(|cells| !cells.is_empty());
            let radius = node.data.area_radius.unwrap_or(0.0);
            let circle = node.data.area_x.is_some() && node.data.area_y.is_some() && radius >= 1.0;
            if !painted && !circle {
                return Err(ApiError::Validation(
                    "An area node needs a painted district or a centre (X, Y) and radius.".to_owned(),
                ));
            }
        }
        if matches!(node.kind.as_str(), "find" | "collect") {
            let raw = node.data.item_type.as_deref().unwrap_or("");
            economy::item_type(raw)?;
        }
        if node.kind == "collect" && node.data.goal.unwrap_or(0) < 1 {
            return Err(ApiError::Validation("Collect needs a count of at least 1.".to_owned()));
        }
        if node.kind == "kills" && node.data.goal.unwrap_or(0) < 1 {
            return Err(ApiError::Validation("A kill node needs a count of at least 1.".to_owned()));
        }
    }
    if starts != 1 {
        return Err(ApiError::Validation("A flow needs exactly one Start node.".to_owned()));
    }
    let ids = seen;
    for edge in &graph.edges {
        if !ids.contains(&edge.from) || !ids.contains(&edge.to) {
            return Err(ApiError::Validation("An edge points at a missing node.".to_owned()));
        }
        if edge.from == edge.to {
            return Err(ApiError::Validation("A node cannot connect to itself.".to_owned()));
        }
    }
    if has_cycle(graph) {
        return Err(ApiError::Validation("The flow has a loop.".to_owned()));
    }
    Ok(())
}

fn has_cycle(graph: &Graph) -> bool {
    use std::collections::HashMap;
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &graph.edges {
        outgoing.entry(edge.from.as_str()).or_default().push(edge.to.as_str());
    }
    fn visit<'a>(
        id: &'a str,
        outgoing: &HashMap<&'a str, Vec<&'a str>>,
        stack: &mut Vec<&'a str>,
        seen: &mut std::collections::HashSet<&'a str>,
    ) -> bool {
        if stack.contains(&id) {
            return true;
        }
        if !seen.insert(id) {
            return false;
        }
        stack.push(id);
        if let Some(next) = outgoing.get(id) {
            for child in next {
                if visit(child, outgoing, stack, seen) {
                    return true;
                }
            }
        }
        stack.pop();
        false
    }
    let mut seen = std::collections::HashSet::new();
    let mut stack = Vec::new();
    graph.nodes.iter().any(|node| visit(&node.id, &outgoing, &mut stack, &mut seen))
}

fn default_graph() -> Graph {
    Graph {
        nodes: vec![
            GraphNode {
                id: "start".into(),
                kind: "start".into(),
                x: 80.0,
                y: 180.0,
                title: "Start".into(),
                data: NodeData::default(),
            },
            GraphNode {
                id: "stage-1".into(),
                kind: "stage".into(),
                x: 320.0,
                y: 180.0,
                title: "Stage 1".into(),
                data: NodeData::default(),
            },
            GraphNode {
                id: "end".into(),
                kind: "end".into(),
                x: 560.0,
                y: 180.0,
                title: "End".into(),
                data: NodeData::default(),
            },
        ],
        edges: vec![
            GraphEdge { id: "e1".into(), from: "start".into(), to: "stage-1".into() },
            GraphEdge { id: "e2".into(), from: "stage-1".into(), to: "end".into() },
        ],
    }
}

#[derive(Debug, FromRow)]
struct QuestRow {
    id: Uuid,
    title: String,
    description: Option<String>,
    audience: String,
    audience_usernames: Vec<String>,
    audience_group_id: Option<Uuid>,
    active: bool,
    graph: sqlx::types::Json<Graph>,
    created_at: chrono::DateTime<Utc>,
    updated_at: chrono::DateTime<Utc>,
}

impl TryFrom<QuestRow> for Quest {
    type Error = ApiError;

    fn try_from(row: QuestRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: row.id,
            title: row.title,
            description: row.description,
            audience: row.audience,
            audience_usernames: row.audience_usernames,
            audience_group_id: row.audience_group_id,
            active: row.active,
            graph: row.graph.0,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}
