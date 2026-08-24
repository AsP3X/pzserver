//! Regional isometric re-renders. One `pz-map-tiles` container at a time.
//!
//! HTTP returns immediately; a background task creates the renderer through
//! the Docker socket proxy. `DockerClient` is not used — that client is wired
//! only to the game-server container.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const CONTAINER: &str = "pz-map-tiles";
/// 24 GiB, matching compose `shm_size: 24gb`.
const SHM_SIZE: i64 = 24 * 1024 * 1024 * 1024;
const INSPECT_TIMEOUT: Duration = Duration::from_secs(5);
const WAIT_TIMEOUT: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Job {
    pub id: Uuid,
    pub squares: serde_json::Value,
    pub cells: serde_json::Value,
    pub status: String,
    pub error: Option<String>,
    pub tiles_replaced: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

/// Promote `[x, y]` to `[x, y, 1, 1]`. Cells stay cells; the container converts.
pub fn normalize(
    squares: &[Vec<i32>],
    cells: &[Vec<i32>],
) -> Result<(Vec<[i32; 4]>, Vec<[i32; 4]>), ApiError> {
    if squares.is_empty() && cells.is_empty() {
        return Err(ApiError::Validation("provide squares or cells".to_owned()));
    }

    Ok((normalize_rects(squares)?, normalize_rects(cells)?))
}

fn normalize_rects(rects: &[Vec<i32>]) -> Result<Vec<[i32; 4]>, ApiError> {
    rects
        .iter()
        .map(|rect| match rect.as_slice() {
            [x, y] => Ok([*x, *y, 1, 1]),
            [x, y, w, h] => Ok([*x, *y, *w, *h]),
            _ => Err(ApiError::Validation(
                "each square or cell must be [x, y] or [x, y, w, h]".to_owned(),
            )),
        })
        .collect()
}

/// One map cell is 256 world squares on B42.
const CELL_SQUARES: i32 = 256;

/// World-square rects a job will paint. Cells are expanded; squares pass through.
pub fn world_rects(squares: &serde_json::Value, cells: &serde_json::Value) -> Vec<[i32; 4]> {
    let mut out = json_rects(squares);
    for [x, y, w, h] in json_rects(cells) {
        out.push([
            x * CELL_SQUARES,
            y * CELL_SQUARES,
            w * CELL_SQUARES,
            h * CELL_SQUARES,
        ]);
    }
    out
}

fn json_rects(value: &serde_json::Value) -> Vec<[i32; 4]> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Some(nums) = item.as_array() else {
            continue;
        };
        let ints: Vec<i32> = nums
            .iter()
            .filter_map(|n| n.as_i64().map(|v| v as i32))
            .collect();
        match ints.as_slice() {
            [x, y] => out.push([*x, *y, 1, 1]),
            [x, y, w, h] if *w > 0 && *h > 0 => out.push([*x, *y, *w, *h]),
            _ => {}
        }
    }
    out
}

pub async fn active_world_rects(db: &PgPool) -> Result<Vec<[i32; 4]>, sqlx::Error> {
    let rows: Vec<(serde_json::Value, serde_json::Value)> = sqlx::query_as(
        r#"SELECT squares, cells FROM map_tile_jobs
           WHERE status IN ('queued', 'running')"#,
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .flat_map(|(squares, cells)| world_rects(&squares, &cells))
        .collect())
}

fn format_rects(rects: &[[i32; 4]]) -> String {
    rects
        .iter()
        .map(|[x, y, w, h]| format!("{x},{y},{w},{h}"))
        .collect::<Vec<_>>()
        .join(";")
}

/// Docker `HostConfig.Binds` sources are resolved on the host. Relative
/// paths from the API container (`./data/server`) silently bind the wrong
/// place, so enqueue refuses them.
fn is_docker_bind_source(s: &str) -> bool {
    if s.starts_with('/') {
        return true;
    }
    let mut chars = s.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(drive), Some(':'), Some('/' | '\\')) if drive.is_ascii_alphabetic()
    )
}

