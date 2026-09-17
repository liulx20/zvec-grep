import type { Entity, EntityFragment, FileInfo } from "../types.js";
import type { WorkspaceIndexStorage } from "./index.js";

export function publicEntityId(
  fragment: Pick<EntityFragment, "id" | "group">,
): string {
  return fragment.group ?? fragment.id;
}

/** Resolve a chunk to its owning definition, retaining the definition's full range. */
export function resolveStoredFragment(
  stored: { fragment: EntityFragment; file: FileInfo } | null,
  storage: Pick<WorkspaceIndexStorage, "getEntity">,
): { entity: Entity; file: FileInfo } | null {
  if (!stored) return null;
  const { fragment, file } = stored;
  const id = publicEntityId(fragment);
  if (id !== fragment.id) return storage.getEntity(id);
  return {
    file,
    entity: {
      id,
      fileId: fragment.fileId,
      range: fragment.range,
      content: fragment.content,
      metadata: fragment.metadata,
    },
  };
}
