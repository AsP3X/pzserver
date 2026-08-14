//! Public and admin news.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use uuid::Uuid;

use crate::error::ApiResult;
use crate::extract::AdminUser;
use crate::services::news::{self, NewsPatch, NewsPost, NewsSummary};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/news", get(public_list))
        .route("/news/{slug}", get(public_show))
        .route("/admin/news", get(admin_list).post(create_post))
        .route(
            "/admin/news/{id}",
            axum::routing::patch(update_post).delete(delete_post),
        )
}

async fn public_list(State(state): State<AppState>) -> ApiResult<Json<Vec<NewsSummary>>> {
    Ok(Json(news::list_public(&state.db, 40).await?))
}

async fn public_show(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> ApiResult<Json<NewsPost>> {
    Ok(Json(news::get_public(&state.db, &slug).await?))
}

async fn admin_list(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<NewsPost>>> {
    Ok(Json(news::list_admin(&state.db).await?))
}

async fn create_post(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    Json(body): Json<NewsPatch>,
) -> ApiResult<(StatusCode, Json<NewsPost>)> {
    Ok((
        StatusCode::CREATED,
        Json(news::create(&state.db, user.id, body).await?),
    ))
}

async fn update_post(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<NewsPatch>,
) -> ApiResult<Json<NewsPost>> {
    Ok(Json(news::update(&state.db, id, body).await?))
}

async fn delete_post(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    news::delete(&state.db, id).await?;
    Ok(Json(serde_json::json!({ "message": "Post deleted." })))
}
