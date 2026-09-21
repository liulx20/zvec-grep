# Shared canonical storage reads

This crate contains the file/entity reads needed by the engine and future graph
consumers. It has no dependency on zg-engine, embedding models or graph storage.

- EntityReader::fetch(ids) reads canonical ID, file ID, payload and metadata.
  Missing records are omitted; duplicate requested IDs produce one record.
- EntityReader::list_ids(file_id) returns every entity ID for one file. Indexed
  queries split full batches by entity ID range, avoiding search top-k truncation
  and workspace-wide scans.
- FileReader::get(file_id) retrieves the native relative path by its f{file_id}
  key without loading the file payload.
- FileReader::list() provides lightweight file-path enumeration.
- path::PathRecord is the existing lossless path codec, moved here so lookup and
  engine serialization share the same representation.

Readers borrow canonical zvec collections already held by the caller. They do
not reopen storage, initialize another runtime, acquire locks, or write records.
Callers must retain their workspace session and coordinate reads with updates.
list_ids uses multiple queries; exclude file mutations for its entire duration.

The engine still owns schemas, writes, payload/domain decoding, recovery, and
session lifetimes. Its entity fetching and file-path reads now use this crate.
Shared entity records keep the engine payload opaque; graph consumers can use
IDs and metadata without depending on engine content types. Native handles stay
within the storage/coordinator layer. Graph integration and graph write API
changes are outside this PR.

Collections, keys, codecs and physical index version are unchanged. Existing
indexes do not require rebuilding.

Run from rust/:

    cargo test -p zg-storage
    cargo test -p zg-engine storage::
    cargo clippy -p zg-storage -p zg-engine --all-targets -- -D warnings
