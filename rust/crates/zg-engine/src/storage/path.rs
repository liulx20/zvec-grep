//! Lossless identity keys and optional Unicode query projections are separate.

use std::path::{Path, PathBuf};

use crate::{EngineError, EngineResult, domain::SourcePath};

use super::zvec::{native, scalar, wildcard_string};
use crate::domain::{DirectoryId, FileRecord};
pub(super) use zg_storage::path::PathRecord;
use zvec_rust::{CollectionSchema, DataType, Doc};

pub(super) fn encode_path(path: &SourcePath) -> EngineResult<String> {
    // Component collection unifies accepted Windows separator spellings while
    // leaving Unix backslashes and platform-native non-Unicode names intact.
    let canonical: PathBuf = path.components().collect();
    serde_json::to_string(&PathRecord::from_path(&canonical)?).map_err(|error| {
        EngineError::storage_failure(format!("cannot encode identity path: {error}"))
    })
}

pub(super) fn decode_path(value: &str) -> EngineResult<SourcePath> {
    let record: PathRecord = serde_json::from_str(value).map_err(|error| {
        EngineError::storage_failure(format!("cannot decode identity path: {error}"))
    })?;
    SourcePath::new(record.into_path()?)
}

/// Hex preserves the full native representation and needs no SQL escaping.
pub(super) fn path_key(path: &SourcePath) -> EngineResult<String> {
    Ok(hex::encode(encode_path(path)?.as_bytes()))
}

/// This projection accelerates path matching; it never establishes identity.
pub(super) fn query_path(path: &Path) -> Option<String> {
    let value = path.to_str()?;
    #[cfg(windows)]
    return Some(value.replace('\\', "/"));
    #[cfg(not(windows))]
    Some(value.to_owned())
}

pub(super) fn file_membership_schema(schema: &mut CollectionSchema) -> EngineResult<()> {
    scalar(
        schema,
        "ancestor_directory_ids",
        DataType::ArrayUint32,
        false,
        true,
    )?;
    wildcard_string(schema, "file_name", false)
}

pub(super) fn file_membership_doc(
    doc: &mut Doc,
    file: &FileRecord,
    directories: &[DirectoryId],
) -> EngineResult<()> {
    native(
        doc.add_array_u32(
            "ancestor_directory_ids",
            &directories.iter().map(|id| id.get()).collect::<Vec<_>>(),
        ),
        "encode ancestor directories",
    )?;
    // Non-Unicode names have no STRING representation. The source-path cache disables name
    // pushdown in this workspace; exact native paths remain in FileRecord.
    let name = file
        .relative_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    native(doc.add_string("file_name", name), "encode file name")?;
    Ok(())
}
