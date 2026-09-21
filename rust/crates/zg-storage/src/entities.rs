use std::{collections::HashMap, fmt::Write};

use crate::{BATCH, Error, Result, fetch, file_id, native, string_field};
use zvec_rust::{Collection, Doc, SearchQuery};

/// Canonical entity columns. Payload decoding belongs to the consuming domain.
#[derive(Clone, Debug, PartialEq)]
pub struct EntityRecord {
    pub id: String,
    pub file_id: u32,
    pub payload: String,
    pub metadata: Option<serde_json::Value>,
}

impl EntityRecord {
    /// Decodes canonical columns and validates their indexed identity.
    ///
    /// # Errors
    /// Rejects missing fields, mismatched identity, and malformed metadata.
    pub fn from_doc(doc: &Doc) -> Result<Self> {
        let id = entity_id(doc)?;
        let metadata = if doc.has_field("metadata") && !doc.is_field_null("metadata") {
            Some(
                serde_json::from_str(&string_field(doc, "metadata")?)
                    .map_err(|error| Error::Storage(format!("invalid entity metadata: {error}")))?,
            )
        } else {
            None
        };
        Ok(Self {
            id,
            file_id: file_id(doc)?,
            payload: string_field(doc, "payload")?,
            metadata,
        })
    }
}

/// Reads the canonical entities collection through an existing workspace session.
pub struct EntityReader<'a> {
    collection: &'a Collection,
}

impl<'a> EntityReader<'a> {
    /// Borrows the engine's canonical entities collection.
    #[must_use]
    pub const fn new(collection: &'a Collection) -> Self {
        Self { collection }
    }

    /// Fetches canonical records by entity ID. Missing IDs are omitted.
    ///
    /// # Errors
    /// Returns native read errors or invalid stored records.
    pub fn fetch(&self, ids: &[String]) -> Result<HashMap<String, EntityRecord>> {
        fetch(self.collection, ids, None)?
            .into_iter()
            .map(|doc| EntityRecord::from_doc(&doc).map(|record| (record.id.clone(), record)))
            .collect()
    }

    /// Returns every canonical entity ID owned by a file, sorted and deduplicated.
    /// Bounded indexed queries are partitioned when full; no retrieval limit can
    /// silently drop IDs needed by deletion. The caller must exclude concurrent
    /// mutations across the entire read.
    ///
    /// # Errors
    /// Returns native query errors or inconsistent indexed identities.
    pub fn list_ids(&self, owner: u32) -> Result<Vec<String>> {
        let mut ranges: Vec<(Option<String>, Option<String>)> = vec![(None, None)];
        let mut result = Vec::new();
        while let Some((lower, upper)) = ranges.pop() {
            let mut filter = format!("file_id = {owner}");
            if let Some(lower) = &lower {
                let _ = write!(filter, " AND entity_id >= {}", literal(lower));
            }
            if let Some(upper) = &upper {
                let _ = write!(filter, " AND entity_id < {}", literal(upper));
            }
            let mut query = native(SearchQuery::scalar(1024), "create entity ID query")?;
            native(query.set_filter(&filter), "filter entity IDs")?;
            native(
                query.set_output_fields(&["file_id", "entity_id"]),
                "project entity IDs",
            )?;
            native(query.set_include_vector(false), "omit vectors")?;
            let docs = native(self.collection.query(&query), "query file entities")?;
            let mut ids = Vec::with_capacity(docs.len());
            for doc in docs {
                if file_id(&doc)? != owner {
                    return Err(Error::Storage(
                        "entity query returned another file's record".into(),
                    ));
                }
                let id = entity_id(&doc)?;
                if lower.as_ref().is_some_and(|bound| id < *bound)
                    || upper.as_ref().is_some_and(|bound| id >= *bound)
                {
                    return Err(Error::Storage(
                        "entity query returned an ID outside its requested range".into(),
                    ));
                }
                ids.push(id);
            }
            ids.sort_unstable();
            ids.dedup();
            if ids.len() < BATCH {
                result.extend(ids);
            } else {
                let pivot = ids[ids.len() / 2].clone();
                ranges.push((Some(pivot.clone()), upper));
                ranges.push((lower, Some(pivot)));
            }
        }
        result.sort_unstable();
        result.dedup();
        Ok(result)
    }
}

fn entity_id(doc: &Doc) -> Result<String> {
    let id = string_field(doc, "entity_id")?;
    if doc.get_pk() != Some(id.as_str()) {
        return Err(Error::Storage(
            "entity identity differs from its index fields".into(),
        ));
    }
    Ok(id)
}

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "\\'"))
}
