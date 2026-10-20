//! Storage operations used by indexing, with a small seam for pipeline tests.

use std::path::PathBuf;

use crate::{
    EngineResult,
    domain::{FileId, FileRecord},
    storage::{IndexStore, types::FileWrite},
};

pub(crate) trait IndexStorage: Send + Sync {
    fn is_read_only(&self) -> bool;
    fn list_files(&self) -> EngineResult<Vec<FileRecord>>;
    fn resolve_file_ids(&self, paths: &[PathBuf]) -> EngineResult<Vec<FileId>>;
    fn replace_files(&self, writes: &[FileWrite<'_>]) -> EngineResult<()>;
    fn delete_files(&self, file_ids: &[FileId]) -> EngineResult<()>;
    fn finalize_writes(&self) -> EngineResult<()>;
}

impl IndexStorage for IndexStore {
    fn is_read_only(&self) -> bool {
        self.is_read_only()
    }

    fn list_files(&self) -> EngineResult<Vec<FileRecord>> {
        self.list_files()
    }

    fn resolve_file_ids(&self, paths: &[PathBuf]) -> EngineResult<Vec<FileId>> {
        self.resolve_file_ids(paths)
    }

    fn replace_files(&self, writes: &[FileWrite<'_>]) -> EngineResult<()> {
        self.replace_files(writes)
    }

    fn delete_files(&self, file_ids: &[FileId]) -> EngineResult<()> {
        self.delete_files(file_ids)
    }

    fn finalize_writes(&self) -> EngineResult<()> {
        self.finalize_writes()
    }
}
