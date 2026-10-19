//! Restricted resolver access to a coordinated, locked storage snapshot.
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use super::{StoreState, graph_error};
use crate::storage::graph::{
    NameIndexEntry, PendingRefPage, Resolution, ResolutionStats, SqliteGraphStorage,
    StoredPendingRef,
};
use crate::storage::path::query_path;
use crate::{
    EngineResult,
    domain::{EntityId, FileId, FileIndexStatus, FileRecord},
};

/// The resolver can inspect references/candidates and submit decisions, but
/// cannot replace file snapshots, access database handles, or close storage.
pub(crate) trait ResolutionSession {
    fn list_pending_refs(&mut self, limit: usize, cursor: i64) -> EngineResult<PendingRefPage>;
    /// None defers name lookup until the workspace and all candidates are visible.
    fn lookup_candidates(&self, name: &str) -> EngineResult<Option<Vec<NameIndexEntry>>>;
    /// Unicode projection of an Indexed file's path; unrepresentable paths return None.
    fn file_path(&self, file_id: u32) -> EngineResult<Option<String>>;
    fn file_id_by_path(&self, path: &str) -> EngineResult<Option<u32>>;
    /// Existence evidence only, including unfinished modules: temporarily
    /// unavailable local modules must not be classified as external failures.
    fn path_has_module(&self, name: &str, extensions: &[&str]) -> EngineResult<bool>;
    fn imported_file_ids(&self, file_id: u32) -> EngineResult<Vec<u32>>;
    fn apply_resolutions(&mut self, resolutions: &[Resolution]) -> EngineResult<ResolutionStats>;
    fn apply_failures(&mut self, refs: &[i64]) -> EngineResult<usize>;
    fn record_candidates(&mut self, candidates: &[(i64, Vec<String>)]) -> EngineResult<usize>;
}

pub(super) struct StoreResolutionSession<'a> {
    state: &'a mut StoreState,
    issued: HashMap<i64, StoredPendingRef>,
    files: HashMap<FileId, FileRecord>,
    paths: HashMap<PathBuf, FileId>,
    names_available: bool,
}

impl<'a> StoreResolutionSession<'a> {
    pub(super) fn new(state: &'a mut StoreState) -> EngineResult<Self> {
        let files: HashMap<_, _> = state.files.list()?.into_iter().map(|f| (f.id, f)).collect();
        let paths = files
            .values()
            .map(|f| (f.relative_path.to_path_buf(), f.id))
            .collect();
        let names_available = !files.values().any(|file| {
            matches!(
                file.index_status,
                FileIndexStatus::NotIndexed | FileIndexStatus::Deleting
            )
        });
        Ok(Self {
            state,
            names_available,
            files,
            paths,
            issued: HashMap::new(),
        })
    }

    fn graph(&self) -> &SqliteGraphStorage {
        self.state.graph.as_ref().expect("writable graph")
    }

    fn indexed_files(&self, ids: &[FileId]) -> HashMap<FileId, FileRecord> {
        ids.iter()
            .filter_map(|id| {
                self.files
                    .get(id)
                    .filter(|f| f.index_status.is_indexed())
                    .map(|f| (*id, f.clone()))
            })
            .collect()
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
            .filter(|(_, entity)| {
                self.files
                    .get(&entity.file_id)
                    .is_some_and(|f| f.index_status.is_indexed())
            })
            .map(|(id, entity)| (id.as_str().to_owned(), entity.file_id))
            .collect();
        let files: Vec<_> = ids
            .iter()
            .filter_map(|id| id.strip_prefix('f')?.parse::<u32>().ok().map(FileId::new))
            .collect();
        for file in self.indexed_files(&files).into_values() {
            visible.insert(format!("f{}", file.id.get()), file.id);
        }
        Ok(visible)
    }

    fn eligible_refs(&self, ids: impl IntoIterator<Item = i64>) -> EngineResult<HashSet<i64>> {
        let refs: Vec<_> = ids
            .into_iter()
            .filter_map(|id| self.issued.get(&id))
            .collect();
        let sources: Vec<_> = refs.iter().map(|r| r.reference.owner_id.clone()).collect();
        let visible = self.endpoints(&sources)?;
        Ok(refs
            .into_iter()
            .filter(|r| {
                visible
                    .get(&r.reference.owner_id)
                    .is_some_and(|file| file.get() == r.file_id)
            })
            .map(|r| r.id)
            .collect())
    }
}

