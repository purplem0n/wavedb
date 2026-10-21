use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    /// Underlying storage engine failure.
    #[error("storage error: {0}")]
    Storage(String),
    /// Optimistic concurrency conflict: another transaction committed first.
    #[error("transaction conflict: {0}")]
    Conflict(String),
    /// SQL parse / unsupported syntax.
    #[error("sql error: {0}")]
    Sql(String),
    /// Constraint violation (unique, not null, type).
    #[error("constraint violation: {0}")]
    Constraint(String),
    /// Missing table / column / index.
    #[error("not found: {0}")]
    NotFound(String),
    /// Invalid request.
    #[error("invalid: {0}")]
    Invalid(String),
    /// Transaction was already committed or rolled back.
    #[error("transaction is closed")]
    Closed,
}

impl Error {
    /// Stable machine-readable error code (surfaced to JS as a prefix).
    pub fn code(&self) -> &'static str {
        match self {
            Error::Storage(_) => "WAVE_STORAGE",
            Error::Conflict(_) => "WAVE_CONFLICT",
            Error::Sql(_) => "WAVE_SQL",
            Error::Constraint(_) => "WAVE_CONSTRAINT",
            Error::NotFound(_) => "WAVE_NOT_FOUND",
            Error::Invalid(_) => "WAVE_INVALID",
            Error::Closed => "WAVE_CLOSED",
        }
    }
}

impl From<fjall::Error> for Error {
    fn from(e: fjall::Error) -> Self {
        Error::Storage(e.to_string())
    }
}

impl From<fjall::LsmError> for Error {
    fn from(e: fjall::LsmError) -> Self {
        Error::Storage(e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Invalid(format!("json: {e}"))
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Storage(e.to_string())
    }
}
