use super::{
    Error, PendingRefPage, Resolution, ResolutionStats, Result, SqliteGraphStorage,
    StoredPendingRef, decode_enum, decode_metadata, nonempty,
};
use crate::domain::{EdgeProvenance, PendingRef, PendingRefStatus};
use rusqlite::{Row, TransactionBehavior, params};

/// Maximum references per page, excluding the one-row pagination lookahead.
pub(super) const MAX_PENDING_PAGE_SIZE: usize = 1024;

const SELECT_REF: &str = "SELECT id, file_id, source, reference_name, receiver_name, kind, arity, line, col, metadata FROM edges";

impl SqliteGraphStorage {
    /// Lists only pending refs using keyset pagination; no snapshot spans pages.
    /// Restart with cursor 0 after file mutations.
    /// Limit must be positive and at most [`MAX_PENDING_PAGE_SIZE`].
    /// # Errors
    /// Rejects invalid limits/cursors and malformed stored rows or SQLite errors.
    pub(crate) fn list_pending_refs(&self, limit: usize, cursor: i64) -> Result<PendingRefPage> {
        if !(1..=MAX_PENDING_PAGE_SIZE).contains(&limit) || cursor < 0 {
            return Err(Error::InvalidInput(
                "pending query requires limit 1..1024 and nonnegative cursor",
            ));
        }
        let mut statement = self.connection.prepare(&format!(
            "{SELECT_REF} WHERE status = 'pending' AND id > ? ORDER BY id LIMIT ?"
        ))?;
        let mut refs: Vec<_> = statement
            .query_map(params![cursor, limit + 1], ref_from_row)?
            .collect::<rusqlite::Result<_>>()?;
        let more = refs.len() > limit;
        refs.truncate(limit);
        let next_cursor = if more {
            refs.last().map(|reference| reference.id)
        } else {
            None
        };
        let mut candidates = self.connection.prepare(
            "SELECT target_id FROM reference_candidates WHERE ref_id = ? ORDER BY target_id",
        )?;
        for reference in &mut refs {
            reference.candidates = candidates
                .query_map([reference.id], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
        }
        Ok(PendingRefPage { refs, next_cursor })
    }

    /// Atomically applies proposals for existing pending refs, skipping missing
    /// or already resolved refs. The caller must serialize the entire read,
    /// resolution and writeback cycle with workspace writes/deletions.
    /// Validate targets in zvec before writeback. Row IDs alone cannot detect
    /// outdated proposals for references that were resolved and then invalidated.
    /// # Errors
    /// Rejects invalid proposals and SQLite failures; the entire batch rolls back.
    pub(crate) fn apply_resolutions(
        &mut self,
        resolutions: &[Resolution],
    ) -> Result<ResolutionStats> {
        for resolution in resolutions {
            nonempty(&resolution.target_id)?;
            if resolution.ref_id < 1 || resolution.provenance == EdgeProvenance::FileLocal {
                return Err(Error::InvalidInput(
                    "resolution requires a positive ref ID and cross-file provenance",
                ));
            }
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut stats = ResolutionStats::default();
        {
            let mut update = tx.prepare(
                "UPDATE edges SET target = ?, provenance = ?, status = 'resolved'
                 WHERE id = ? AND status = 'pending'",
            )?;
            for resolution in resolutions {
                let changed = update.execute(params![
                    resolution.target_id,
                    resolution.provenance.as_str(),
                    resolution.ref_id,
                ])?;
                if changed == 0 {
                    stats.stale += 1;
                } else {
                    tx.execute(
                        "DELETE FROM reference_candidates WHERE ref_id = ?",
                        [resolution.ref_id],
                    )?;
                    stats.resolved += 1;
                }
            }
        }
        tx.commit()?;
        Ok(stats)
    }
}

fn ref_from_row(row: &Row<'_>) -> rusqlite::Result<StoredPendingRef> {
    Ok(StoredPendingRef {
        id: row.get(0)?,
        candidates: Vec::new(),
        file_id: row.get(1)?,
        reference: PendingRef {
            owner_id: row.get(2)?,
            ref_name: row.get(3)?,
            receiver_name: row.get(4)?,
            ref_kind: decode_enum(row.get(5)?)?,
            arity: row.get(6)?,
            line: row.get(7)?,
            column: row.get(8)?,
            status: PendingRefStatus::Pending,
            metadata: decode_metadata(&row.get::<_, String>(9)?)?,
        },
    })
}

impl SqliteGraphStorage {
    /// Records ambiguity without changing the public extraction reference type.
    pub(crate) fn record_candidates(&mut self, entries: &[(i64, Vec<String>)]) -> Result<usize> {
        for (id, candidates) in entries {
            if *id < 1 || candidates.is_empty() {
                return Err(Error::InvalidInput(
                    "candidate sets require a positive ref ID and candidates",
                ));
            }
            for candidate in candidates {
                nonempty(candidate)?;
            }
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut recorded = 0;
        for (id, candidates) in entries {
            let pending: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM edges WHERE id = ? AND status = 'pending')",
                [id],
                |row| row.get(0),
            )?;
            if !pending {
                continue;
            }
            tx.execute("DELETE FROM reference_candidates WHERE ref_id = ?", [id])?;
            for candidate in candidates {
                tx.execute(
                    "INSERT OR IGNORE INTO reference_candidates (ref_id, target_id) VALUES (?, ?)",
                    params![id, candidate],
                )?;
            }
            recorded += 1;
        }
        tx.commit()?;
        Ok(recorded)
    }

    /// Failed references are retried when their file or matching definitions change.
    pub(crate) fn apply_failures(&mut self, ids: &[i64]) -> Result<usize> {
        if ids.iter().any(|id| *id < 1) {
            return Err(Error::InvalidInput("failures require a positive ref ID"));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut failed = 0;
        for id in ids {
            let changed = tx.execute(
                "UPDATE edges SET status = 'failed' WHERE id = ? AND status = 'pending'",
                [id],
            )?;
            if changed != 0 {
                tx.execute("DELETE FROM reference_candidates WHERE ref_id = ?", [id])?;
                failed += changed;
            }
        }
        tx.commit()?;
        Ok(failed)
    }
}
