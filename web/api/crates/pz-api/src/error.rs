//! One error type for handlers, rendered as a JSON envelope.
//!
//! Note what is *not* in here: the game server being offline. A stopped or
//! unreachable game server is a status this API reports, never an error it
//! returns — see `services::status`.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// No valid session, or the session expired.
    #[error("authentication required")]
    Unauthorized,

    /// Input failed a rule. The message is shown to the user, so it must read
    /// like a sentence and never leak internals.
    #[error("{0}")]
    Validation(String),

    /// A unique field is already taken. Carries the field name so the UI can
    /// attach the message to the right input.
    #[error("{message}")]
    Conflict {
        field: &'static str,
        message: String,
    },

    #[error("too many attempts — try again later")]
    TooManyRequests,

    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// A failure that is ours, not the caller's.
    #[error("internal error: {0}")]
    Internal(String),
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: String,
    /// Which input the message belongs to, when it belongs to one.
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<&'static str>,
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Conflict { .. } => StatusCode::CONFLICT,
            Self::TooManyRequests => StatusCode::TOO_MANY_REQUESTS,
            Self::Database(_) | Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// Stable machine-readable code for the client.
    fn code(&self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Validation(_) => "validation_failed",
            Self::Conflict { .. } => "conflict",
            Self::TooManyRequests => "too_many_requests",
            Self::Database(_) | Self::Internal(_) => "internal_error",
        }
    }

    fn field(&self) -> Option<&'static str> {
        match self {
            Self::Conflict { field, .. } => Some(field),
            _ => None,
        }
    }

    /// What the client is told. Internal failures are deliberately vague —
    /// details go to the log, not to the browser.
    fn public_message(&self) -> String {
        match self {
            Self::Database(_) | Self::Internal(_) => "Something went wrong on our side.".to_owned(),
            other => other.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();

        if status.is_server_error() {
            tracing::error!(error = %self, "request failed");
        } else {
            tracing::debug!(error = %self, "request rejected");
        }

        let body = ErrorBody {
            error: ErrorDetail {
                code: self.code(),
                message: self.public_message(),
                field: self.field(),
            },
        };

        (status, Json(body)).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
