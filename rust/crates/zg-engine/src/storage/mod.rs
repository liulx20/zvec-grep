//! Persistent index tables and their coordinated lifecycle.
mod directories;
mod entities;
mod files;
mod fragments;
// Query consumers and resolver rules are integrated in follow-up work.
#[cfg_attr(not(test), allow(dead_code, unused_imports))]
pub(crate) mod graph;
mod path;
pub(crate) mod read_session;
mod record;
mod store;
pub(crate) mod types;
mod zvec;

pub(crate) use store::IndexStore;

#[allow(unused_imports)]
pub(crate) use store::ResolutionSession;
