# Code relationships

`zg --index` persists extracted relationships in `.zvec-grep/graph.sqlite` alongside
the zvec index. Existing indexes without graph data are fully indexed on their
next update, including when the update specifies only changed paths. Node.js
22.13 or newer is required.

Relationship queries are MCP tools at the same level as `zvec_grep_search`,
available in both the agent and full toolsets:

- `callers`
- `callees`

Each accepts `{ root, symbol, limit? }`, where `root` is an absolute workspace root and
`symbol` is an exact name such as `helper`, or a scope-qualified name such as
`MyClass::method`. The pipeline maps names to indexed definitions, then queries
the graph by each entity ID. Storage queries the existing `symbol_name` index, adding an exact `symbol_scope`
filter for qualified names. A single query retrieves at most 100 index records,
then matching fragments are deduplicated into public entities. This bounds
candidates and may omit same-name definitions, especially for fragmented symbols;
use a scope-qualified name to narrow results. No full workspace entity scan or embedding model is needed.
Exact matching is case-sensitive. If no exact definition is found, the relationship pipeline reuses storage
FTS search to recall up to 100 records and resolves them to code entities without
matching their names again. Content-only mentions may return differently named
functions. Explicit scopes still match exactly. Recall depends on FTS tokenization.
This is not edit-distance typo correction.
The zvec filter parser cannot represent some backslash literals: names or scopes
with a trailing backslash or a backslash immediately before a quote are rejected
explicitly. Ordinary backslashes (for example, namespace separators) are preserved.

Results are grouped in `structuredContent.matches`. Each match contains `name`,
`filePath`, `startLine`, `endLine`, `totalEdges`, and `edges`. Names include scope when available
(for example `Worker::run`). Each edge contains only `symbol`, `line`, and `column`.
`symbol` describes the other endpoint with the same four definition fields: the
caller for `callers`, or the callee for `callees`. It is `null` if unavailable.
Edge `line` and `column` locate the call in the caller's file (the edge symbol's
file for callers, the matched definition's file for callees). Definition ranges
remain separate from call locations. Endpoint information is read after truncation
and cached within the query.

Each retrieved definition is returned as a separate group. Optional `limit` is a positive integer
that caps the edges of each matching definition independently; it defaults to 20.
Each group includes `totalEdges`, the count before truncation (zero for no edges).
If `totalEdges > edges.length`, increase `limit` to retrieve more edges. Truncation happens after querying storage and does not reduce query work. An unknown name returns
`matches: []`; a known definition without resolved relationships returns a match
with `edges: []`. Unresolved references are excluded. Queries do not refresh the index.

The query path is MCP → daemon → relationship pipeline → graph storage. Only
graph storage accepts entity IDs; callers supply symbol names. Storage holds one workspace read lock through
name resolution and edge reads, and opens and closes the zvec and SQLite
connections together. Connections are scoped to each query, not cached across
index updates. Neither `ZvecGrep` nor `WorkspaceReadSession`
exposes relationship-query methods.
The storage entry point checks readiness and owns the read-only SQLite connection.

## Indexing and recovery

The workspace write lock covers extraction, zvec and SQLite writes, and reference
resolution. File mutations are serialized within the indexing pipeline. Before a
mutation, `graph.pending.json` records the file and the union of its old and new
entity IDs. Old relationships are invalidated before zvec changes. The journal is
removed only after graph persistence and zvec finalization succeed.

If either store fails, graph output is removed and the file is marked failed for
retry. This is recoverable consistency, not a distributed transaction or restoration
of old vectors. A process interrupted mid-write leaves a journal; the next indexing
operation performs the same cleanup before retrying. Deletes are replayed as deletes.
Graph queries refuse an index with an outstanding journal. `graph.ready` records
completion of the initial full graph build. Neither sidecar stores node metadata.
Rebuild and drop remove graph data and both sidecars.

## Cross-file resolution

Language-specific cross-file matching is not implemented here. By default unresolved
references stay pending. `createZvecGrep({ graphResolver })` accepts an asynchronous
resolver called after all files have been indexed, under the same workspace write
lock. It is passed to each indexing invocation and its pipeline context;
`WorkspaceIndex` does not retain the resolver as a member or constructor option. It receives a stored pending reference and read-only `getEntity`, `listFiles`,
and `listEntitiesByFile` lookup methods. Return `{ targetId, provenance }` or `null`.
The coordinator verifies that the exact target entity (or imported file) is indexed
before writing an edge with the current reference token.

The resolver must not recursively index or modify the workspace. File changes
conservatively requeue all resolved cross-file references, since adding a symbol
can invalidate a formerly unique match without changing either endpoint. Local
relationships are retained for unchanged files. Resolution runs once after all
updates; ambiguous or missing targets must stay pending. Incremental candidate
tracking and language-specific resolution remain separate work.
