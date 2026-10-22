//! Restricted reference access under the same lock as canonical file updates.
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use super::{StoreState, graph_error};
use crate::{
    EngineResult,
    domain::{EntityId, FileId, FileRecord},
    storage::{
        graph::{PendingRefPage, Resolution, ResolutionStats},
        path::query_path,
    },
};

/// A resolver may read visible references and submit decisions for those refs.
/// File mutation and raw storage handles are deliberately unavailable.
// These methods are reserved for the subsequent resolver integration.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) trait ResolutionSession {
    fn list_pending_refs(&mut self, limit: usize, cursor: i64) -> EngineResult<PendingRefPage>;
    /// Unicode projection of an Indexed file's path; non-Unicode paths return None.
    fn file_path(&self, file_id: u32) -> EngineResult<Option<String>>;
    fn file_id_by_path(&self, path: &str) -> EngineResult<Option<u32>>;
    fn apply_resolutions(&mut self, resolutions: &[Resolution]) -> EngineResult<ResolutionStats>;
}

pub(super) struct StoreResolutionSession<'a> {
    state: &'a mut StoreState,
    files: HashMap<FileId, FileRecord>,
    paths: HashMap<PathBuf, FileId>,
    issued: HashSet<i64>,
}

impl<'a> StoreResolutionSession<'a> {
    pub(super) fn new(state: &'a mut StoreState) -> EngineResult<Self> {
        let files: HashMap<_, _> = state
            .files
            .list()?
            .into_iter()
            .map(|f| (f.id(), f))
            .collect();
        let paths = files
            .values()
            .filter(|file| file.index_status().is_indexed())
            .map(|file| (file.relative_path().to_path_buf(), file.id()))
            .collect();
        Ok(Self {
            state,
            files,
            paths,
            issued: HashSet::new(),
        })
    }

    fn indexed_file(&self, id: FileId) -> Option<&FileRecord> {
        self.files
            .get(&id)
            .filter(|file| file.index_status().is_indexed())
    }

    fn endpoints(&self, ids: &[String]) -> EngineResult<HashMap<String, FileId>> {
        let entity_ids = ids
            .iter()
            .cloned()
            .map(EntityId::from_string)
            .collect::<Vec<_>>();
        let mut visible: HashMap<_, _> = self
            .state
            .entities
            .fetch(&entity_ids)?
            .into_iter()
            .filter(|(_, entity)| self.indexed_file(entity.file_id()).is_some())
            .map(|(id, entity)| (id.as_str().to_owned(), entity.file_id()))
            .collect();
        for id in ids {
            if let Some(file) = id
                .strip_prefix('f')
                .and_then(|id| id.parse::<u32>().ok())
                .and_then(|id| self.indexed_file(FileId::new(id)))
            {
                visible.insert(format!("f{}", file.id().get()), file.id());
            }
        }
        Ok(visible)
    }
}

impl ResolutionSession for StoreResolutionSession<'_> {
    fn list_pending_refs(&mut self, limit: usize, cursor: i64) -> EngineResult<PendingRefPage> {
        let mut page = self
            .state
            .graph
            .as_ref()
            .expect("writable graph")
            .list_pending_refs(limit, cursor)
            .map_err(graph_error)?;
        let ids = page
            .refs
            .iter()
            .map(|r| r.reference.owner_id.clone())
            .collect::<Vec<_>>();
        let visible = self.endpoints(&ids)?;
        page.refs.retain(|r| {
            visible
                .get(&r.reference.owner_id)
                .is_some_and(|file| file.get() == r.file_id)
        });
        self.issued.extend(page.refs.iter().map(|r| r.id));
        // Keep the SQLite cursor even when all rows in this page are hidden.
        Ok(page)
    }

    fn file_path(&self, file_id: u32) -> EngineResult<Option<String>> {
        Ok(self
            .indexed_file(FileId::new(file_id))
            .and_then(|file| query_path(file.relative_path().as_path())))
    }

    fn file_id_by_path(&self, path: &str) -> EngineResult<Option<u32>> {
        Ok(self.paths.get(Path::new(path)).map(|id| id.get()))
    }

    fn apply_resolutions(&mut self, resolutions: &[Resolution]) -> EngineResult<ResolutionStats> {
        let ids = resolutions
            .iter()
            .map(|r| r.target_id.clone())
            .collect::<Vec<_>>();
        let targets = self.endpoints(&ids)?;
        let valid = resolutions
            .iter()
            .filter(|r| self.issued.contains(&r.ref_id) && targets.contains_key(&r.target_id))
            .cloned()
            .collect::<Vec<_>>();
        // Issued sources stay visible: the session retains the file-update lock.
        let mut stats = self
            .state
            .graph
            .as_mut()
            .expect("writable graph")
            .apply_resolutions(&valid)
            .map_err(graph_error)?;
        stats.stale += resolutions.len() - valid.len();
        Ok(stats)
    }
}
