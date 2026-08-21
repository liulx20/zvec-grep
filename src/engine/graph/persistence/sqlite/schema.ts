export const SQLITE_GRAPH_SCHEMA_VERSION = 1;

export const SQLITE_GRAPH_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS graph_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY) STRICT;
CREATE TABLE IF NOT EXISTS symbols (
 id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 name TEXT, kind TEXT NOT NULL, is_exported INTEGER NOT NULL CHECK (is_exported IN (0,1)),
 signature TEXT, arity INTEGER, return_type TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS reference_edges (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
 owner_is_file INTEGER NOT NULL CHECK (owner_is_file IN (0,1)),
 ref_name TEXT NOT NULL, ref_kind TEXT NOT NULL, line INTEGER NOT NULL,
 imported_name TEXT, local_name TEXT,
 source_language TEXT,
 receiver_kind TEXT, receiver_name TEXT, member_name TEXT, resolution_hints TEXT,
 target_symbol_id TEXT REFERENCES symbols(id) ON DELETE SET NULL,
 target_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
 edge_kind TEXT, edge_rel TEXT,
 status TEXT NOT NULL CHECK (status IN ('pending','failed','external','resolved','dynamic')),
 last_attempt INTEGER NOT NULL DEFAULT 0,
 dynamic_reason TEXT,
 provenance TEXT CHECK (provenance IS NULL OR provenance IN ('static','heuristic')),
 confidence REAL, evidence TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS contains (
 parent_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
 child_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
 PRIMARY KEY(parent_id,child_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS symbol_edges (
 src_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
 dst_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK (kind IN ('CALLS','REFS','INHERITS')),
 rel TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
 first_line INTEGER NOT NULL DEFAULT 0, ref_name TEXT NOT NULL DEFAULT '',
 provenance TEXT NOT NULL DEFAULT 'static' CHECK (provenance IN ('static','heuristic')),
 confidence REAL NOT NULL DEFAULT 1.0,
 evidence TEXT,
 PRIMARY KEY(src_id,dst_id,kind,rel)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS file_imports (
 src_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 dst_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 spec TEXT NOT NULL, PRIMARY KEY(src_file_id,dst_file_id,spec)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS file_import_bindings (
 src_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 dst_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 local_name TEXT NOT NULL, imported_name TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(src_file_id,local_name,dst_file_id,imported_name)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS instantiates (
 src_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
 type_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
 first_line INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(src_id,type_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS edge_candidates (
 edge_id TEXT NOT NULL REFERENCES reference_edges(id) ON DELETE CASCADE,
 target_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
 reason TEXT NOT NULL, confidence REAL NOT NULL,
 PRIMARY KEY(edge_id,target_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS symbols_file_id_idx ON symbols(file_id);
CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name) WHERE name IS NOT NULL;
CREATE INDEX IF NOT EXISTS symbol_edges_src_kind_idx ON symbol_edges(src_id,kind);
CREATE INDEX IF NOT EXISTS symbol_edges_dst_kind_idx ON symbol_edges(dst_id,kind);
CREATE INDEX IF NOT EXISTS contains_child_idx ON contains(child_id);
CREATE INDEX IF NOT EXISTS file_imports_dst_idx ON file_imports(dst_file_id);
CREATE INDEX IF NOT EXISTS file_import_bindings_local_idx ON file_import_bindings(src_file_id,local_name);
CREATE INDEX IF NOT EXISTS reference_edges_name_idx ON reference_edges(ref_name,status);
CREATE INDEX IF NOT EXISTS reference_edges_owner_idx ON reference_edges(owner_id,owner_is_file);
CREATE INDEX IF NOT EXISTS reference_edges_retry_idx ON reference_edges(ref_name,status,last_attempt,id);
CREATE INDEX IF NOT EXISTS reference_edges_target_symbol_idx ON reference_edges(target_symbol_id,status);
CREATE INDEX IF NOT EXISTS reference_edges_target_file_idx ON reference_edges(target_file_id,status);
CREATE INDEX IF NOT EXISTS reference_edges_member_idx ON reference_edges(member_name,status);
CREATE INDEX IF NOT EXISTS instantiates_type_idx ON instantiates(type_id);
`;
