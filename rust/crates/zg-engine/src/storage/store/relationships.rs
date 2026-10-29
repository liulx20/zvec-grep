//! Read-only relationship access under the store lock.
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

use super::{IndexStore, StoreState, graph_error};
use crate::storage::{
    fragments::build_filter,
    graph::{Direction, SqliteGraphStorage},
    path_filter::compile_path_filter,
    types::{StorageSearchFilter, StoredEntity},
};
use crate::{
    EngineError, EngineResult,
    api::relationships::MAX_SYMBOL_MATCHES,
    domain::{
        Entity, EntityId, FileEdge, FileId, FileIndexStatus, FileRecord, GlobRule, GraphEdgeKind,
    },
    file_selection::GlobMatcher,
};

const MAX_SYMBOL_SUGGESTIONS: usize = 5;
const ENDPOINT_BATCH_SIZE: usize = 256;

impl IndexStore {
    /// Keep symbol lookup, edge selection and endpoint hydration on one snapshot.
    /// In-process writers use this same mutex for file replacement and deletion.
    pub(crate) fn with_relationship_read<T>(
        &self,
        operation: impl FnOnce(&RelationshipReadSession<'_>) -> EngineResult<T>,
    ) -> EngineResult<T> {
        self.read(|state| {
            let graph = state.graph.as_ref().ok_or_else(|| {
                EngineError::not_found(
                    "workspace graph is missing; this index has no persisted relationship data",
                )
            })?;
            operation(&RelationshipReadSession { state, graph })
        })
    }

    #[cfg(test)]
    pub(crate) fn find_symbols(
        &self,
        name: &str,
        scope: Option<&str>,
    ) -> EngineResult<Vec<StoredEntity>> {
        self.with_relationship_read(|session| session.find_symbols(name, scope, None))
    }
}

/// Read-only access valid while the store mutex is held for the entire query.
pub(crate) struct RelationshipReadSession<'a> {
    state: &'a StoreState,
    graph: &'a SqliteGraphStorage,
}

