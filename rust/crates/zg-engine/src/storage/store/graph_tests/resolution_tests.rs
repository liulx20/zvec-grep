use super::*;

fn status(store: &IndexStore, file: &FileRecord, status: FileIndexStatus) {
    let mut file = file.clone();
    file.index_status = status;
    store
        .write(|state| {
            let directories = state.directories.ensure(&file.relative_path)?;
            state.files.put(&file, &directories)?;
            state.files.flush()
        })
        .expect("set interrupted file state");
}

fn named(store: &IndexStore, path: &str) -> Snapshot {
    let mut target = snapshot(store, path, &["target"]);
    target.graph.nodes[0].name = Some("target".into());
    target.graph.nodes[0].qualified_name = "target".into();
    target.graph.nodes[0].is_exported = true;
    target.graph.nodes[0].arity = Some(0);
    write(store, &target);
    target
}

#[test]
fn missing_graph_with_only_unfinished_files_can_recover() {
    let temporary = tempfile::tempdir().expect("workspace");
    let store = open(temporary.path(), false);
    let unfinished = snapshot(&store, "unfinished.rs", &["target"]);
    status(&store, &unfinished.file, FileIndexStatus::NotIndexed);
    store.close().expect("close writer");
    fs::remove_file(temporary.path().join("graph/graph.sqlite")).expect("remove graph");
    let store = open(temporary.path(), false);
    store
        .with_resolution_session(|session| {
            assert!(session.lookup_candidates("target")?.is_none());
            Ok(())
        })
        .expect("defer until reconstruction");
    let mut recovered = unfinished;
    recovered.graph.nodes[0].name = Some("target".into());
    write(&store, &recovered);
    store
        .with_resolution_session(|session| {
            assert_eq!(
                session
                    .lookup_candidates("target")?
                    .expect("reconstructed names")
                    .len(),
                1
            );
            Ok(())
        })
        .expect("recover unfinished file");
}

#[cfg(unix)]
#[test]
fn native_paths_do_not_merge_backslashes_or_lossy_unicode() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let temporary = tempfile::tempdir().expect("workspace");
    let store = open(temporary.path(), false);
    let backslash = named(&store, r"src\target.rs");
    let nested = named(&store, "src/target.rs");
    let unicode = named(&store, "src/�.rs");
    let mut native = snapshot(
        &store,
        OsString::from_vec(b"src/\xff.rs".to_vec()),
        &["native"],
    );
    let mut import = reference(&native.entities[0]);
    import.ref_kind = GraphEdgeKind::Imports;
    native.graph.pending_refs.push(import);
    write(&store, &native);
    named(&store, r"only\child.rs");
    let descendant = snapshot(
        &store,
        OsString::from_vec(b"package/\xff.rs".to_vec()),
        &["child"],
    );
    write(&store, &descendant);
    store
        .with_resolution_session(|session| {
            for file in [&backslash.file, &nested.file, &unicode.file] {
                let path = file.relative_path.to_str().expect("Unicode fixture");
                assert_eq!(session.file_id_by_path(path)?, Some(file.id.get()));
                assert_eq!(session.file_path(file.id.get())?.as_deref(), Some(path));
            }
            assert_eq!(session.file_path(native.file.id.get())?, None);
            assert!(!session.path_has_module("only", &[])?);
            assert!(!session.path_has_module("only/child", &["rs"])?);
            assert!(session.path_has_module(r"only\child", &["rs"])?);
            assert!(session.path_has_module("src", &[])?);
            assert!(session.path_has_module("package", &[])?);
            assert!(!session.path_has_module("pack", &[])?);
            assert!(!session.path_has_module("package/�", &["rs"])?);
            let pending = session.list_pending_refs(10, 0)?.refs.remove(0);
            let target_id = nested.file.id.get();
            assert_eq!(
                session
                    .apply_resolutions(&[Resolution {
                        ref_id: pending.id,
                        target_id: format!("f{target_id}"),
                        provenance: EdgeProvenance::ImportScoped,
                    }])?
                    .resolved,
                1
            );
            assert_eq!(
                session.imported_file_ids(native.file.id.get())?,
                vec![target_id]
            );
            Ok(())
        })
        .expect("lossless resolver paths");
}

