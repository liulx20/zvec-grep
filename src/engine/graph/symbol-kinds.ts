/** Symbol kinds that may be the target of a call relation. */
export const CALLABLE_SYMBOL_KINDS = [
  "function",
  "method",
  "constructor",
  "abstract_method",
] as const;

export const CALLABLE_SYMBOL_KIND_SET: ReadonlySet<string> = new Set(
  CALLABLE_SYMBOL_KINDS,
);

/** Symbol kinds that can participate as the target of an inheritance edge. */
export const INHERITABLE_SYMBOL_KINDS = [
  "class",
  "abstract_class",
  "interface",
  "struct",
  "trait",
  "type",
  "typealias",
] as const;

export const INHERITABLE_SYMBOL_KIND_SET: ReadonlySet<string> = new Set(
  INHERITABLE_SYMBOL_KINDS,
);

/** Type-like symbols used by Explore seed and impact policy. */
export const TYPE_SYMBOL_KIND_SET: ReadonlySet<string> = new Set([
  ...INHERITABLE_SYMBOL_KINDS,
  "component",
  "enum",
  "union",
]);

/** SQL tuple body for static queries owned by the graph persistence layer. */
export const CALLABLE_SYMBOL_KINDS_SQL = CALLABLE_SYMBOL_KINDS.map(
  (kind) => `'${kind}'`,
).join(",");

export function isCallableSymbolKind(kind: string | undefined): boolean {
  return kind !== undefined && CALLABLE_SYMBOL_KIND_SET.has(kind);
}