pub(crate) fn require_absolute_binds(state: &AppState) -> ApiResult<()> {
    if is_docker_bind_source(&state.config.pz_server_host)
        && is_docker_bind_source(&state.config.pz_texturepacks_host)
        && is_docker_bind_source(&state.config.map_tiles_host)
        && is_docker_bind_source(&state.config.pz_data_host)
    {
        return Ok(());
    }

    Err(ApiError::Validation(
        "PZ_SERVER_HOST, PZ_TEXTUREPACKS_HOST, PZ_MAP_TILES_HOST, and PZ_DATA_HOST must be absolute host paths for the API".to_owned(),
    ))
}

pub async fn enqueue(
    state: &AppState,
    squares: Vec<Vec<i32>>,
    cells: Vec<Vec<i32>>,
) -> ApiResult<Job> {
    let (squares, cells) = normalize(&squares, &cells)?;
    require_absolute_binds(state)?;

    match inspect_container(&state.config.docker_proxy_url).await {
        Some(200) => {
            return Err(ApiError::Conflict {
                field: "job",
                message: "a map tile job is already running".to_owned(),
            });
        }
        Some(404) => {
            sqlx::query(
                r#"UPDATE map_tile_jobs
                   SET status = 'failed', error = 'container gone', finished_at = now()
                   WHERE status IN ('queued', 'running')"#,
            )
            .execute(&state.db)
            .await?;
        }
        _ => {}
    }

    let id: Uuid = sqlx::query_scalar(
        r#"INSERT INTO map_tile_jobs (squares, cells, status)
           VALUES ($1, $2, 'queued')
           RETURNING id"#,
    )
    .bind(serde_json::json!(squares))
    .bind(serde_json::json!(cells))
    .fetch_one(&state.db)
    .await?;

    tokio::spawn(run_job(state.clone(), id, squares, cells));

    get(&state.db, id).await
}