#[test]
fn hidden_reference_pages_preserve_cursor_and_do_not_block_ready_files() {
    let temporary = tempfile::tempdir().expect("fixture operation");
    let store = open(temporary.path(), false);
    let mut hidden = snapshot(&store, "hidden.rs", &["hidden"]);
    for line in 1..=2 {
        let mut reference = reference(&hidden.entities[0]);
        reference.line = line;
        hidden.graph.pending_refs.push(reference);
    }
    write(&store, &hidden);
    let mut ready = snapshot(&store, "ready.rs", &["ready"]);
    ready.graph.pending_refs.push(reference(&ready.entities[0]));
    write(&store, &ready);
    let hidden_ids: Vec<_> = pending(&store)
        .into_iter()
        .filter(|r| r.file_id == hidden.file.id.get())
        .map(|r| r.id)
        .collect();
    status(&store, &hidden.file, FileIndexStatus::NotIndexed);
    store
        .with_resolution_session(|session| {
            let first = session.list_pending_refs(1, 0)?;
            assert!(first.refs.is_empty());
            let second =
                session.list_pending_refs(1, first.next_cursor.expect("fixture operation"))?;
            assert!(second.refs.is_empty());
            let third =
                session.list_pending_refs(1, second.next_cursor.expect("fixture operation"))?;
            assert_eq!(third.refs.len(), 1);
            assert_eq!(third.refs[0].file_id, ready.file.id.get());
            assert!(third.next_cursor.is_none());
            assert_eq!(session.apply_failures(&hidden_ids)?, 0);
            assert_eq!(session.apply_failures(&[third.refs[0].id])?, 1);
            Ok(())
        })
        .expect("fixture operation");
    assert_eq!(pending(&store).len(), 2, "hidden references stay retryable");
}

#[test]
fn incomplete_candidates_defer_uniqueness_and_ready_names_still_resolve() {
    let temporary = tempfile::tempdir().expect("fixture operation");
    let store = open(temporary.path(), false);
    let hidden = named(&store, "hidden.rs");
    let ready = named(&store, "ready.rs");
    status(&store, &hidden.file, FileIndexStatus::Deleting);
    store
        .with_resolution_session(|session| {
            assert!(
                session.lookup_candidates("target")?.is_none(),
                "one hidden candidate must not imply a unique ready target"
            );
            assert_eq!(session.file_id_by_path("hidden.rs")?, None);
            assert_eq!(session.file_path(hidden.file.id.get())?, None);
            assert!(
                session.path_has_module("hidden", &["rs"])?,
                "unfinished is not external"
            );
            assert_eq!(
                session.file_id_by_path("ready.rs")?,
                Some(ready.file.id.get())
            );
            Ok(())
        })
        .expect("fixture operation");
    store
        .delete_file(hidden.file.id)
        .expect("fixture operation");
    store
        .with_resolution_session(|session| {
            let candidates = session
                .lookup_candidates("target")?
                .expect("fixture operation");
            assert_eq!(candidates.len(), 1);
            assert_eq!(candidates[0].entity_id, ready.entities[0].id.as_str());
            Ok(())
        })
        .expect("fixture operation");
}

