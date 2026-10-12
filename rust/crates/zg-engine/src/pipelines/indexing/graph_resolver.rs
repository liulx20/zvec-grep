//! Cross-file resolution of pending references via the graph's own indexes.
//!
//! The resolver consumes the graph storage's own pending queue, name index,
//! and file-path index, so it needs no extraction state:
//! [`SqliteGraphStorage::list_pending_refs`] pages the backlog, relative
//! import specifiers resolve through [`SqliteGraphStorage::file_id_by_path`],
//! [`SqliteGraphStorage::lookup_by_name`] narrows name candidates, and
//! [`SqliteGraphStorage::apply_resolutions`] writes each batch atomically.

use std::collections::HashMap;
use std::collections::hash_map::Entry;

use crate::storage::graph::{
    EdgeKind, Provenance, Resolution, SqliteGraphStorage, StoredPendingRef,
};

/// Outcome of one resolution sweep.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct ResolutionSweep {
    /// Pending references examined this sweep.
    pub scanned: usize,
    /// References resolved by `apply_resolutions`.
    pub resolved: usize,
    /// Proposals that no longer matched a pending row.
    pub stale: usize,
    /// Ambiguous references whose candidate sets `record_candidates` stored.
    pub candidates_recorded: usize,
}

/// Resolves pending references each sweep: relative import specifiers onto
/// file endpoints, and workspace-unique names onto their single definition.
///
/// Matching stays conservative. Same-file name hits stay pending — partition
/// already resolved unambiguous local names, so a survivor in the same file
/// is a receiver-typed call that needs type inference — and ambiguous names
/// stay pending but record their candidate set for consumers and later
/// evidence rules (receiver names, arity, import scoping of bare names).
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
    let mut candidate_sets: Vec<(i64, Vec<String>)> = Vec::new();
    let mut importing_paths: HashMap<u32, Option<String>> = HashMap::new();
    let mut cursor = 0;
    loop {
        let page = graph.list_pending_refs(1000, cursor)?;
        sweep.scanned += page.refs.len();
        for stored in &page.refs {
            if let Some(resolution) = resolve_import(graph, stored, &mut importing_paths)? {
                resolutions.push(resolution);
                continue;
            }
            let hits = graph.lookup_by_name(&stored.reference.name_tail)?;
            if let [hit] = hits.as_slice() {
                if hit.file_id != stored.file_id {
                    resolutions.push(Resolution {
                        ref_id: stored.id,
                        target_id: hit.entity_id.clone(),
                        provenance: Provenance::WorkspaceUnique,
                    });
                }
            } else if hits.len() > 1 {
                candidate_sets.push((
                    stored.id,
                    hits.into_iter().map(|hit| hit.entity_id).collect(),
                ));
            }
        }
        let Some(next) = page.next_cursor else {
            break;
        };
        cursor = next;
    }
    let stats = graph.apply_resolutions(&resolutions)?;
    sweep.resolved = stats.resolved;
    sweep.stale = stats.stale;
    if !candidate_sets.is_empty() {
        sweep.candidates_recorded = graph.record_candidates(&candidate_sets)?;
    }
    Ok(sweep)
}

/// Resolves a relative import specifier (`./x`, `../y`) onto the target
/// file's endpoint `f{file_id}`. Bare package names and alias roots stay
/// pending: they address modules outside the workspace snapshot.
///
/// # Errors
/// Propagates graph storage failures; an unmatched specifier is `None`.
fn resolve_import(
    graph: &SqliteGraphStorage,
    stored: &StoredPendingRef,
    importing_paths: &mut HashMap<u32, Option<String>>,
) -> crate::storage::graph::Result<Option<Resolution>> {
    let reference = &stored.reference;
    if reference.reference_kind != EdgeKind::Imports
        || !(reference.reference_name.starts_with("./")
            || reference.reference_name.starts_with("../"))
    {
        return Ok(None);
    }
    let path = match importing_paths.entry(stored.file_id) {
        Entry::Occupied(entry) => entry.get().clone(),
        Entry::Vacant(entry) => entry.insert(graph.file_path(stored.file_id)?).clone(),
    };
    let Some(path) = path else {
        // A file without a persisted path cannot anchor a relative specifier.
        return Ok(None);
    };
    let Some(base) = join_specifier(importing_dir(&path), &reference.reference_name) else {
        return Ok(None);
    };
    for candidate in path_variants(&base, extensions_for(&reference.language)) {
        if let Some(file_id) = graph.file_id_by_path(&candidate)? {
            return Ok(Some(Resolution {
                ref_id: stored.id,
                target_id: format!("f{file_id}"),
                provenance: Provenance::ImportScoped,
            }));
        }
    }
    Ok(None)
}

