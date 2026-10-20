//! Buffer completed embedding outputs independently of the model's batch size.
use super::{
    Content, EngineError, Entity, FileGraphResult, FileRecord, FileWrite, IndexStorage,
    IndexWriteStats, IndexedFragment, Instant, PreparedFile, TimingCollector,
};

const MAX_FILES: usize = 64;
// Estimate the dominant payloads, rather than serializing everything twice.
const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;

struct PendingWrite {
    file: FileRecord,
    entities: Vec<Entity>,
    entries: Vec<IndexedFragment>,
    graph: FileGraphResult,
}

#[derive(Default)]
pub(super) struct WriteBatch {
    files: Vec<PendingWrite>,
    payload_bytes: usize,
}

impl WriteBatch {
    pub(super) fn push(
        &mut self,
        storage: &dyn IndexStorage,
        file: PreparedFile,
        vectors: Vec<Vec<f32>>,
        stats: &mut IndexWriteStats,
        timings: &mut TimingCollector,
    ) -> Result<(), EngineError> {
        if file.fragments.len() != vectors.len() {
            return Err(EngineError::internal(format!(
                "entity/vector count mismatch: fragments={} vectors={}",
                file.fragments.len(),
                vectors.len()
            )));
        }
        let entries: Vec<_> = file
            .fragments
            .into_iter()
            .zip(vectors)
            .map(|(fragment, vector)| IndexedFragment {
                model: fragment.model,
                entity_id: fragment.entity_id,
                fragment_id: fragment.fragment_id,
                fts_text: fragment.fts_text,
                vector,
            })
            .collect();
        let bytes = file
            .entities
            .iter()
            .map(|entity| content_bytes(&entity.content))
            .sum::<usize>()
            + entries
                .iter()
                .map(|entry| entry.fts_text.len() + entry.vector.len() * size_of::<f32>())
                .sum::<usize>();
        if self.payload_bytes.saturating_add(bytes) > MAX_PAYLOAD_BYTES {
            self.flush(storage, stats, timings)?;
        }
        self.files.push(PendingWrite {
            file: file.file,
            entities: file.entities,
            entries,
            graph: file.graph,
        });
        self.payload_bytes = self.payload_bytes.saturating_add(bytes);
        // A single oversized file is written immediately, without joining another batch.
        if self.files.len() >= MAX_FILES || self.payload_bytes >= MAX_PAYLOAD_BYTES {
            self.flush(storage, stats, timings)?;
        }
        Ok(())
    }

    pub(super) fn flush(
        &mut self,
        storage: &dyn IndexStorage,
        stats: &mut IndexWriteStats,
        timings: &mut TimingCollector,
    ) -> Result<(), EngineError> {
        if self.files.is_empty() {
            return Ok(());
        }
        let writes: Vec<_> = self
            .files
            .iter()
            .map(|file| FileWrite {
                file: &file.file,
                entities: &file.entities,
                entries: &file.entries,
                graph: &file.graph,
            })
            .collect();
        let started = Instant::now();
        storage.replace_files(&writes)?;
        timings.record("index_commit", started.elapsed(), self.files.len());
        stats.files_indexed += self.files.len();
        stats.entities_created += self
            .files
            .iter()
            .map(|file| file.entities.len())
            .sum::<usize>();
        self.files.clear();
        self.payload_bytes = 0;
        Ok(())
    }
}

fn content_bytes(content: &Content) -> usize {
    match content {
        Content::Text(text) => text.len(),
        Content::Image(image) => image.data().len(),
        Content::Table(table) => table
            .cells
            .iter()
            .flat_map(|cell| &cell.contents)
            .map(content_bytes)
            .sum(),
    }
}
