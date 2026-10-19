//! Persistent index tables and their coordinated lifecycle.
mod directories;
mod entities;
mod files;
mod fragments;
// Relationship reads and resolution are integrated separately from coordinated writes.
#[cfg_attr(not(test), allow(dead_code, unused_imports))]
pub(crate) mod graph;
mod path;
pub(crate) mod read_session;
mod record;
mod store;
pub(crate) mod types;
mod zvec;

pub(crate) use store::IndexStore;