/// Directory prefix of a forward-slash workspace path; the workspace root
/// itself is the empty string.
fn importing_dir(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) => &path[..index],
        None => "",
    }
}

/// Joins a relative specifier onto the importing directory, folding `.` and
/// `..` segments. Returns `None` when the specifier names no file (`./`) or
/// the joined path escapes the root.
fn join_specifier(dir: &str, specifier: &str) -> Option<String> {
    let mut segments: Vec<&str> = Vec::new();
    for segment in dir.split('/').filter(|segment| !segment.is_empty()) {
        segments.push(segment);
    }
    let mut named = false;
    for segment in specifier.split('/').filter(|segment| !segment.is_empty()) {
        match segment {
            "." => continue,
            ".." => {
                segments.pop()?;
            }
            _ => {
                segments.push(segment);
                named = true;
            }
        }
    }
    if !named {
        return None;
    }
    Some(segments.join("/")).filter(|joined| !joined.is_empty())
}

/// Path candidates for one specifier: the literal base first (explicit
/// extensions win), then per-language extensions, then directory index files.
fn path_variants(base: &str, extensions: &[&str]) -> Vec<String> {
    let mut variants = vec![base.to_owned()];
    variants.extend(
        extensions
            .iter()
            .map(|extension| format!("{base}{extension}")),
    );
    variants.extend(
        extensions
            .iter()
            .map(|extension| format!("{base}/index{extension}")),
    );
    variants
}

