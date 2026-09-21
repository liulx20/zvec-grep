use std::{path::Path, sync::Once};
use zg_storage::{EntityReader, FileReader, path::PathRecord};
use zvec_rust::{Collection, CollectionSchema, DataType, Doc, FieldSchema, IndexParams};

fn initialize() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let config = zvec_rust::ConfigBuilder::new()
            .num_threads(2)
            .memory_limit(128 * 1024 * 1024)
            .build();
        zvec_rust::initialize(Some(&config)).expect("initialize");
    });
}

fn table(root: &Path, name: &str, fields: &[(&str, DataType, bool)]) -> Collection {
    initialize();
    let mut schema = CollectionSchema::new(name).expect("schema");
    for (name, kind, nullable) in fields {
        let mut field = FieldSchema::new(name, *kind, *nullable, 0).expect("field");
        if *name == "file_id" || *name == "entity_id" {
            field
                .set_index_params(&IndexParams::invert(true, false).expect("index"))
                .expect("attach");
        }
        schema.add_field(&field).expect("field");
    }
    Collection::create_and_open(root.join(name).to_str().expect("path"), &schema, None)
        .expect("open")
}

fn entity_table(root: &Path) -> Collection {
    table(
        root,
        "entities",
        &[
            ("file_id", DataType::Uint32, false),
            ("entity_id", DataType::String, false),
            ("payload", DataType::String, false),
            ("metadata", DataType::String, true),
        ],
    )
}

fn entity(id: &str, owner: u32) -> Doc {
    let mut doc = Doc::new().expect("doc");
    doc.set_pk(id);
    doc.add_u32("file_id", owner).expect("owner");
    doc.add_string("entity_id", id).expect("id");
    doc.add_string("payload", "{\"content\":\"retained\"}")
        .expect("payload");
    doc.add_string("metadata", "{\"symbol_name\":\"run\"}")
        .expect("metadata");
    doc
}

fn write(table: &Collection, docs: &[Doc]) {
    let result = table
        .upsert(&docs.iter().collect::<Vec<_>>())
        .expect("write");
    assert_eq!(result.error_count, 0);
    assert_eq!(
        result.success_count,
        u64::try_from(docs.len()).expect("count")
    );
}

#[test]
fn canonical_entity_fetch_and_complete_file_ids_share_the_live_collection() {
    let root = tempfile::tempdir().expect("tempdir");
    let table = entity_table(root.path());
    let ids: Vec<_> = (0..2301).map(|i| format!("00000001{i:024x}")).collect();
    for chunk in ids.chunks(500) {
        write(
            &table,
            &chunk.iter().map(|id| entity(id, 1)).collect::<Vec<_>>(),
        );
    }
    write(&table, &[entity("other-file", 2)]);
    let reader = EntityReader::new(&table);
    assert_eq!(reader.list_ids(1).expect("all IDs"), ids);
    assert_eq!(reader.list_ids(2).expect("other file"), vec!["other-file"]);
    assert!(reader.list_ids(99).expect("missing file").is_empty());
    let mut requested = ids.clone();
    requested.push("missing".into());
    requested.push(ids[0].clone());
    let records = reader.fetch(&requested).expect("batched fetch");
    assert_eq!(records.len(), ids.len());
    assert_eq!(records[&ids[0]].file_id, 1);
    assert_eq!(records[&ids[0]].payload, "{\"content\":\"retained\"}");
    assert_eq!(
        records[&ids[0]].metadata.as_ref().expect("metadata")["symbol_name"],
        "run"
    );
    table.delete_by_filter("file_id = 1").expect("delete file");
    assert!(
        reader
            .list_ids(1)
            .expect("live view after delete")
            .is_empty()
    );
    assert_eq!(
        reader.list_ids(2).expect("other file retained"),
        vec!["other-file"]
    );
}

#[test]
fn entity_reads_reject_corrupt_identity_and_metadata() {
    let root = tempfile::tempdir().expect("tempdir");
    let table = entity_table(root.path());
    let mut doc = entity("entity", 1);
    doc.add_string("metadata", "not JSON").expect("corrupt");
    write(&table, &[doc]);
    assert!(EntityReader::new(&table).fetch(&["entity".into()]).is_err());
    let mut doc = entity("entity", 1);
    doc.add_string("entity_id", "different").expect("corrupt");
    write(&table, &[doc]);
    assert!(EntityReader::new(&table).fetch(&["entity".into()]).is_err());
    assert!(EntityReader::new(&table).list_ids(1).is_err());
}

fn file(id: u32, path: &Path) -> Doc {
    let mut doc = Doc::new().expect("doc");
    doc.set_pk(&format!("f{id}"));
    doc.add_u32("file_id", id).expect("id");
    doc.add_string(
        "path",
        &serde_json::to_string(&PathRecord::from_path(path).expect("path")).expect("json"),
    )
    .expect("field");
    doc
}

#[test]
fn file_lookup_uses_numeric_identity_and_preserves_native_paths() {
    let root = tempfile::tempdir().expect("tempdir");
    let table = table(
        root.path(),
        "files",
        &[
            ("file_id", DataType::Uint32, false),
            ("path", DataType::String, false),
        ],
    );
    let path = Path::new("src/中文.rs");
    write(&table, &[file(u32::MAX, path)]);
    let reader = FileReader::new(&table);
    let stored = reader.get(u32::MAX).expect("lookup").expect("file");
    assert_eq!(stored.id, u32::MAX);
    assert_eq!(stored.relative_path, path);
    assert_eq!(reader.list().expect("list"), vec![stored]);
    assert!(reader.get(0).expect("missing").is_none());
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        let raw_path = std::path::PathBuf::from(std::ffi::OsString::from_vec(
            b"src/non-utf8-\xff.rs".to_vec(),
        ));
        write(&table, &[file(1, &raw_path)]);
        assert_eq!(
            reader.get(1).expect("native").expect("file").relative_path,
            raw_path
        );
    }
    let mut invalid = file(2, path);
    invalid.set_pk("f3");
    write(&table, &[invalid]);
    assert!(reader.get(3).is_err());
}

#[test]
fn file_lookup_rejects_paths_outside_the_workspace() {
    let root = tempfile::tempdir().expect("tempdir");
    let table = table(
        root.path(),
        "files",
        &[
            ("file_id", DataType::Uint32, false),
            ("path", DataType::String, false),
        ],
    );
    for path in [
        "../escape.rs",
        "/absolute.rs",
        "src/./file.rs",
        "src//file.rs",
    ] {
        write(&table, &[file(1, Path::new(path))]);
        assert!(FileReader::new(&table).get(1).is_err(), "{path}");
    }
}

#[test]
fn full_query_batches_handle_escaped_ids_without_truncation() {
    let root = tempfile::tempdir().expect("tempdir");
    let table = entity_table(root.path());
    let mut ids: Vec<_> = (0..1024).map(|i| format!("quoted'\\id-{i:04}")).collect();
    write(
        &table,
        &ids.iter().map(|id| entity(id, 7)).collect::<Vec<_>>(),
    );
    ids.sort();
    assert_eq!(
        EntityReader::new(&table)
            .list_ids(7)
            .expect("escaped filter bounds"),
        ids
    );
}
