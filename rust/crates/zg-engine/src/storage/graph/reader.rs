use super::{
    Direction, Edge, EdgeKind, NameIndexEntry, Result, SqliteGraphStorage, decode_enum,
    decode_metadata, nonempty,
};
use rusqlite::{Row, params_from_iter};

impl SqliteGraphStorage {
    /// All resolved one-hop edges in insertion order, with no result limit.
    /// `None` selects all kinds; `Some(&[])` selects none.
    /// Self-loops appear once; distinct stored call sites are preserved.
    /// Awaits read-side consumers (query pipelines, MCP tools); tests use it.
    ///
    /// # Errors
    /// Rejects blank IDs, invalid stored data, and SQLite errors.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn neighborhood(
        &self,
        id: &str,
        direction: Direction,
        kinds: Option<&[EdgeKind]>,
    ) -> Result<Vec<Edge>> {
        nonempty(id)?;
        let endpoint = match direction {
            Direction::In => "target = ?1",
            Direction::Out => "source = ?1",
            Direction::Both => "(source = ?1 OR target = ?1)",
        };
        let mut sql = format!(
            "SELECT kind, source, target, line, col, provenance, metadata
             FROM edges WHERE {endpoint} AND status = 'resolved'"
        );
        let mut values = vec![id];
        if let Some(kinds) = kinds {
            if kinds.is_empty() {
                return Ok(Vec::new());
            }
            let mut names: Vec<&str> = kinds.iter().map(|kind| kind.as_str()).collect();
            names.sort_unstable();
            names.dedup();
            sql.push_str(" AND kind IN (");
            sql.push_str(&vec!["?"; names.len()].join(", "));
            sql.push(')');
            values.extend(names);
        }
        sql.push_str(" ORDER BY id");
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params_from_iter(values), edge_from_row)?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Entity IDs owned by a file in the last persisted snapshot, recovered
    /// from its `contains` edges. The coordinator reads this right before
    /// `write_file_graph` so stale inbound references can be invalidated.
    /// Returns an empty set for files that were never persisted.
    ///
    /// # Errors
    /// Propagates SQLite errors.
    pub(crate) fn file_entity_ids(&self, file_id: u32) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT target FROM edges
             WHERE file_id = ?1 AND kind = 'contains' AND target IS NOT NULL
             ORDER BY target",
        )?;
        let rows = statement.query_map([file_id], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
    }

    /// Every workspace entity that declares `name`, ordered by entity ID.
    /// This is the resolver's name index; empty names never occur because
    /// unnamed entities are not persisted.
    ///
    /// # Errors
    /// Rejects blank names, invalid stored data, and SQLite errors.
    pub(crate) fn lookup_by_name(&self, name: &str) -> Result<Vec<NameIndexEntry>> {
        nonempty(name)?;
        let mut statement = self.connection.prepare(
            "SELECT entity_id, file_id, qualified_name, is_exported FROM entities
             WHERE name = ?1 ORDER BY entity_id",
        )?;
        let rows = statement.query_map([name], |row| {
            Ok(NameIndexEntry {
                entity_id: row.get(0)?,
                file_id: row.get(1)?,
                qualified_name: row.get(2)?,
                is_exported: row.get::<_, i64>(3)? == 1,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The single workspace entity declaring `name`, or `None` when absent or
    /// ambiguous. Backs the resolver's unique-name fast path.
    ///
    /// # Errors
    /// Rejects blank names, invalid stored data, and SQLite errors.
    pub(crate) fn lookup_unique(&self, name: &str) -> Result<Option<NameIndexEntry>> {
        let mut hits = self.lookup_by_name(name)?;
        Ok((hits.len() == 1).then(|| hits.pop().expect("single hit")))
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn edge_from_row(row: &Row<'_>) -> rusqlite::Result<Edge> {
    Ok(Edge {
        kind: decode_enum(row.get(0)?)?,
        source: row.get(1)?,
        target: row.get(2)?,
        line: row.get(3)?,
        column: row.get(4)?,
        provenance: decode_enum(row.get(5)?)?,
        metadata: decode_metadata(&row.get::<_, String>(6)?)?,
    })
}
