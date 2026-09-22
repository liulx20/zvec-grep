//! Resolve symbol definitions through the existing index, then read call edges.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use crate::{
    EngineError, EngineResult,
    api::relationships::{
        RelationshipEdge, RelationshipOptions, RelationshipSymbol, SymbolRelationships,
    },
    domain::{EntityId, EntityMetadata, FileIndexStatus, Range},
    storage::{
        IndexStore,
        graph::Edge,
        read_session::{ReadSessionCache, ReadSessionLease},
        types::StoredEntity,
    },
    workspace::{
        layout::find_nearest_workspace,
        lock::{LockMode, LockWait},
        manifest::read_workspace_manifest,
    },
};

use super::indexing::service::is_indexed;

pub(crate) type ReadEdges = fn(&IndexStore, &str) -> EngineResult<Vec<Edge>>;

pub(crate) async fn query(
    options: &RelationshipOptions,
    read_sessions: Option<&ReadSessionCache>,
    read_edges: ReadEdges,
) -> EngineResult<Vec<SymbolRelationships>> {
    let (name, scope, limit) = normalize(options)?;
    let wait = LockWait::new(options.signal.as_ref(), options.lock_timeout_ms)?;
    wait.check_cancelled()?;
    let requested = options.root.as_deref().unwrap_or_else(|| Path::new("."));
    let location = find_nearest_workspace(requested)?.ok_or_else(missing_index)?;
    // Keep the canonical entities and graph in the same workspace read scope.
    // Writers retire these same cached handles before replacing index data.
    let _lock = wait
        .acquire(&location.home, LockMode::Read, "relationships")
        .await?;
    let manifest = read_workspace_manifest(&location.home)?.ok_or_else(missing_index)?;
    if !is_indexed(&manifest) || !IndexStore::exists(&manifest.storage_home())? {
        return Err(missing_index());
    }
    let storage = match read_sessions {
        Some(cache) => cache.acquire(&location.home, &manifest.storage_home())?,
        None => ReadSessionLease::open(&manifest.storage_home())?,
    };
    let result = query_symbols(storage.storage(), name, scope, limit, read_edges);
    let close = storage.close();
    let result = result?;
    close?;
    wait.check_cancelled()?;
    Ok(result)
}

fn normalize(options: &RelationshipOptions) -> EngineResult<(&str, Option<&str>, usize)> {
    let symbol = options.symbol.trim();
    if symbol.is_empty() || symbol.chars().count() > 1024 {
        return Err(EngineError::invalid_argument(
            "symbol must contain between 1 and 1024 characters",
        ));
    }
    let (scope, name) = symbol
        .rsplit_once("::")
        .map_or((None, symbol), |(scope, name)| (Some(scope), name));
    if name.is_empty() {
        return Err(EngineError::invalid_argument(
            "symbol name must not be empty",
        ));
    }
    let limit = options.limit.unwrap_or(20);
    if limit == 0 {
        return Err(EngineError::invalid_argument(
            "relationship limit must be positive",
        ));
    }
    Ok((name, scope, limit))
}

fn query_symbols(
    storage: &IndexStore,
    name: &str,
    scope: Option<&str>,
    limit: usize,
    read_edges: ReadEdges,
) -> EngineResult<Vec<SymbolRelationships>> {
    // Missing graph data is an unavailable index, even for an unknown symbol.
    storage.ensure_graph_available()?;
    let mut definitions = storage.find_symbols(name, scope)?;
    if definitions.is_empty() {
        definitions = recall_symbols(storage, name, scope)?;
    }
    let mut symbols: HashMap<_, _> = definitions
        .iter()
        .map(|stored| (stored.entity.id.clone(), describe(stored)))
        .collect();
    let mut matches = Vec::new();
    let mut seen = HashSet::new();
    for stored in definitions {
        let id = &stored.entity.id;
        let Some(symbol) = symbols.get(id).cloned().flatten() else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let mut edges = read_edges(storage, id.as_str())?;
        let total_edges = edges.len();
        edges.truncate(limit);
        let targets: Vec<_> = edges
            .iter()
            .map(|edge| {
                EntityId::from_string(if edge.source == id.as_str() {
                    edge.target.clone()
                } else {
                    edge.source.clone()
                })
            })
            .collect();
        let missing: Vec<_> = targets
            .iter()
            .filter(|id| !symbols.contains_key(*id))
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let endpoints = storage.get_entities(&missing)?;
        for id in missing {
            symbols.insert(id.clone(), endpoints.get(&id).and_then(describe));
        }
        matches.push(SymbolRelationships {
            symbol,
            total_edges,
            edges: edges
                .into_iter()
                .zip(targets)
                .map(|(edge, target)| RelationshipEdge {
                    symbol: symbols.get(&target).cloned().flatten(),
                    line: edge.line,
                    column: edge.column,
                })
                .collect(),
        });
    }
    matches.sort_by(|a, b| {
        a.symbol
            .file_path
            .cmp(&b.symbol.file_path)
            .then_with(|| a.symbol.start_line.cmp(&b.symbol.start_line))
            .then_with(|| a.symbol.name.cmp(&b.symbol.name))
    });
    Ok(matches)
}

fn recall_symbols(
    storage: &IndexStore,
    name: &str,
    scope: Option<&str>,
) -> EngineResult<Vec<StoredEntity>> {
    let hits = storage.search_fts(&name.to_lowercase(), 100, None)?;
    let data = storage.load_search_hits(&hits)?;
    let mut seen = HashSet::new();
    let mut definitions = Vec::new();
    for hit in hits {
        if !seen.insert(hit.entity_id.clone()) {
            continue;
        }
        let Some(stored) = data.entities.get(&hit.entity_id) else {
            continue;
        };
        if !stored
            .entity
            .fragments
            .iter()
            .any(|fragment| fragment.id.as_str() == hit.document_id)
        {
            continue;
        }
        if matches!(stored.file.index_status, FileIndexStatus::Indexed { .. })
            && let Some(EntityMetadata::Code(metadata)) = &stored.entity.metadata
            && scope.is_none_or(|scope| metadata.scope.as_deref() == Some(scope))
        {
            // FTS can recall a definition through its body or documentation;
            // the canonical entity supplies its full definition coordinates.
            definitions.push(stored.clone());
        }
    }
    Ok(definitions)
}

fn describe(stored: &StoredEntity) -> Option<RelationshipSymbol> {
    let Some(EntityMetadata::Code(metadata)) = &stored.entity.metadata else {
        return None;
    };
    let name = metadata
        .symbol_name
        .as_deref()
        .filter(|name| !name.is_empty())?;
    let Range::Text(range) = stored.entity.source_range else {
        return None;
    };
    Some(RelationshipSymbol {
        name: match metadata.scope.as_deref().filter(|scope| !scope.is_empty()) {
            Some(scope) => format!("{scope}::{name}"),
            None => name.to_owned(),
        },
        file_path: stored.file.relative_path.to_path_buf(),
        start_line: range.start_line(),
        end_line: range.end_line(),
    })
}

fn missing_index() -> EngineError {
    EngineError::not_found("workspace index is unavailable; run `zg index` first")
}

#[cfg(test)]
mod tests;
