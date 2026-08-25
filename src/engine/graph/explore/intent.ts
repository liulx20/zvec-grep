export type ExploreIntent = "exact_symbol" | "concept";

/** Intent comes only from explicit API state and exact symbol resolution. */
export function resolveExploreIntent(input: {
  seedId?: string;
  hasExactSymbolGroup: boolean;
}): ExploreIntent {
  return input.seedId || input.hasExactSymbolGroup ? "exact_symbol" : "concept";
}
