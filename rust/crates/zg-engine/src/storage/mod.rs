//! Persistent index tables and their coordinated lifecycle.
mod directories;
pub(crate) mod graph;
mod entities;
mod files;
mod fragments;
mod path;
pub(crate) mod read_session;
mod record;
mod store;
pub(crate) mod types;
mod zvec;

pub(crate) use store::IndexStore;
