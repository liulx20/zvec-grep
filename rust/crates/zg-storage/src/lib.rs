//! Shared reads of canonical zvec entities and files.
//!
//! Readers borrow the caller's collections. They do not open a second connection,
//! acquire workspace locks, or interpret engine content payloads. Keep the owning
//! workspace session and its read/write coordination active for the entire operation.

mod entities;
mod files;
pub mod path;

pub use entities::{EntityReader, EntityRecord};
pub use files::{FileReader, FileRecord};

use zvec_rust::{Collection, Doc};

/// Errors from shared storage operations.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    InvalidArgument(String),
    #[error("{0}")]
    Storage(String),
}

impl Error {
    pub(crate) fn invalid_argument(message: impl Into<String>) -> Self {
        Self::InvalidArgument(message.into())
    }
}

/// Result of a shared storage operation.
pub type Result<T> = std::result::Result<T, Error>;

const BATCH: usize = 1024;

fn fetch(collection: &Collection, keys: &[String], fields: Option<&[&str]>) -> Result<Vec<Doc>> {
    let mut docs = Vec::new();
    for batch in keys.chunks(BATCH) {
        let keys: Vec<_> = batch.iter().map(String::as_str).collect();
        docs.extend(native(
            collection.fetch_with_options(&keys, fields, false),
            "fetch stored records",
        )?);
    }
    Ok(docs)
}

fn native<T>(value: zvec_rust::Result<T>, operation: &str) -> Result<T> {
    value.map_err(|error| Error::Storage(format!("zvec {operation}: {error}")))
}

fn string_field(doc: &Doc, field: &str) -> Result<String> {
    native(doc.get_string(field), "read stored field")?
        .ok_or_else(|| Error::Storage(format!("stored field {field} is missing")))
}

fn file_id(doc: &Doc) -> Result<u32> {
    native(doc.get_u32("file_id"), "read numeric field")?
        .ok_or_else(|| Error::Storage("missing numeric field".into()))
}
