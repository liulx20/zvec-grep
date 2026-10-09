//! Cross-file resolution of pending references via the workspace name index.
//!
//! The resolver consumes the graph storage's own pending queue and name
//! index, so it needs no extraction state: [`SqliteGraphStorage::list_pending_refs`]
//! pages the backlog, [`SqliteGraphStorage::lookup_by_name`] narrows candidates,
//! and [`SqliteGraphStorage::apply_resolutions`] writes the batch atomically.

use crate::storage::graph::{Provenance, Resolution, SqliteGraphStorage};

/// Outcome of one resolution sweep.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct ResolutionSweep {
    /// Pending references examined this sweep.
    pub scanned: usize,
    /// References resolved by `apply_resolutions`.
    pub resolved: usize,
    /// Proposals that no longer matched a pending row.
    pub stale: usize,
}

/// Resolves every pending reference whose name tail is unique across the
/// workspace and owned by another file.
///
/// Matching is deliberately conservative in this first version. Same-file
/// hits stay pending — partition already resolved unambiguous local names,
/// so a survivor in the same file is a receiver-typed call that needs type
/// inference — and ambiguous names stay pending until narrower evidence
/// (receiver names, arity, import scoping) lands.
///
/// The entire read/resolve/writeback cycle runs under the caller's graph
/// storage lock, matching the serialization contract of `apply_resolutions`.
///
/// # Errors
/// Propagates graph storage failures; nothing is written unless the final
/// batch applies, so a failed sweep leaves every reference pending for the
/// next pass to retry.
pub(super) fn resolve_pending(
    graph: &mut SqliteGraphStorage,
) -> crate::storage::graph::Result<ResolutionSweep> {
    let mut sweep = ResolutionSweep::default();
    let mut resolutions = Vec::new();
    let mut cursor = 0;
    loop {
        let page = graph.list_pending_refs(1000, cursor)?;
        sweep.scanned += page.refs.len();
        for stored in &page.refs {
            let Some(hit) = graph.lookup_unique(&stored.reference.name_tail)? else {
                continue;
            };
            if hit.file_id == stored.file_id {
                continue;
            }
            resolutions.push(Resolution {
                ref_id: stored.id,
                target_id: hit.entity_id,
                provenance: Provenance::WorkspaceUnique,
            });
        }
        let Some(next) = page.next_cursor else {
            break;
        };
        cursor = next;
    }
    let stats = graph.apply_resolutions(&resolutions)?;
    sweep.resolved = stats.resolved;
    sweep.stale = stats.stale;
    Ok(sweep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::graph::{EntityRecord, FileGraph};

    fn record(entity_id: &str, name: &str) -> EntityRecord {
        EntityRecord {
            entity_id: entity_id.to_owned(),
            name: name.to_owned(),
            qualified_name: name.to_owned(),
            is_exported: true,
        }
    }

    fn empty_graph(entities: Vec<EntityRecord>) -> FileGraph {
        FileGraph {
            entity_ids: entities
                .iter()
                .map(|record| record.entity_id.clone())
                .collect(),
            entities,
            edges: Vec::new(),
            pending_refs: Vec::new(),
        }
    }

    fn graph_with_pending(entities: Vec<EntityRecord>, reference_name: &str) -> FileGraph {
        FileGraph {
            pending_refs: vec![crate::storage::graph::PendingRef {
                from_node_id: "f9".to_owned(),
                reference_name: reference_name.to_owned(),
                receiver_name: None,
                reference_kind: crate::storage::graph::EdgeKind::Calls,
                arity: None,
                line: 1,
                col: 0,
                metadata: serde_json::Map::new(),
                candidates: None,
                language: "typescript".to_owned(),
                name_tail: reference_name
                    .rsplit("::")
                    .next()
                    .unwrap_or_default()
                    .to_owned(),
            }],
            ..empty_graph(entities)
        }
    }

    fn open_memory() -> SqliteGraphStorage {
        SqliteGraphStorage::in_memory().expect("graph opens")
    }

    #[test]
    fn resolves_cross_file_unique_names() {
        let mut graph = open_memory();
        graph
            .write_file_graph(
                1,
                &empty_graph(vec![record("entity-helper", "helper")]),
                &[],
            )
            .expect("definition write");
        graph
            .write_file_graph(9, &graph_with_pending(Vec::new(), "helper"), &[])
            .expect("reference write");

        let sweep = resolve_pending(&mut graph).expect("sweep");

        assert_eq!(
            sweep,
            ResolutionSweep {
                scanned: 1,
                resolved: 1,
                stale: 0
            }
        );
        assert!(
            graph
                .list_pending_refs(10, 0)
                .expect("pending page")
                .refs
                .is_empty()
        );
        let inbound = graph
            .neighborhood(
                "entity-helper",
                crate::storage::graph::Direction::In,
                Some(&[crate::storage::graph::EdgeKind::Calls]),
            )
            .expect("inbound");
        assert_eq!(inbound.len(), 1);
        assert_eq!(inbound[0].source, "f9");
        assert_eq!(inbound[0].provenance, Provenance::WorkspaceUnique);
    }

    #[test]
    fn ambiguous_names_stay_pending() {
        let mut graph = open_memory();
        graph
            .write_file_graph(1, &empty_graph(vec![record("first", "helper")]), &[])
            .expect("first write");
        graph
            .write_file_graph(2, &empty_graph(vec![record("second", "helper")]), &[])
            .expect("second write");
        graph
            .write_file_graph(9, &graph_with_pending(Vec::new(), "helper"), &[])
            .expect("reference write");

        let sweep = resolve_pending(&mut graph).expect("sweep");

        assert_eq!(sweep.scanned, 1);
        assert_eq!(sweep.resolved, 0);
        assert_eq!(
            graph
                .list_pending_refs(10, 0)
                .expect("pending page")
                .refs
                .len(),
            1
        );
    }

    #[test]
    fn same_file_hits_stay_pending() {
        let mut graph = open_memory();
        graph
            .write_file_graph(
                9,
                &graph_with_pending(vec![record("local", "helper")], "helper"),
                &[],
            )
            .expect("write");

        let sweep = resolve_pending(&mut graph).expect("sweep");

        assert_eq!(sweep.scanned, 1);
        assert_eq!(sweep.resolved, 0);
        assert_eq!(
            graph
                .list_pending_refs(10, 0)
                .expect("pending page")
                .refs
                .len(),
            1
        );
    }

    #[test]
    fn an_empty_queue_is_a_noop() {
        let mut graph = open_memory();

        let sweep = resolve_pending(&mut graph).expect("sweep");

        assert_eq!(sweep, ResolutionSweep::default());
    }
}
