//! Public locale catalogs and the admin translation editor.

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};

use crate::error::ApiResult;
use crate::extract::AdminUser;
use crate::services::i18n::{
    self, Catalog, Language, LanguagePatch, TranslationClear, TranslationImport, TranslationPut,
};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/i18n/languages", get(public_languages))
        .route("/i18n/{locale}", get(public_overrides))
        .route("/admin/languages", get(admin_languages).post(create_language))
        .route(
            "/admin/languages/{code}",
            axum::routing::patch(update_language).delete(delete_language),
        )
        .route(
            "/admin/translations",
            get(admin_catalog)
                .put(put_translation)
                .delete(clear_translation),
        )
        .route("/admin/translations/import", put(import_translations))
        .route("/admin/translations/export/{locale}", get(export_translations))
}

async fn public_languages(State(state): State<AppState>) -> ApiResult<Json<Vec<Language>>> {
    Ok(Json(i18n::languages(&state.db, true).await?))
}

async fn public_overrides(
    State(state): State<AppState>,
    Path(locale): Path<String>,
) -> ApiResult<Json<BTreeMap<String, String>>> {
    Ok(Json(i18n::overrides(&state.db, &locale).await?))
}

async fn admin_languages(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<Language>>> {
    Ok(Json(i18n::languages(&state.db, false).await?))
}

async fn create_language(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<LanguagePatch>,
) -> ApiResult<(StatusCode, Json<Language>)> {
    Ok((
        StatusCode::CREATED,
        Json(i18n::create_language(&state.db, body).await?),
    ))
}

async fn update_language(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(code): Path<String>,
    Json(body): Json<LanguagePatch>,
) -> ApiResult<Json<Language>> {
    Ok(Json(i18n::update_language(&state.db, &code, body).await?))
}

async fn delete_language(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(code): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    i18n::delete_language(&state.db, &code).await?;
    Ok(Json(serde_json::json!({ "message": "Language removed." })))
}

async fn admin_catalog(State(state): State<AppState>, _staff: AdminUser) -> ApiResult<Json<Catalog>> {
    Ok(Json(i18n::catalog(&state.db).await?))
}

async fn put_translation(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<TranslationPut>,
) -> ApiResult<Json<serde_json::Value>> {
    i18n::put(&state.db, body).await?;
    Ok(Json(serde_json::json!({ "message": "Saved." })))
}

async fn clear_translation(
    State(state): State<AppState>,
    _staff: AdminUser,
    Query(body): Query<TranslationClear>,
) -> ApiResult<Json<serde_json::Value>> {
    i18n::clear(&state.db, body).await?;
    Ok(Json(serde_json::json!({ "message": "Override removed." })))
}

async fn import_translations(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<TranslationImport>,
) -> ApiResult<Json<serde_json::Value>> {
    let count = i18n::import(&state.db, body).await?;
    Ok(Json(serde_json::json!({
        "message": format!("{count} strings imported."),
        "count": count,
    })))
}

async fn export_translations(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(locale): Path<String>,
) -> ApiResult<Json<BTreeMap<String, String>>> {
    Ok(Json(i18n::overrides(&state.db, &locale).await?))
}
