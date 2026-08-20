import { bareName } from "./builtins.js";

export type NameEntry = {
  id: string;
  fileId: string;
  name: string;
  kind: string;
};

/** Exact / bare-name lookup used by resolvePending. */
export class NameIndex {
  private readonly byName = new Map<string, NameEntry[]>();
  private readonly byId = new Map<string, NameEntry>();

  clear(): void {
    this.byName.clear();
    this.byId.clear();
  }

  removeFile(fileId: string): void {
    for (const [id, entry] of [...this.byId]) {
      if (entry.fileId === fileId) {
        this.removeId(id);
      }
    }
  }

  upsert(entries: readonly NameEntry[]): void {
    for (const entry of entries) {
      this.removeId(entry.id);
      this.byId.set(entry.id, entry);
      const list = this.byName.get(entry.name) ?? [];
      list.push(entry);
      this.byName.set(entry.name, list);
      const bare = bareName(entry.name);
      if (bare && bare !== entry.name) {
        const bareList = this.byName.get(bare) ?? [];
        bareList.push(entry);
        this.byName.set(bare, bareList);
      }
    }
  }

  lookup(
    refName: string,
    srcFile: string,
    preferredFileIds: readonly string[] = [],
    allowBareFallback = true,
  ): NameEntry | null {
    const candidates =
      this.byName.get(refName) ??
      (allowBareFallback ? this.byName.get(bareName(refName)) : undefined) ??
      [];
    if (candidates.length === 0) {
      return null;
    }
    if (candidates.length === 1) {
      return candidates[0] ?? null;
    }
    const sameFile = candidates.filter((c) => c.fileId === srcFile);
    if (sameFile.length === 1) {
      return sameFile[0] ?? null;
    }
    if (preferredFileIds.length > 0) {
      const preferred = new Set(preferredFileIds);
      const imported = candidates.filter((c) => preferred.has(c.fileId));
      if (imported.length === 1) {
        return imported[0] ?? null;
      }
    }
    // Ambiguous across files: leave unresolved (failed).
    return null;
  }

  snapshot(): NameEntry[] {
    return [...this.byId.values()];
  }

  load(entries: readonly NameEntry[]): void {
    this.clear();
    this.upsert(entries);
  }

  private removeId(id: string): void {
    const existing = this.byId.get(id);
    if (!existing) {
      return;
    }
    this.byId.delete(id);
    for (const key of [existing.name, bareName(existing.name)]) {
      if (!key) {
        continue;
      }
      const list = this.byName.get(key);
      if (!list) {
        continue;
      }
      const next = list.filter((e) => e.id !== id);
      if (next.length === 0) {
        this.byName.delete(key);
      } else {
        this.byName.set(key, next);
      }
    }
  }
}
