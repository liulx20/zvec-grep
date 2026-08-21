export type ReferenceReceiverTarget = {
  kind: "owner" | "super" | "qualified";
  name: string;
};

export type ReferenceTarget = {
  raw: string;
  member: string;
  receiver?: ReferenceReceiverTarget;
};

const OWNER_RECEIVERS = new Set(["this", "self", "cls"]);

/** Compatibility parser for persisted/legacy raw references. */
export function referenceTargetFromRaw(raw: string): ReferenceTarget {
  const normalized = raw.replace(/->/g, ".");
  const separator = normalized.lastIndexOf(".");
  if (separator < 0) return { raw, member: normalized };
  const receiverRaw = normalized.slice(0, separator).replace(/\(\)$/, "");
  const member = normalized.slice(separator + 1);
  const kind =
    receiverRaw === "super"
      ? "super"
      : OWNER_RECEIVERS.has(receiverRaw)
        ? "owner"
        : "qualified";
  return { raw, member, receiver: { kind, name: receiverRaw } };
}

export function memberReferenceTarget(
  raw: string,
  receiver: string,
  member: string,
): ReferenceTarget {
  const parsed = referenceTargetFromRaw(`${receiver}.${member}`);
  return { ...parsed, raw };
}
