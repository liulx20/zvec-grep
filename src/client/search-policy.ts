export type SearchRefreshMode = "background" | "wait" | "off";

export type SearchPolicyInput = {
  refresh?: SearchRefreshMode;
};

export type ServerSearchPolicy = {
  freshness: "eventual" | "wait_for_fresh";
  autoUpdate: boolean;
};

export type DirectSearchPolicy = {
  freshness: "eventual" | "wait_for_fresh";
  autoUpdate: boolean;
};

export function resolveServerSearchPolicy(
  options: SearchPolicyInput,
): ServerSearchPolicy {
  const refresh = options.refresh ?? "background";
  return {
    freshness: refresh === "wait" ? "wait_for_fresh" : "eventual",
    autoUpdate: refresh !== "off",
  };
}

export function resolveDirectSearchPolicy(
  options: SearchPolicyInput,
): DirectSearchPolicy {
  const wait = options.refresh === "wait";
  return {
    freshness: wait ? "wait_for_fresh" : "eventual",
    autoUpdate: wait,
  };
}
