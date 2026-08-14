//! Server news. Drafts stay off the public list until published_at is set
//! and not in the future.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct NewsPost {
    pub id: Uuid,
    pub slug: String,
    pub title: String,
    pub excerpt: Option<String>,
    pub body: String,
    pub pinned: bool,
    pub published_at: Option<DateTime<Utc>>,
    pub author_id: Option<Uuid>,
    pub author: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NewsSummary {
    pub id: Uuid,
    pub slug: String,
    pub title: String,
    pub excerpt: Option<String>,
    pub pinned: bool,
    pub published_at: Option<DateTime<Utc>>,
    pub author: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NewsPatch {
    pub title: Option<String>,
    pub excerpt: Option<Option<String>>,
    pub body: Option<String>,
    pub pinned: Option<bool>,
    pub published: Option<bool>,
}

macro_rules! news_sql {
    ($tail:literal) => {
        concat!(
            "SELECT n.id, n.slug, n.title, n.excerpt, n.body, n.pinned, \
             n.published_at, n.author_id, u.username AS author, \
             n.created_at, n.updated_at \
             FROM news_posts n \
             LEFT JOIN users u ON u.id = n.author_id ",
            $tail
        )
    };
}

pub async fn list_public(db: &PgPool, limit: i64) -> Result<Vec<NewsSummary>, sqlx::Error> {
    let rows = sqlx::query_as::<_, NewsPost>(news_sql!(
        "WHERE n.published_at IS NOT NULL AND n.published_at <= now() \
         ORDER BY n.pinned DESC, n.published_at DESC \
         LIMIT $1"
    ))
    .bind(limit.clamp(1, 50))
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(summary).collect())
}

pub async fn get_public(db: &PgPool, slug: &str) -> ApiResult<NewsPost> {
    let row = sqlx::query_as::<_, NewsPost>(news_sql!(
        "WHERE n.slug = $1 \
           AND n.published_at IS NOT NULL \
           AND n.published_at <= now()"
    ))
    .bind(slug.trim())
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::Validation("That post is not published.".to_owned()))?;
    Ok(row)
}

pub async fn list_admin(db: &PgPool) -> Result<Vec<NewsPost>, sqlx::Error> {
    sqlx::query_as::<_, NewsPost>(news_sql!(
        "ORDER BY n.pinned DESC, COALESCE(n.published_at, n.created_at) DESC"
    ))
    .fetch_all(db)
    .await
}

pub async fn create(db: &PgPool, author_id: Uuid, patch: NewsPatch) -> ApiResult<NewsPost> {
    let title = require_title(patch.title.as_deref())?;
    let body = require_body(patch.body.as_deref())?;
    let excerpt = clean_excerpt(patch.excerpt.flatten().as_deref(), &body);
    let slug = unique_slug(db, &title, None).await?;
    let published_at = if patch.published.unwrap_or(false) {
        Some(Utc::now())
    } else {
        None
    };
    let id: Uuid = sqlx::query_scalar(
        r#"INSERT INTO news_posts
            (slug, title, excerpt, body, pinned, published_at, author_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id"#,
    )
    .bind(&slug)
    .bind(title)
    .bind(excerpt)
    .bind(body)
    .bind(patch.pinned.unwrap_or(false))
    .bind(published_at)
    .bind(author_id)
    .fetch_one(db)
    .await?;
    get_admin(db, id).await
}

pub async fn update(db: &PgPool, id: Uuid, patch: NewsPatch) -> ApiResult<NewsPost> {
    let current = get_admin(db, id).await?;
    let title = match patch.title {
        Some(value) => require_title(Some(&value))?.to_owned(),
        None => current.title.clone(),
    };
    let body = match patch.body {
        Some(value) => require_body(Some(&value))?.to_owned(),
        None => current.body.clone(),
    };
    let excerpt = match patch.excerpt {
        Some(value) => clean_excerpt(value.as_deref(), &body),
        None => current.excerpt.clone(),
    };
    let slug = if title != current.title {
        unique_slug(db, &title, Some(id)).await?
    } else {
        current.slug.clone()
    };
    let published_at = match patch.published {
        Some(true) => Some(current.published_at.unwrap_or_else(Utc::now)),
        Some(false) => None,
        None => current.published_at,
    };
    sqlx::query(
        r#"UPDATE news_posts SET
            slug = $2, title = $3, excerpt = $4, body = $5, pinned = $6,
            published_at = $7, updated_at = now()
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(&slug)
    .bind(&title)
    .bind(&excerpt)
    .bind(&body)
    .bind(patch.pinned.unwrap_or(current.pinned))
    .bind(published_at)
    .execute(db)
    .await?;
    get_admin(db, id).await
}

pub async fn delete(db: &PgPool, id: Uuid) -> ApiResult<()> {
    let result = sqlx::query("DELETE FROM news_posts WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::Validation("That post is gone.".to_owned()));
    }
    Ok(())
}

async fn get_admin(db: &PgPool, id: Uuid) -> ApiResult<NewsPost> {
    sqlx::query_as::<_, NewsPost>(news_sql!("WHERE n.id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| ApiError::Validation("That post is gone.".to_owned()))
}

async fn unique_slug(db: &PgPool, title: &str, ignore: Option<Uuid>) -> Result<String, sqlx::Error> {
    let base = slugify(title);
    let mut slug = base.clone();
    let mut n = 2;
    loop {
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM news_posts WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2))",
        )
        .bind(&slug)
        .bind(ignore)
        .fetch_one(db)
        .await?;
        if !taken {
            return Ok(slug);
        }
        slug = format!("{base}-{n}");
        n += 1;
    }
}

fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "post".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn require_title(raw: Option<&str>) -> ApiResult<&str> {
    let title = raw.map(str::trim).filter(|value| !value.is_empty()).ok_or_else(|| {
        ApiError::Validation("Give the post a title.".to_owned())
    })?;
    if title.len() > 160 {
        return Err(ApiError::Validation("Title must be at most 160 characters.".to_owned()));
    }
    Ok(title)
}

fn require_body(raw: Option<&str>) -> ApiResult<&str> {
    let body = raw.map(str::trim).filter(|value| !value.is_empty()).ok_or_else(|| {
        ApiError::Validation("Write the post.".to_owned())
    })?;
    if body.len() > 40_000 {
        return Err(ApiError::Validation("The post is too long.".to_owned()));
    }
    Ok(body)
}

fn clean_excerpt(raw: Option<&str>, body: &str) -> Option<String> {
    let excerpt = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(280).collect::<String>());
    excerpt.or_else(|| {
        let trimmed = body.chars().take(180).collect::<String>();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn summary(post: NewsPost) -> NewsSummary {
    NewsSummary {
        id: post.id,
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt,
        pinned: post.pinned,
        published_at: post.published_at,
        author: post.author,
    }
}
