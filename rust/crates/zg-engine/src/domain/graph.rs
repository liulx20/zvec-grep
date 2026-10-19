//! Cross-module graph extraction contracts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Edge kinds produced by the extraction layer.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GraphEdgeKind {
    Contains,
    Calls,
    Imports,
    Extends,
    Implements,
}

/// Evidence provenance recorded on persisted edges.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EdgeProvenance {
    FileLocal,
    ImportScoped,
    PreferredFile,
    WorkspaceUnique,
}

/// An edge ready for persistence after partition.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct FileEdge {
    pub kind: GraphEdgeKind,
    pub source: String,
    pub target: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub provenance: EdgeProvenance,
    pub metadata: BTreeMap<String, serde_json::Value>,
}

/// Status of a persisted pending reference.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PendingRefStatus {
    Pending,
    Resolved,
    Failed,
}

/// A reference that could not be resolved within its own file.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct PendingRef {
    pub owner_id: String,
    pub ref_name: String,
    pub receiver_name: Option<String>,
    pub ref_kind: GraphEdgeKind,
    pub arity: Option<usize>,
    pub line: usize,
    pub column: usize,
    pub status: PendingRefStatus,
    pub metadata: BTreeMap<String, serde_json::Value>,
}

/// A complete per-file snapshot. Node metadata is deliberately not stored here.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub(crate) struct FileGraph {
    /// Complete current entity IDs for ownership validation, not persisted as nodes.
    /// The zvec file key `f{file_id}` is an implicit local endpoint.
    pub entity_ids: Vec<String>,
    pub edges: Vec<FileEdge>,
    pub pending_refs: Vec<PendingRef>,
}

impl GraphEdgeKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Contains => "contains",
            Self::Calls => "calls",
            Self::Imports => "imports",
            Self::Extends => "extends",
            Self::Implements => "implements",
        }
    }
}

impl EdgeProvenance {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::FileLocal => "file_local",
            Self::ImportScoped => "import_scoped",
            Self::PreferredFile => "preferred_file",
            Self::WorkspaceUnique => "workspace_unique",
        }
    }
}
