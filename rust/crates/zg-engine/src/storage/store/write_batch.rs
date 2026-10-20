//! Durable publication of a bounded batch under the `IndexStore` write lock.
use super::{
    EmbeddingModelInfo, EngineError, EngineResult, Entities, FileIndexStatus, FileRecord,
    FileWrite, Fragments, HashSet, SqliteGraphStorage, StoreState, finish_write_batch, graph_error,
    now_epoch_ms, validate_batch,
};

pub(super) fn validate(
    writes: &[FileWrite<'_>],
    schema: &[EmbeddingModelInfo],
) -> EngineResult<Vec<FileRecord>> {
    let mut ids = HashSet::new();
    let mut entity_owners = HashSet::new();
    let mut fragment_owners = HashSet::new();
    writes
        .iter()
        .map(|write| {
            let FileWrite {
                file,
                entities,
                entries,
                graph,
            } = *write;
            if !ids.insert(file.id) {
                return Err(EngineError::invalid_argument(
                    "duplicate file in write batch",
                ));
            }
            validate_batch(file, entities, entries, schema)?;
            for entity in entities {
                if !entity_owners.insert(&entity.id)
                    || entity
                        .fragments
                        .iter()
                        .any(|fragment| !fragment_owners.insert(&fragment.id))
                {
                    return Err(EngineError::invalid_argument(
                        "entity or fragment ID is already owned by another file in this batch",
                    ));
                }
            }
            SqliteGraphStorage::validate_snapshot(file.id.get(), graph).map_err(graph_error)?;
            let entity_ids: HashSet<_> = entities.iter().map(|entity| entity.id.as_str()).collect();
            if graph
                .nodes
                .iter()
                .any(|node| !entity_ids.contains(node.id.as_str()))
            {
                return Err(EngineError::invalid_argument(
                    "graph entity is absent from canonical file entities",
                ));
            }
            let mut file = file.clone();
            file.index_status = FileIndexStatus::Indexed {
                indexed_epoch_ms: now_epoch_ms()?,
                entity_count: u64::try_from(entities.len())
                    .map_err(|_| EngineError::invalid_argument("entity count exceeds u64"))?,
            };
            file.validate()?;
            Ok(file)
        })
        .collect()
}

pub(super) fn replace(
    state: &mut StoreState,
    writes: &[FileWrite<'_>],
    files: &[FileRecord],
) -> EngineResult<()> {
    if writes.is_empty() {
        return Ok(());
    }
    // Validate ownership and encode the entire batch before changing any file.
    let mut prepared = Vec::with_capacity(writes.len());
    for write in writes {
        state.files.validate(write.file)?;
        state
            .entities
            .validate_ownership(write.entities, write.file.id)?;
        state
            .fragments
            .validate_ownership(write.entries, write.file.id)?;
        let directories = state.directories.ensure(&write.file.relative_path)?;
        let entity_docs = Entities::prepare(write.entities)?;
        let fragment_docs =
            Fragments::prepare(write.file, write.entities, write.entries, &directories)?;
        let old_ids = state.entities.list_ids(write.file.id)?;
        prepared.push((directories, entity_docs, fragment_docs, old_ids));
    }
    state.needs_optimize = true;
    for (write, (directories, ..)) in writes.iter().zip(&prepared) {
        let mut unfinished = write.file.clone();
        unfinished.index_status = FileIndexStatus::NotIndexed;
        state.files.put(&unfinished, directories)?;
    }
    // Every retry marker must be durable before the first SQLite commit.
    state.directories.flush()?;
    state.files.flush()?;
    for (write, (_, _, _, old_ids)) in writes.iter().zip(&prepared) {
        state
            .graph
            .as_mut()
            .expect("writable graph")
            .write_file_graph(write.file.id.get(), write.graph, old_ids)
            .map_err(graph_error)?;
    }
    for (write, (_, entities, fragments, _)) in writes.iter().zip(&prepared) {
        state.fragments.delete_file(write.file.id)?;
        state.entities.delete_file(write.file.id)?;
        state.entities.write(entities)?;
        state.fragments.write(fragments)?;
    }
    state.entities.flush()?;
    state.fragments.flush()?;
    // Only publish after all canonical content is durable. Partial publication
    // is safe: unpublished files remain retryable, published files are complete.
    for (file, (directories, ..)) in files.iter().zip(&prepared) {
        state.files.put(file, directories)?;
    }
    state.files.flush()?;
    finish_write_batch(state)
}