impl RelationshipReadSession<'_> {
    /// Bounded best-effort suggestions, never relationship query roots.
    /// Do not require the requested scope: a misspelled scope is a useful retry case.
    pub(crate) fn suggest_symbols(
        &self,
        name: &str,
        filter: Option<&str>,
    ) -> EngineResult<Vec<StoredEntity>> {
        let query = name.to_lowercase();
        let hits = self.state.fragments.search_fts(&query, 100, filter)?;
        let mut seen = HashSet::new();
        let ids: Vec<_> = hits
            .into_iter()
            .map(|hit| hit.entity_id)
            .filter(|id| seen.insert(id.clone()))
            .collect();
        let mut metadata = self.state.entities.fetch_code_metadata(&ids)?;
        let mut candidates: Vec<_> = ids
            .into_iter()
            .filter_map(|id| {
                let (file_id, metadata) = metadata.remove(&id)?;
                let rank = suggestion_rank(&query, metadata.symbol_name.as_deref()?)?;
                Some((id, file_id, rank))
            })
            .collect();
        // Stable sort preserves FTS relevance within each name-match category.
        // Rank before limiting, and hydrate only the selected visible definitions.
        candidates.sort_by_key(|(_, _, rank)| *rank);
        let file_ids: Vec<_> = candidates
            .iter()
            .map(|(_, file_id, _)| *file_id)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let files = self.state.files.fetch(&file_ids)?;
        let selected: Vec<_> = candidates
            .into_iter()
            .filter_map(|(id, file_id, _)| {
                let file = files.get(&file_id)?;
                file.index_status().is_indexed().then(|| (id, file.clone()))
            })
            .take(MAX_SYMBOL_SUGGESTIONS)
            .collect();
        self.load_symbols(selected)
    }

    /// Resolve bounded roots and reuse their checked file records while hydrating.
    pub(crate) fn find_symbols(
        &self,
        name: &str,
        scope: Option<&str>,
        filter: Option<&str>,
    ) -> EngineResult<Vec<StoredEntity>> {
        let selected = self.select_symbols(name, scope, filter, MAX_SYMBOL_MATCHES + 1)?;
        if selected.len() > MAX_SYMBOL_MATCHES {
            return Err(EngineError::invalid_argument(format!(
                "symbol query matches more than {MAX_SYMBOL_MATCHES} indexed definitions; use a narrower scope::name or glob filter",
            )));
        }
        self.load_symbols(selected)
    }

    /// Exact bare-name candidates for a wrong scope, bounded without an overflow error.
    pub(crate) fn suggest_exact_symbols(
        &self,
        name: &str,
        filter: Option<&str>,
    ) -> EngineResult<Vec<StoredEntity>> {
        let selected = self.select_symbols(name, None, filter, MAX_SYMBOL_SUGGESTIONS)?;
        self.load_symbols(selected)
    }

    /// Use the same glob pushdown and fallback matcher as ordinary indexed search.
    pub(crate) fn glob_filter(&self, rules: &[GlobRule]) -> EngineResult<Option<String>> {
        if rules.is_empty() {
            return Ok(None);
        }
        let matcher = GlobMatcher::new(std::path::Path::new(""), rules)?;
        let filter = if let Some(path) =
            compile_path_filter(rules, || self.state.files.has_non_unicode_file_names())?
        {
            StorageSearchFilter {
                path: Some(path),
                ..StorageSearchFilter::default()
            }
        } else {
            let file_ids = self
                .state
                .files
                .list_paths()?
                .into_iter()
                .filter(|(_, path)| matcher.matches_path(path))
                .map(|(id, _)| id)
                .collect();
            StorageSearchFilter {
                file_ids: Some(file_ids),
                ..StorageSearchFilter::default()
            }
        };
        build_filter(Some(&filter), &|path| self.state.directories.get(path))
    }

    fn select_symbols(
        &self,
        name: &str,
        scope: Option<&str>,
        filter: Option<&str>,
        limit: usize,
    ) -> EngineResult<Vec<(EntityId, FileRecord)>> {
        if name.is_empty() {
            return Err(EngineError::invalid_argument(
                "symbol name must not be empty",
            ));
        }
        let state = self.state;
        let ids = state.fragments.find_symbol_entity_ids(name, filter)?;
        let mut selected = Vec::new();
        'batches: for batch in ids.chunks(128) {
            let mut owners: HashMap<_, _> = state
                .entities
                .fetch_code_metadata(batch)?
                .into_iter()
                .filter_map(|(id, (file_id, metadata))| {
                    (metadata.symbol_name.as_deref() == Some(name)
                        && scope.is_none_or(|scope| {
                            metadata.scope.as_deref().unwrap_or("").replace('.', "::") == scope
                        }))
                    .then_some((id, file_id))
                })
                .collect();
            let file_ids: Vec<_> = owners
                .values()
                .copied()
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let files = state.files.fetch(&file_ids)?;
            for id in batch {
                if let Some(file) = owners.remove(id).and_then(|file_id| files.get(&file_id))
                    && file.index_status().is_indexed()
                {
                    selected.push((id.clone(), file.clone()));
                    if selected.len() == limit {
                        break 'batches;
                    }
                }
            }
        }
        Ok(selected)
    }

    fn load_symbols(
        &self,
        selected: Vec<(EntityId, FileRecord)>,
    ) -> EngineResult<Vec<StoredEntity>> {
        let ids: Vec<_> = selected.iter().map(|(id, _)| id.clone()).collect();
        let mut entities = self.state.entities.fetch(&ids)?;
        // Selection already read and checked these records under the same store lock.
        Ok(selected
            .into_iter()
            .filter_map(|(id, file)| {
                let entity = entities.remove(&id)?;
                (entity.file_id() == file.id()).then_some(StoredEntity { entity, file })
            })
            .collect())
    }

    /// Fetch canonical entities and their indexed files without scanning either table.
    pub(crate) fn get_entities(
        &self,
        ids: &[EntityId],
    ) -> EngineResult<HashMap<EntityId, StoredEntity>> {
        get_entities(self.state, ids)
    }

    /// Filter resolved edges by endpoint visibility before applying the limit.
    pub(crate) fn neighborhood(
        &self,
        id: &str,
        direction: Direction,
        kinds: Option<&[GraphEdgeKind]>,
        limit: usize,
    ) -> EngineResult<Vec<(FileEdge, PathBuf)>> {
        let mut rows = self
            .graph
            .neighborhood(id, direction, kinds)
            .map_err(graph_error)?
            .into_iter();
        let mut edges = Vec::new();
        let mut hydration_size = limit.clamp(1, ENDPOINT_BATCH_SIZE);
        let mut checked = HashSet::new();
        let mut visible = HashMap::new();
        while edges.len() < limit {
            let batch: Vec<_> = rows.by_ref().take(hydration_size).collect();
            if batch.is_empty() {
                break;
            }
            // SQLite can be ahead of zvec after a failed write. Filter both
            // endpoints before counting a row toward the requested limit.
            let ids: Vec<_> = batch
                .iter()
                .flat_map(|edge| [&edge.source, &edge.target])
                .map(|id| EntityId::from_string(id.clone()))
                .filter(|id| checked.insert(id.clone()))
                .collect();
            visible.extend(endpoint_paths(self.state, &ids)?);
            let before = edges.len();
            let remaining = limit - before;
            edges.extend(
                batch
                    .into_iter()
                    .filter_map(|edge| {
                        let path = visible.get(&EntityId::from_string(edge.source.clone()))?;
                        visible.get(&EntityId::from_string(edge.target.clone()))?;
                        Some((edge, path.clone()))
                    })
                    .take(remaining),
            );
            // Avoid reading unused endpoints, but grow batches across invisible stretches.
            hydration_size = if edges.len() == before {
                hydration_size.saturating_mul(2).min(ENDPOINT_BATCH_SIZE)
            } else {
                (limit - edges.len()).clamp(1, ENDPOINT_BATCH_SIZE)
            };
        }
        Ok(edges)
    }
}

