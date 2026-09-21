use crate::{Error, Result, fetch, file_id, native, path::PathRecord, string_field};
use std::path::PathBuf;
use zvec_rust::{Collection, Doc};

/// File identity and losslessly decoded workspace-relative path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileRecord {
    pub id: u32,
    pub relative_path: PathBuf,
}

impl FileRecord {
    /// Decodes file identity and its native path projection.
    ///
    /// # Errors
    /// Rejects missing fields, mismatched keys, malformed or non-relative paths.
    pub fn from_doc(doc: &Doc) -> Result<Self> {
        let id = file_id(doc)?;
        if doc.get_pk() != Some(format!("f{id}").as_str()) {
            return Err(Error::Storage(
                "file identity differs from its primary key".into(),
            ));
        }
        let path: PathRecord = serde_json::from_str(&string_field(doc, "path")?)
            .map_err(|error| Error::Storage(format!("cannot decode identity path: {error}")))?;
        let relative_path = path.into_path()?;
        crate::path::validate_relative(&relative_path)?;
        Ok(Self { id, relative_path })
    }
}

/// Reads file identities through the existing files collection.
pub struct FileReader<'a> {
    collection: &'a Collection,
}

impl<'a> FileReader<'a> {
    /// Borrows the engine's files collection.
    #[must_use]
    pub const fn new(collection: &'a Collection) -> Self {
        Self { collection }
    }

    /// Looks up one path without loading file payloads or scanning the workspace.
    ///
    /// # Errors
    /// Returns native read errors or invalid identity/path data.
    pub fn get(&self, id: u32) -> Result<Option<FileRecord>> {
        let docs = fetch(
            self.collection,
            &[format!("f{id}")],
            Some(&["file_id", "path"]),
        )?;
        docs.first().map(FileRecord::from_doc).transpose()
    }

    /// Lists file identities and paths without loading payloads.
    ///
    /// # Errors
    /// Returns native iteration errors or invalid identity/path data.
    pub fn list(&self) -> Result<Vec<FileRecord>> {
        native(
            self.collection
                .iter_with_options(Some(&["file_id", "path"]), false),
            "iterate source paths",
        )?
        .map(|doc| FileRecord::from_doc(&native(doc, "read source path")?))
        .collect()
    }
}
