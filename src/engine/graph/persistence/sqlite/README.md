# Graph SQLite storage

`GraphDatabase.open(path)` opens or creates a database and its parent directory.
Use `:memory:` for a temporary database. The caller owns the connection and must
await operations before calling `close()`. Repeated closes are safe.

The backend lazily loads `node:sqlite`: Node 22.13+ needs no startup flag;
22.5–22.12 require `--experimental-sqlite`. File databases use WAL and a five
second busy timeout. The indexing pipeline does not yet instantiate this backend.

## File replacement and deletion

```ts
const writer = new SqliteGraphWriter(database);
await writer.writeFileGraph(fileId, result, oldEntityIds);
await writer.deleteFileGraph(fileId, oldEntityIds);
```

Both operations require the complete old entity ID list from zvec, captured
before replacing or deleting its nodes. Pass `[]` for a newly indexed file or
one with no old entities. The list is deduplicated; the writer always adds
`fileId` to cover file-level imports. The caller is responsible for providing
IDs belonging to the file; SQLite holds no entity ownership catalog.

In one transaction the writer requeues references associated with incoming
edges targeting these IDs, rotates their tokens, and deletes the edges. It then
removes edges/references owned by the changed file. On replacement it inserts
the new local edges and pending refs. Large ID lists are processed in batches
of 500, all within the same transaction. Any failure rolls back every batch.
Unrelated edges and references are preserved. Repeated deletion is safe.

`writeFileGraph` accepts the complete file-local extraction result. Its `nodes`
are used only to validate local endpoint IDs; they are never stored. Direct edges
must have `file_local` provenance and local endpoints. Input references must be
locally owned and `pending`. Use `applyResolutions` for cross-file matches so
that resolved edges retain their original reference evidence.

## Incremental resolution writeback

`SqlitePendingRefStore` in `pending-ref-resolver.ts` is the persistence protocol
for an external language resolver. It does not implement symbol matching.

1. Call `listPendingRefs({ limit, cursor })` to obtain references and their IDs,
   owning files and tokens. Each item is flat: `id`, `token`, `fileId`,
   `ownerId`, `refName`, `receiverName`, `refKind`, `arity`, `line`, `column`,
   `status` and `metadata`. Default limit is 100; maximum is 1000.
2. Resolve targets using the node metadata in zvec and validate their current
   existence/version in the indexing pipeline.
3. Call `applyResolutions([{ refId, refToken, targetId, provenance }])`. Import
   targets may be file IDs. Target file IDs and versions are not stored here.

Writeback checks the reference token and pending status in a transaction. Stale
reference tokens and replayed results are skipped and counted in
`{ resolved, stale }`. Valid results add a linked edge and mark the original
reference resolved. Source, kind, position and metadata come from that reference.
Local edges are preserved. Errors roll back the whole batch. Resolved references
remain as evidence; target invalidation makes them pending again.

The caller must serialize target validation and writeback with file updates and
deletions, including other processes. If matching runs asynchronously, discard
or revalidate its target results after intervening file changes. Reference tokens
protect against source replacement and previously resolved edge invalidation;
they cannot detect a target changing before an as-yet-pending reference has an
edge. SQLite deliberately performs no node existence or target version checks.
Do not nest these operations in caller SQLite transactions. Cross-store atomicity,
file event scheduling and retry/resolution passes remain pipeline responsibilities.

## Relationship queries

`new SqliteGraphReader(database).neighborhood({ id, direction, kinds })`
returns the complete `FileEdge[]` array for one hop. Direction defaults to `both`;
`out` matches `source`, `in` matches `target`. Self edges appear once in `both`.
Omitting `kinds` selects every kind; `[]` selects none. References without a
resolved target and node metadata are excluded. A file ID matches file endpoints,
not every entity or edge owned by that file. Edge orientation is preserved.

Results are ordered by internal edge row ID. Distinct call sites remain distinct.
Relationship queries have no limit or cursor parameters. Pending-reference queue
pagination remains available through `listPendingRefs`; restart it after file changes.

Convenience methods accept only an ID and return the complete edge array:

```ts
const edges = await reader.getCallers(entityId);
```

`getCallers` / `getCallees` select incoming / outgoing `calls`;
`getInheritance` / `getSubclasses` select outgoing / incoming `extends`;
`getImplementations` selects incoming `implements`. `getImports(fileId)`
selects `imports` owned by the file (`file_id`), rather than matching an endpoint.
These methods read all matching edges through the shared query engine and expose
no limit or cursor parameters, matching `neighborhood`.

## Schema and migrations

Schema v1 contains only `edges` and `pending_refs`. Node and file metadata stay
in zvec. `edges.ref_id` links a resolved edge to its reference evidence; reference
tokens prevent stale source results from binding to reused SQLite row IDs. There
is one resolved edge per reference; ambiguous matches remain pending. Line
numbers are one-based and columns are zero-based. Metadata is a JSON object.

`user_version` tracks ordered transactional migrations and `application_id`
identifies graph databases. Higher schema versions and unrelated databases are
rejected. This initial schema creates the two tables directly. Future schema
changes append a migration and increment the version.
