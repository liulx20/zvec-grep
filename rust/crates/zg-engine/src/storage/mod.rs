//! Persistent index tables and their coordinated lifecycle.
mod directories;
mod entities;
mod files;
mod fragments;
// Graph readers are owned by IndexStore; indexing writes follow separately.
#[cfg_attr(not(test), allow(dead_code, unused_imports))]
pub(crate) mod graph;
mod path;
pub(crate) mod read_session;
mod record;
mod store;
pub(crate) mod types;
mod zvec;

pub(crate) use store::IndexStore;
