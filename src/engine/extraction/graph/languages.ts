/**
 * Per-language vocabulary tables for graph relation extraction.
 *
 * Declarative configuration only — no algorithms. Adding a language means
 * extending these tables, not writing new traversal logic (the same
 * three-tier precision model the code adapters follow: shared heuristics,
 * vocabulary table, targeted hooks).
 *
 * Node type names refer to the tree-sitter grammars shipped by
 * `tree-sitter-wasms` and must be kept in sync with grammar upgrades.
 */

/**
 * Call-ish node types shared across grammars. This is the walk-time
 * equivalent of the outline collector's call heuristic: most grammars name
 * call expressions with one of these types, so a single set covers the
 * majority of languages without per-language entries.
 */
export const COMMON_CALL_TYPES: ReadonlySet<string> = new Set([
  "call",
  "call_expression",
  "function_call",
  "function_call_expression",
  "method_call",
  "method_invocation",
  "method_call_expression",
  "invocation",
  "object_creation_expression",
  "new_expression",
  "constructor_invocation",
]);

/**
 * Field names that carry the callee expression, tried in order. Grammars
 * conventionally name this field `function`, `callee`, `name`, or
 * `constructor` — the shared field-naming contract that keeps the collector
 * language-agnostic.
 */
export const CALLEE_FIELDS: readonly string[] = [
  "function",
  "callee",
  "name",
  "constructor",
];

/** Import vocabulary for one language. */
export type ImportVocabulary = {
  /** Node types that declare imports. */
  importTypes: ReadonlySet<string>;
  /**
   * Grammar field names holding the module path, tried in order. When none
   * matches, the collector falls back to parsing the node text (needed for
   * Rust, whose `use` declarations carry no path field).
   */
  moduleFields: readonly string[];
};

const JS_IMPORT_VOCABULARY: ImportVocabulary = {
  importTypes: new Set(["import_statement"]),
  moduleFields: ["source"],
};

const C_IMPORT_VOCABULARY: ImportVocabulary = {
  importTypes: new Set(["preproc_include", "preproc_include_path"]),
  moduleFields: ["path"],
};

/**
 * Import vocabulary per language format. Languages without an entry have no
 * import mechanism the collector recognizes (references still resolve via
 * same-file and workspace-unique evidence).
 */
export const IMPORT_VOCABULARY: Record<string, ImportVocabulary> = {
  typescript: JS_IMPORT_VOCABULARY,
  tsx: JS_IMPORT_VOCABULARY,
  javascript: JS_IMPORT_VOCABULARY,
  jsx: JS_IMPORT_VOCABULARY,
  python: {
    importTypes: new Set(["import_statement", "import_from_statement"]),
    moduleFields: ["module_name", "name"],
  },
  go: {
    importTypes: new Set(["import_declaration", "import_spec"]),
    moduleFields: ["path"],
  },
  java: {
    importTypes: new Set(["import_declaration"]),
    moduleFields: ["name"],
  },
  c: C_IMPORT_VOCABULARY,
  cpp: C_IMPORT_VOCABULARY,
  rust: {
    importTypes: new Set(["use_declaration_list", "use_declaration"]),
    // `use a::b::{c, d};` has no single path field — text fallback applies.
    moduleFields: [],
  },
};

/**
 * Grammar field names holding the superclass expression for class-like
 * entities, per language. Absent entry ⇒ language has no inheritance.
 */
export const SUPERCLASS_FIELDS: Record<string, readonly string[]> = {
  typescript: ["superclass"],
  tsx: ["superclass"],
  javascript: ["superclass"],
  jsx: ["superclass"],
  python: ["superclasses"],
  java: ["superclass"],
  c: ["base_clause"],
  cpp: ["base_clause"],
};

/**
 * Grammar field names holding implemented interfaces, per language. Go's
 * implicit interface satisfaction is intentionally absent: there is no
 * syntactic `implements` clause to collect.
 */
export const INTERFACES_FIELDS: Record<string, readonly string[]> = {
  typescript: ["interfaces"],
  tsx: ["interfaces"],
  javascript: ["interfaces"],
  jsx: ["interfaces"],
  java: ["interfaces", "super_interfaces"],
};

/** Import vocabulary for a format, or undefined when unsupported. */
export function importVocabularyFor(format: string): ImportVocabulary | undefined {
  return IMPORT_VOCABULARY[format];
}

/** Superclass field names for a format (empty when unsupported). */
export function superclassFieldsFor(format: string): readonly string[] {
  return SUPERCLASS_FIELDS[format] ?? [];
}

/** Interface field names for a format (empty when unsupported). */
export function interfacesFieldsFor(format: string): readonly string[] {
  return INTERFACES_FIELDS[format] ?? [];
}