/// Smaller ranks are better; reverse containment needs a meaningful name length.
fn suggestion_rank(query: &str, candidate: &str) -> Option<u8> {
    let candidate = candidate.to_lowercase();
    if candidate.is_empty() {
        None
    } else if candidate == query {
        Some(0)
    } else if candidate.starts_with(query) {
        Some(1)
    } else if candidate.contains(query) {
        Some(2)
    } else if candidate.chars().count() >= 3 && query.contains(&candidate) {
        Some(3)
    } else {
        None
    }
}

fn get_entities(
    state: &StoreState,
    ids: &[EntityId],
) -> EngineResult<HashMap<EntityId, StoredEntity>> {
    let entities = state.entities.fetch(ids)?;
    let file_ids = entities
        .values()
        .map(Entity::file_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let files = state.files.fetch(&file_ids)?;
    Ok(entities
        .into_iter()
        .filter_map(|(id, entity)| {
            let file = files.get(&entity.file_id())?;
            if !matches!(file.index_status(), FileIndexStatus::Indexed { .. }) {
                return None;
            }
            Some((
                id,
                StoredEntity {
                    entity,
                    file: file.clone(),
                },
            ))
        })
        .collect())
}

fn endpoint_paths(
    state: &StoreState,
    ids: &[EntityId],
) -> EngineResult<HashMap<EntityId, PathBuf>> {
    let mut owners = state.entities.fetch_file_ids(ids)?;
    for id in ids {
        if let Some(file_id) = id
            .as_str()
            .strip_prefix('f')
            .and_then(|id| id.parse::<u32>().ok())
        {
            // Only canonical f{file_id} spellings represent implicit file endpoints.
            if id.as_str() == format!("f{file_id}") {
                owners.insert(id.clone(), FileId::new(file_id));
            }
        }
    }
    let file_ids: Vec<_> = owners
        .values()
        .copied()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let files = state.files.fetch(&file_ids)?;
    Ok(owners
        .into_iter()
        .filter_map(|(id, file_id)| {
            files
                .get(&file_id)
                .filter(|file| file.index_status().is_indexed())
                .map(|file| (id, file.relative_path().to_path_buf()))
        })
        .collect())
}
