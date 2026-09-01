//! Rebuild `live.bin` when save chunks are newer than the last overlay.
//!
//! Parsing B42 chunks needs pzdataspec, which lives in the map-tiles image.
//! This module only decides when to run that job and serves the file the
//! baker writes. GET handlers must not wait on Docker.

use std::time::{Duration, UNIX_EPOCH};

use crate::services::map_tile_world;
use crate::state::AppState;

const CONTAINER: &str = "pz-map-sprite-live";
const INSPECT: Duration = Duration::from_secs(5);
const WAIT: Duration = Duration::from_secs(120);

pub fn overlay_is_stale(state: &AppState) -> bool {
    let save = map_tile_world::save_dir(&state.config.data_path, &state.config.pz_save_game);
    let newest = newest_chunk_mtime(&save);
    let overlay = overlay_mtime(state.map_sprites.live_path());
    match (newest, overlay) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(chunk), Some(file)) => chunk > file + 1_000,
    }
}

pub async fn refresh_if_stale(state: &AppState) {
    if !state.map_sprites.meta().ready {
        return;
    }
    if !overlay_is_stale(state) {
        return;
    }
    let Ok(_guard) = state.sprite_live.try_lock() else {
        return;
    };
    if let Err(error) = run_overlay(state).await {
        tracing::warn!(%error, "sprite live overlay not rebuilt");
    }
}

async fn run_overlay(state: &AppState) -> Result<(), String> {
    let proxy = state.config.docker_proxy_url.trim_end_matches('/');
    let client = http_client(INSPECT);
    let save_in_container = format!(
        "/saves/{}",
        state.config.pz_save_game.replace('\\', "/")
    );
    let body = serde_json::json!({
        "Image": state.config.map_tiles_image,
        "Entrypoint": ["python", "/tools/map_sprites/live_overlay.py"],
        "Cmd": [
            "--save", save_in_container,
            "--sprites", "/sprites/sprites.sqlite",
            "--out", "/sprites/live.bin",
            "--pz", "/pz",
        ],
        "Env": [
            format!("PZ_SAVE_GAME={}", state.config.pz_save_game),
            "PYTHONPATH=/tools:/opt/pzmap2dzi:/opt",
            "PYTHONUNBUFFERED=1",
        ],
        "HostConfig": host_config(state),
    });

    let create = client
        .post(format!("{proxy}/containers/create?name={CONTAINER}"))
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = create.status();
    if status.as_u16() == 409 {
        return Ok(());
    }
    if !status.is_success() {
        let text = create.text().await.unwrap_or_default();
        return Err(format!("docker create failed ({status}): {text}"));
    }
    let start = client
        .post(format!("{proxy}/containers/{CONTAINER}/start"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let start_status = start.status();
    if !start_status.is_success() && start_status.as_u16() != 304 {
        let text = start.text().await.unwrap_or_default();
        remove(proxy).await;
        return Err(format!("docker start failed ({start_status}): {text}"));
    }
    let wait = http_client(WAIT)
        .post(format!("{proxy}/containers/{CONTAINER}/wait"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let code = wait
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|body| body.get("StatusCode")?.as_i64())
        .unwrap_or(-1);
    remove(proxy).await;
    if code == 0 {
        tracing::info!("sprite live overlay rebuilt");
        Ok(())
    } else {
        Err(format!("live overlay container exited {code}"))
    }
}

fn host_config(state: &AppState) -> serde_json::Value {
    let data = &state.config.pz_data_host;
    let saves = if data.ends_with('/') || data.ends_with('\\') {
        format!("{data}Saves:/saves:ro")
    } else {
        format!("{data}/Saves:/saves:ro")
    };
    serde_json::json!({
        "Binds": [
            format!("{}:/pz:ro", state.config.pz_server_host),
            saves,
        ],
        "Mounts": [{
            "Type": "volume",
            "Source": state.config.map_sprites_volume,
            "Target": "/sprites",
        }],
        "AutoRemove": false,
    })
}

async fn remove(proxy: &str) {
    let url = format!("{proxy}/containers/{CONTAINER}?force=true");
    let _ = http_client(INSPECT).delete(&url).send().await;
}

fn http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_default()
}

fn newest_chunk_mtime(save: &std::path::Path) -> Option<i64> {
    map_tile_world::cell_mtimes(save).into_values().max()
}

fn overlay_mtime(path: &std::path::Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(
        modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
    )
}