/// Extension preference per reference language, mirroring the TypeScript
/// extension table: source order over compiled siblings.
fn extensions_for(language: &str) -> &'static [&'static str] {
    match language {
        "typescript" => &[".ts", ".tsx", ".js", ".jsx"],
        "javascript" => &[".js", ".jsx"],
        "python" => &[".py"],
        "rust" => &[".rs"],
        "go" => &[".go"],
        "java" => &[".java"],
        "c" => &[".c", ".h"],
        "cpp" => &[".cpp", ".cc", ".cxx", ".hpp", ".h"],
        _ => &[],
    }
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

    fn pending_reference(
        from_node_id: &str,
        reference_name: &str,
        kind: crate::storage::graph::EdgeKind,
        language: &str,
    ) -> crate::storage::graph::PendingRef {
        crate::storage::graph::PendingRef {
            from_node_id: from_node_id.to_owned(),
            reference_name: reference_name.to_owned(),
            receiver_name: None,
            reference_kind: kind,
            arity: None,
            line: 1,
            col: 0,
            metadata: serde_json::Map::new(),
            candidates: None,
            language: language.to_owned(),
            name_tail: reference_name
                .rsplit("::")
                .next()
                .unwrap_or_default()
                .to_owned(),
        }
    }

    fn graph_with_pending(entities: Vec<EntityRecord>, reference_name: &str) -> FileGraph {
        FileGraph {
            pending_refs: vec![pending_reference(
                "f9",
                reference_name,
                crate::storage::graph::EdgeKind::Calls,
                "typescript",
            )],
            ..empty_graph(entities)
        }
    }

    fn graph_with_import(from_node_id: &str, specifier: &str) -> FileGraph {
        FileGraph {
            pending_refs: vec![pending_reference(
                from_node_id,
                specifier,
                crate::storage::graph::EdgeKind::Imports,
                "typescript",
            )],
            ..empty_graph(Vec::new())
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
                "lib/helper.ts",
                &empty_graph(vec![record("entity-helper", "helper")]),
                &[],
            )
            .expect("definition write");
        graph
            .write_file_graph(9, "run.ts", &graph_with_pending(Vec::new(), "helper"), &[])
            .expect("reference write");

        let sweep = resolve_pending(&mut graph).expect("sweep");

        assert_eq!(
            sweep,
            ResolutionSweep {
                scanned: 1,
                resolved: 1,
                stale: 0,
                candidates_recorded: 0,
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
    fn ambiguous_names_stay_pending_and_record_candidates() {
        let mut graph = open_memory();
        graph
            .write_file_graph(
                1,
                "first.ts",
                &empty_graph(vec![record("first", "helper")]),
                &[],
            )
            .expect("first write");
        graph
            .write_file_graph(
                2,
                "second.ts",
                &empty_graph(vec![record("second", "helper")]),
                &[],
            )
            .expect("second write");
        graph
            .write_file_graph(9, "run.ts", &graph_with_pending(Vec::new(), "helper"), &[])
            .expect("reference write");

        let sweep = resolve_pending(&mut graph).expect("sweep");

        assert_eq!(sweep.scanned, 1);
        assert_eq!(sweep.resolved, 0);
        assert_eq!(sweep.candidates_recorded, 1);
        let page = graph.list_pending_refs(10, 0).expect("pending page");
        let [stored] = page.refs.as_slice() else {
            panic!("expected one pending ref");
        };
        assert_eq!(
            stored.reference.candidates,
            Some(vec!["first".to_owned(), "second".to_owned()])
        );
    }

    #[test]
    fn same_file_hits_stay_pending() {
        let mut graph = open_memory();
        graph
            .write_file_graph(
                9,
                "run.ts",
                &graph_with_pending(vec![record("local", "helper")], "helper"),
                &[],
            )
            .expect("write");

        let sweep = resolve_pending(&mut graph).expect("sweep");

        assert_eq!(sweep.scanned, 1);
        assert_eq!(sweep.resolved, 0);
        assert_eq!(sweep.candidates_recorded, 0);
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
    fn relative_imports_resolve_to_the_target_file() {
        let mut graph = open_memory();
        graph
            .write_file_graph(1, "lib/helper.ts", &empty_graph(vec![]), &[])
            .expect("definition write");
        graph
            .write_file_graph(9, "run.ts", &graph_with_import("f9", "./lib/helper"), &[])
            .expect("import write");

        let sweep = resolve_pending(&mut graph).expect("sweep");

        assert_eq!(sweep.resolved, 1);
        assert!(
            graph
                .list_pending_refs(10, 0)
                .expect("pending page")
                .refs
                .is_empty()
        );
        let inbound = graph
            .neighborhood(
                "f1",
                crate::storage::graph::Direction::In,
                Some(&[crate::storage::graph::EdgeKind::Imports]),
            )
            .expect("inbound imports");
        assert_eq!(inbound.len(), 1);
        assert_eq!(inbound[0].source, "f9");
        assert_eq!(inbound[0].target, "f1");
        assert_eq!(inbound[0].provenance, Provenance::ImportScoped);
    }

    #[test]
    fn imports_fall_through_extension_and_index_variants() {
        let mut graph = open_memory();
        graph
            .write_file_graph(4, "nested/utils/index.ts", &empty_graph(vec![]), &[])
            .expect("index file write");
        graph
            .write_file_graph(5, "values.ts", &empty_graph(vec![]), &[])
            .expect("values file write");
        graph
            .write_file_graph(
                9,
                "nested/run.ts",
                &FileGraph {
                    pending_refs: vec![
                        pending_reference(
                            "f9",
                            "./utils",
                            crate::storage::graph::EdgeKind::Imports,
                            "typescript",
                        ),
                        pending_reference(
                            "f9",
                            "../values",
                            crate::storage::graph::EdgeKind::Imports,
                            "typescript",
                        ),
                    ],
                    ..empty_graph(Vec::new())
                },
                &[],
            )
            .expect("import write");

        let sweep = resolve_pending(&mut graph).expect("sweep");

        assert_eq!(sweep.resolved, 2);
        let resolved = graph
            .neighborhood("f9", crate::storage::graph::Direction::Out, None)
            .expect("outbound");
        let targets: Vec<_> = resolved
            .iter()
            .filter(|edge| edge.kind == crate::storage::graph::EdgeKind::Imports)
            .map(|edge| edge.target.as_str())
            .collect();
        assert_eq!(targets, ["f4", "f5"]);
    }

    #[test]
    fn bare_and_unmatched_imports_stay_pending() {
        let mut graph = open_memory();
        graph
            .write_file_graph(9, "run.ts", &graph_with_import("f9", "react"), &[])
            .expect("bare write");
        graph
            .write_file_graph(
                10,
                "other.ts",
                &graph_with_import("f10", "./missing/module"),
                &[],
            )
            .expect("missing write");
        graph
            .write_file_graph(
                11,
                "deep/nested.ts",
                &graph_with_import("f11", "../../escape"),
                &[],
            )
            .expect("escape write");

        let sweep = resolve_pending(&mut graph).expect("sweep");

        assert_eq!(sweep.scanned, 3);
        assert_eq!(sweep.resolved, 0);
        assert_eq!(
            graph
                .list_pending_refs(10, 0)
                .expect("pending page")
                .refs
                .len(),
            3
        );
    }

    #[test]
    fn an_empty_queue_is_a_noop() {
        let mut graph = open_memory();

        let sweep = resolve_pending(&mut graph).expect("sweep");

        assert_eq!(sweep, ResolutionSweep::default());
    }

    #[test]
    fn import_paths_join_and_fold_parent_segments() {
        assert_eq!(join_specifier("lib", "./helper"), Some("lib/helper".into()));
        assert_eq!(
            join_specifier("lib/nested", "../helper"),
            Some("lib/helper".into())
        );
        assert_eq!(join_specifier("", "./helper"), Some("helper".into()));
        assert_eq!(join_specifier("lib", "../escape"), Some("escape".into()));
        assert_eq!(join_specifier("lib", "../../escape"), None);
        assert_eq!(join_specifier("lib", "./"), None);
    }
}