#[test]
fn writeback_requires_issued_references_and_visible_canonical_targets() {
    let temporary = tempfile::tempdir().expect("fixture operation");
    let store = open(temporary.path(), false);
    let target = named(&store, "target.rs");
    let hidden = named(&store, "hidden.rs");
    status(&store, &hidden.file, FileIndexStatus::NotIndexed);
    let mut source = snapshot(&store, "source.rs", &["caller"]);
    source
        .graph
        .pending_refs
        .push(reference(&source.entities[0]));
    write(&store, &source);
    let id = pending(&store)[0].id;
    let proposal = |target_id: &str| Resolution {
        ref_id: id,
        target_id: target_id.into(),
        provenance: EdgeProvenance::WorkspaceUnique,
    };
    store
        .with_resolution_session(|session| {
            let valid = proposal(target.entities[0].id.as_str());
            assert_eq!(
                session
                    .apply_resolutions(std::slice::from_ref(&valid))?
                    .resolved,
                0,
                "must first read the reference in this session"
            );
            session.list_pending_refs(100, 0)?;
            for endpoint in [
                "absent".to_owned(),
                hidden.entities[0].id.as_str().to_owned(),
                format!("f{}", hidden.file.id.get()),
            ] {
                let stats = session.apply_resolutions(&[proposal(&endpoint)])?;
                assert_eq!((stats.resolved, stats.stale), (0, 1));
            }
            assert_eq!(
                session.record_candidates(&[(id, vec![hidden.entities[0].id.as_str().into()])])?,
                0
            );
            assert_eq!(
                session.record_candidates(&[(id, vec![target.entities[0].id.as_str().into()])])?,
                1
            );
            assert_eq!(session.apply_resolutions(&[valid])?.resolved, 1);
            assert_eq!(
                session.apply_failures(&[id])?,
                0,
                "resolved rows cannot be changed to failed"
            );
            Ok(())
        })
        .expect("fixture operation");
    assert_eq!(callers(&store, &target.entities[0]).len(), 1);
    store.close().expect("fixture operation");
    let reader = open(temporary.path(), true);
    assert!(
        reader
            .with_resolution_session::<()>(|_| panic!("read-only session must be rejected"))
            .is_err()
    );
    reader.close().expect("fixture operation");
    assert!(
        reader
            .with_resolution_session::<()>(|_| panic!("closed session must be rejected"))
            .is_err()
    );
}

#[test]
fn file_endpoint_writeback_and_import_scope_obey_file_visibility() {
    let temporary = tempfile::tempdir().expect("fixture operation");
    let store = open(temporary.path(), false);
    let target = named(&store, "target.rs");
    let mut source = snapshot(&store, "source.rs", &["caller"]);
    let mut import = reference(&source.entities[0]);
    import.ref_kind = GraphEdgeKind::Imports;
    import.ref_name = "./target".into();
    source.graph.pending_refs.push(import);
    write(&store, &source);
    store
        .with_resolution_session(|session| {
            let reference = session.list_pending_refs(10, 0)?.refs.remove(0);
            let file_id = session
                .file_id_by_path("target.rs")?
                .expect("fixture operation");
            let stats = session.apply_resolutions(&[Resolution {
                ref_id: reference.id,
                target_id: format!("f{file_id}"),
                provenance: EdgeProvenance::ImportScoped,
            }])?;
            assert_eq!(stats.resolved, 1);
            assert_eq!(
                session.imported_file_ids(source.file.id.get())?,
                vec![file_id]
            );
            Ok(())
        })
        .expect("fixture operation");
    status(&store, &target.file, FileIndexStatus::Deleting);
    store
        .with_resolution_session(|session| {
            assert!(session.imported_file_ids(source.file.id.get())?.is_empty());
            Ok(())
        })
        .expect("fixture operation");
}

#[test]
fn an_unfinished_new_file_defers_names_even_before_its_graph_is_written() {
    let temporary = tempfile::tempdir().expect("workspace");
    let store = open(temporary.path(), false);
    let ready = named(&store, "ready.rs");
    let unfinished = snapshot(&store, "new.rs", &["target"]);
    status(&store, &unfinished.file, FileIndexStatus::NotIndexed);
    store
        .with_resolution_session(|session| {
            assert!(session.lookup_candidates("target")?.is_none());
            assert!(session.path_has_module("new", &["rs"])?);
            assert_eq!(session.file_id_by_path("new.rs")?, None);
            Ok(())
        })
        .expect("defer incomplete workspace");
    store
        .delete_file(unfinished.file.id)
        .expect("recover deletion");
    store
        .with_resolution_session(|session| {
            let candidates = session
                .lookup_candidates("target")?
                .expect("complete candidates");
            assert_eq!(candidates.len(), 1);
            assert_eq!(candidates[0].entity_id, ready.entities[0].id.as_str());
            assert_eq!(candidates[0].arity, Some(0));
            assert!(candidates[0].is_exported);
            Ok(())
        })
        .expect("query complete workspace");
}

