//! Indexed-search adapter for the shared native path predicate compiler.
use super::storage::SearchStorage;
use crate::{EngineResult, domain::GlobRule, storage::types::StoragePathFilter};

pub(super) use crate::storage::path_filter::{all, any, negate};

pub(super) fn compile_path_filter(
    rules: &[GlobRule],
    storage: &dyn SearchStorage,
) -> EngineResult<Option<StoragePathFilter>> {
    crate::storage::path_filter::compile_path_filter(rules, || storage.has_non_unicode_file_names())
}
