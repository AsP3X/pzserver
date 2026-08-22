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

fn format_rects(rects: &[[i32; 4]]) -> String {
    rects
        .iter()
        .map(|[x, y, w, h]| format!("{x},{y},{w},{h}"))
        .collect::<Vec<_>>()
        .join(";")
}

pub async fn enqueue(
    state: &AppState,
    squares: Vec<Vec<i32>>,
    cells: Vec<Vec<i32>>,
) -> ApiResult<Job> {
    let (squares, cells) = normalize(&squares, &cells)?;

    if container_present(&state.config.docker_proxy_url).await {
        return Err(ApiError::Conflict {
            field: "job",
            message: "a map tile job is already running".to_owned(),
        });
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

async fn container_present(proxy: &str) -> bool {
    let url = format!(
        "{}/containers/{CONTAINER}/json",
        proxy.trim_end_matches('/')
    );
    match http_client(INSPECT_TIMEOUT).get(url).send().await {
        Ok(response) => response.status().as_u16() == 200,
        Err(_) => false,
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
        ],
        "HostConfig": {
            "Binds": [
                format!("{}:/pz:ro", state.config.pz_server_host),
                format!("{}:/pz/media/texturepacks:ro", state.config.pz_texturepacks_host),
                format!("{}:/out", state.config.map_tiles_host),
            ],
            "ShmSize": SHM_SIZE,
            "AutoRemove": true,
        },
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
        return Err(format!("docker start failed ({start_status}): {text}"));
    }

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

    let wait_body: WaitBody = wait.json().await.map_err(|error| error.to_string())?;
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
        return Ok(());
    }

    Err(exit_error(proxy, wait_body.status_code).await)
}

async fn exit_error(proxy: &str, code: i32) -> String {
    let url = format!("{proxy}/containers/{CONTAINER}/logs?stdout=1&stderr=1&tail=50");
    let Ok(response) = http_client(INSPECT_TIMEOUT).get(url).send().await else {
        return format!("map-tiles container exited {code}");
    };
    if !response.status().is_success() {
        return format!("map-tiles container exited {code}");
    }
    let Ok(raw) = response.bytes().await else {
        return format!("map-tiles container exited {code}");
    };
    let lines = pz_bridge::parse_docker_logs(&raw);
    if lines.is_empty() {
        format!("map-tiles container exited {code}")
    } else {
        lines.join("\n")
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
    fn job_service_entry_points_exist() {
        let _ = (enqueue, get);
    }
}