#[test]
fn candidate_evidence_survives_reopen_and_is_cleared_as_a_set_on_target_changes() {
    let temporary = tempfile::tempdir().expect("workspace");
    let store = open(temporary.path(), false);
    let first = named(&store, "first.rs");
    let second = named(&store, "second.rs");
    let mut source = snapshot(&store, "source.rs", &["caller"]);
    source
        .graph
        .pending_refs
        .push(reference(&source.entities[0]));
    write(&store, &source);
    let mut targets = vec![
        first.entities[0].id.as_str().to_owned(),
        second.entities[0].id.as_str().to_owned(),
    ];
    targets.sort();
    store
        .with_resolution_session(|session| {
            let id = session.list_pending_refs(10, 0)?.refs[0].id;
            assert_eq!(session.record_candidates(&[(id, targets.clone())])?, 1);
            Ok(())
        })
        .expect("record ambiguity");
    store.close().expect("close writer");
    let store = open(temporary.path(), false);
    assert_eq!(pending(&store)[0].candidates, targets);
    write(&store, &first);
    assert!(
        pending(&store)[0].candidates.is_empty(),
        "discard all candidates, not just the changed member"
    );
    store
        .with_resolution_session(|session| {
            let id = session.list_pending_refs(10, 0)?.refs[0].id;
            assert_eq!(session.record_candidates(&[(id, targets.clone())])?, 1);
            Ok(())
        })
        .expect("record ambiguity again");
    store.delete_file(second.file.id).expect("delete candidate");
    assert!(pending(&store)[0].candidates.is_empty());
    store
        .with_resolution_session(|session| {
            let id = session.list_pending_refs(10, 0)?.refs[0].id;
            assert_eq!(
                session
                    .record_candidates(&[(id, vec![first.entities[0].id.as_str().to_owned()])])?,
                1
            );
            assert_eq!(session.apply_failures(&[id])?, 1);
            Ok(())
        })
        .expect("fail reference");
    assert!(pending(&store).is_empty());
    let raw =
        Connection::open(temporary.path().join("graph/graph.sqlite")).expect("inspect candidates");
    let count: i64 = raw
        .query_row("SELECT count(*) FROM reference_candidates", [], |row| {
            row.get(0)
        })
        .expect("candidate count");
    assert_eq!(count, 0);
}

#[test]
fn failed_candidate_batch_keeps_previous_evidence() {
    let temporary = tempfile::tempdir().expect("workspace");
    let store = open(temporary.path(), false);
    let target = named(&store, "target.rs");
    let mut source = snapshot(&store, "source.rs", &["caller"]);
    source
        .graph
        .pending_refs
        .push(reference(&source.entities[0]));
    write(&store, &source);
    let raw =
        Connection::open(temporary.path().join("graph/graph.sqlite")).expect("fault connection");
    store.with_resolution_session(|session| {
        let id = session.list_pending_refs(10, 0)?.refs[0].id;
        let targets = vec![target.entities[0].id.as_str().to_owned()];
        session.record_candidates(&[(id, targets.clone())])?;
        raw.execute_batch("CREATE TRIGGER reject_candidate BEFORE INSERT ON reference_candidates BEGIN SELECT RAISE(ABORT, 'injected candidate failure'); END;").expect("inject fault");
        assert!(session.record_candidates(&[(id, targets.clone())]).is_err());
        assert_eq!(session.list_pending_refs(10, 0)?.refs[0].candidates, targets);
        raw.execute_batch("DROP TRIGGER reject_candidate;").expect("remove fault");
        Ok(())
    }).expect("candidate transaction rollback");
}