pub async fn get(db: &PgPool, id: Uuid) -> ApiResult<Job> {
    sqlx::query_as::<_, Job>(
        r#"SELECT id, squares, cells, status, error, tiles_replaced,
                  created_at, started_at, finished_at
           FROM map_tile_jobs WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or(ApiError::NotFound)
}

async fn inspect_container(proxy: &str) -> Option<u16> {
    let url = format!(
        "{}/containers/{CONTAINER}/json",
        proxy.trim_end_matches('/')
    );
    match http_client(INSPECT_TIMEOUT).get(url).send().await {
        Ok(response) => Some(response.status().as_u16()),
        Err(_) => None,
    }
}

async fn run_job(state: AppState, id: Uuid, squares: Vec<[i32; 4]>, cells: Vec<[i32; 4]>) {
    if let Err(error) = spawn_and_wait(&state, id, &squares, &cells).await {
        tracing::error!(%id, %error, "map tile job failed");
        fail(&state.db, id, error).await;
    }
}

async fn spawn_and_wait(
    state: &AppState,
    id: Uuid,
    squares: &[[i32; 4]],
    cells: &[[i32; 4]],
) -> Result<(), String> {
    sqlx::query(
        r#"UPDATE map_tile_jobs
           SET status = 'running', started_at = now()
           WHERE id = $1"#,
    )
    .bind(id)
    .execute(&state.db)
    .await
    .map_err(|error| error.to_string())?;

    let proxy = state.config.docker_proxy_url.trim_end_matches('/');
    let client = http_client(INSPECT_TIMEOUT);
    let body = serde_json::json!({
        "Image": state.config.map_tiles_image,
        "Env": [
            format!("PZ_MAP_SQUARES={}", format_rects(squares)),
            format!("PZ_MAP_CELLS={}", format_rects(cells)),
            format!("PZ_GAME_VERSION={}", state.config.pz_game_version),
            format!("PZ_SAVE_GAME={}", state.config.pz_save_game),
            format!("PZ_SERVER_NAME={}", state.config.server_name),
            // Regional jobs write z21 for these cells. A full county of z21
            // is tens of GB; this is how it accumulates, one job at a time.
            "PZ_MAP_DETAIL=21".to_owned(),
            // Paint the live save on top of vanilla for those cells.
            "PZ_MAP_SAVE=1".to_owned(),
        ],
        "HostConfig": renderer_host_config(
            &state.config.pz_server_host,
            &state.config.pz_texturepacks_host,
            &state.config.map_tiles_host,
            &state.config.pz_data_host,
            &state.config.map_tiles_volume,
        ),
    });

    let create = client
        .post(format!("{proxy}/containers/create?name={CONTAINER}"))
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let create_status = create.status();
    if create_status.as_u16() == 409 {
        return Err("a map tile job is already running".to_owned());
    }
    if !create_status.is_success() {
        let text = create.text().await.unwrap_or_default();
        return Err(format!("docker create failed ({create_status}): {text}"));
    }

    let start = client
        .post(format!("{proxy}/containers/{CONTAINER}/start"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let start_status = start.status();
    // 304: already running.
    if !start_status.is_success() && start_status.as_u16() != 304 {
        let text = start.text().await.unwrap_or_default();
        remove_container(proxy).await;
        return Err(format!("docker start failed ({start_status}): {text}"));
    }

    let wait_outcome = wait_container(proxy).await;
    let logs = container_logs(proxy).await;
    remove_container(proxy).await;

    let wait_body = wait_outcome?;
    if wait_body.status_code == 0 {
        sqlx::query(
            r#"UPDATE map_tile_jobs
               SET status = 'done', finished_at = now()
               WHERE id = $1"#,
        )
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(|error| error.to_string())?;
        let save = crate::services::map_tile_world::save_dir(
            &state.config.data_path,
            &state.config.pz_save_game,
        );
        if let Err(error) =
            crate::services::map_tile_world::mark_seen(&state.db, &save, cells).await
        {
            tracing::warn!(%id, %error, "map tile chunk mtimes not updated");
        }
        return Ok(());
    }

    Err(exit_message(wait_body.status_code, &logs))
}

async fn wait_container(proxy: &str) -> Result<WaitBody, String> {
    let wait = http_client(WAIT_TIMEOUT)
        .post(format!("{proxy}/containers/{CONTAINER}/wait"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !wait.status().is_success() {
        let status = wait.status();
        let text = wait.text().await.unwrap_or_default();
        return Err(format!("docker wait failed ({status}): {text}"));
    }
    wait.json().await.map_err(|error| error.to_string())
}

async fn container_logs(proxy: &str) -> Vec<String> {
    let url = format!("{proxy}/containers/{CONTAINER}/logs?stdout=1&stderr=1&tail=50");
    let Ok(response) = http_client(INSPECT_TIMEOUT).get(url).send().await else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let Ok(raw) = response.bytes().await else {
        return Vec::new();
    };
    pz_bridge::parse_docker_logs(&raw)
}

async fn remove_container(proxy: &str) {
    let url = format!("{proxy}/containers/{CONTAINER}?force=true");
    if let Err(error) = http_client(INSPECT_TIMEOUT).delete(&url).send().await {
        tracing::warn!(%error, "map-tiles container could not be removed");
    }
}

fn exit_message(code: i32, logs: &[String]) -> String {
    if logs.is_empty() {
        format!("map-tiles container exited {code}")
    } else {
        logs.join("\n")
    }
}

async fn fail(db: &PgPool, id: Uuid, error: String) {
    if let Err(err) = sqlx::query(
        r#"UPDATE map_tile_jobs
           SET status = 'failed', error = $2, finished_at = now()
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(error)
    .execute(db)
    .await
    {
        tracing::error!(%id, %err, "map tile job row could not be marked failed");
    }
}

/// Scratch (`/out`) stays on the host bind; the live pack is the named volume
/// at `/pack`, the same volume web-api reads. They have to be the same file
/// or a region job updates a pack nobody is serving.
fn renderer_host_config(
    pz_server_host: &str,
    pz_texturepacks_host: &str,
    map_tiles_host: &str,
    pz_data_host: &str,
    map_tiles_volume: &str,
) -> serde_json::Value {
    let saves = if pz_data_host.ends_with('/') || pz_data_host.ends_with('\\') {
        format!("{pz_data_host}Saves:/saves:ro")
    } else {
        format!("{pz_data_host}/Saves:/saves:ro")
    };
    serde_json::json!({
        "Binds": [
            format!("{pz_server_host}:/pz:ro"),
            format!("{pz_texturepacks_host}:/pz/media/texturepacks:ro"),
            format!("{map_tiles_host}:/out"),
            saves,
        ],
        "Mounts": [{
            "Type": "volume",
            "Source": map_tiles_volume,
            "Target": "/pack",
        }],
        "ShmSize": SHM_SIZE,
        "AutoRemove": false,
    })
}

fn http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
struct WaitBody {
    #[serde(rename = "StatusCode", default)]
    status_code: i32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_enqueue_is_validation() {
        assert!(normalize(&[], &[]).is_err());
    }

    #[test]
    fn world_rects_expand_cells_to_squares() {
        let squares = serde_json::json!([[100, 200, 10, 10]]);
        let cells = serde_json::json!([[34, 30, 1, 1], [40, 12]]);
        assert_eq!(
            world_rects(&squares, &cells),
            vec![[100, 200, 10, 10], [8704, 7680, 256, 256], [10240, 3072, 256, 256]]
        );
    }

    #[test]
    fn world_rects_ignore_junk() {
        assert!(world_rects(&serde_json::json!({}), &serde_json::json!([1, 2, 3])).is_empty());
    }

    #[test]
    fn two_number_rect_becomes_1x1() {
        assert_eq!(
            normalize(&[vec![34, 30]], &[]).unwrap().0,
            vec![[34, 30, 1, 1]]
        );
    }

    #[test]
    fn env_rects_are_semicolon_joined() {
        assert_eq!(format_rects(&[[34, 30, 1, 1]]), "34,30,1,1");
        assert_eq!(
            format_rects(&[[1, 2, 3, 4], [5, 6, 7, 8]]),
            "1,2,3,4;5,6,7,8"
        );
    }

    #[test]
    fn docker_bind_source_must_be_absolute() {
        assert!(is_docker_bind_source("/data/server"));
        assert!(is_docker_bind_source("C:\\data\\server"));
        assert!(is_docker_bind_source("C:/data/server"));
        assert!(is_docker_bind_source("d:/map-tiles"));
        assert!(is_docker_bind_source("//c/Users/asp3x/data"));
        assert!(!is_docker_bind_source("./data/server"));
        assert!(!is_docker_bind_source("data/server"));
        assert!(!is_docker_bind_source("C:foo"));
        assert!(!is_docker_bind_source(""));
    }

    #[test]
    fn job_service_entry_points_exist() {
        let _ = (enqueue, get);
    }

    #[test]
    fn renderer_mounts_the_pack_volume_and_keeps_scratch_on_the_bind() {
        let host = renderer_host_config(
            "/data/server",
            "/data/tex",
            "/data/map-tiles",
            "/data/zomboid",
            "pz-map-tiles-sqlite",
        );
        assert_eq!(host["Binds"][2], "/data/map-tiles:/out");
        assert_eq!(host["Binds"][3], "/data/zomboid/Saves:/saves:ro");
        assert_eq!(host["Mounts"][0]["Type"], "volume");
        assert_eq!(host["Mounts"][0]["Source"], "pz-map-tiles-sqlite");
        assert_eq!(host["Mounts"][0]["Target"], "/pack");
    }
}