impl ResolutionSession for StoreResolutionSession<'_> {
    fn list_pending_refs(&mut self, limit: usize, cursor: i64) -> EngineResult<PendingRefPage> {
        let mut page = self
            .graph()
            .list_pending_refs(limit, cursor)
            .map_err(graph_error)?;
        let ids: Vec<_> = page
            .refs
            .iter()
            .map(|r| r.reference.owner_id.clone())
            .collect();
        let visible = self.endpoints(&ids)?;
        page.refs.retain(|r| {
            visible
                .get(&r.reference.owner_id)
                .is_some_and(|file| file.get() == r.file_id)
        });
        self.issued
            .extend(page.refs.iter().map(|r| (r.id, r.clone())));
        // Preserve the underlying cursor even when the entire page is hidden.
        Ok(page)
    }

    fn lookup_candidates(&self, name: &str) -> EngineResult<Option<Vec<NameIndexEntry>>> {
        // An unfinished replacement may have stopped before updating the name
        // index. Its new names are unknown, so even an apparently unique name
        // must wait until recovery finishes.
        if !self.names_available {
            return Ok(None);
        }
        let candidates = self.graph().lookup_by_name(name).map_err(graph_error)?;
        let ids: Vec<_> = candidates.iter().map(|c| c.entity_id.clone()).collect();
        let visible = self.endpoints(&ids)?;
        if candidates.iter().any(|c| {
            visible
                .get(&c.entity_id)
                .is_none_or(|file| file.get() != c.file_id)
        }) {
            return Ok(None);
        }
        Ok(Some(candidates))
    }

    fn file_path(&self, file_id: u32) -> EngineResult<Option<String>> {
        Ok(self
            .indexed_files(&[FileId::new(file_id)])
            .remove(&FileId::new(file_id))
            .and_then(|file| query_path(&file.relative_path)))
    }

    fn file_id_by_path(&self, path: &str) -> EngineResult<Option<u32>> {
        Ok(self
            .paths
            .get(Path::new(path))
            .and_then(|id| self.files.get(id))
            .filter(|f| f.index_status.is_indexed())
            .map(|f| f.id.get()))
    }

    fn path_has_module(&self, name: &str, extensions: &[&str]) -> EngineResult<bool> {
        if extensions
            .iter()
            .any(|ext| self.paths.contains_key(Path::new(&format!("{name}.{ext}"))))
        {
            return Ok(true);
        }
        let module = Path::new(name);
        Ok(self
            .paths
            .keys()
            .any(|path| path != module && path.starts_with(module)))
    }

    fn imported_file_ids(&self, file_id: u32) -> EngineResult<Vec<u32>> {
        if !self
            .files
            .get(&FileId::new(file_id))
            .is_some_and(|file| file.index_status.is_indexed())
        {
            return Ok(Vec::new());
        }
        let targets = self.graph().import_targets(file_id).map_err(graph_error)?;
        let mut ids: Vec<_> = self
            .endpoints(&targets)?
            .into_values()
            .map(FileId::get)
            .collect();
        ids.sort_unstable();
        ids.dedup();
        Ok(ids)
    }

    fn apply_resolutions(&mut self, resolutions: &[Resolution]) -> EngineResult<ResolutionStats> {
        let refs = self.eligible_refs(resolutions.iter().map(|r| r.ref_id))?;
        let ids: Vec<_> = resolutions.iter().map(|r| r.target_id.clone()).collect();
        let targets = self.endpoints(&ids)?;
        let valid: Vec<_> = resolutions
            .iter()
            .filter(|r| refs.contains(&r.ref_id) && targets.contains_key(&r.target_id))
            .cloned()
            .collect();
        let mut result = self
            .state
            .graph
            .as_mut()
            .expect("writable graph")
            .apply_resolutions(&valid)
            .map_err(graph_error)?;
        result.stale += resolutions.len() - valid.len();
        Ok(result)
    }

    fn apply_failures(&mut self, ids: &[i64]) -> EngineResult<usize> {
        let refs = self.eligible_refs(ids.iter().copied())?;
        let valid: Vec<_> = ids.iter().copied().filter(|id| refs.contains(id)).collect();
        self.state
            .graph
            .as_mut()
            .expect("writable graph")
            .apply_failures(&valid)
            .map_err(graph_error)
    }

    fn record_candidates(&mut self, entries: &[(i64, Vec<String>)]) -> EngineResult<usize> {
        let refs = self.eligible_refs(entries.iter().map(|(id, _)| *id))?;
        let ids: Vec<_> = entries
            .iter()
            .flat_map(|(_, ids)| ids.iter().cloned())
            .collect();
        let visible = self.endpoints(&ids)?;
        let valid: Vec<_> = entries
            .iter()
            .filter(|(id, ids)| {
                refs.contains(id)
                    && !ids.is_empty()
                    && ids.iter().all(|id| visible.contains_key(id))
            })
            .cloned()
            .collect();
        self.state
            .graph
            .as_mut()
            .expect("writable graph")
            .record_candidates(&valid)
            .map_err(graph_error)
    }
}
