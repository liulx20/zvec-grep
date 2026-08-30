import { bareName } from "./builtins.js";
import { isHeaderPath } from "./path-policy.js";
import type { ResolutionEvidence } from "./types.js";

export type NameEntry = {
  id: string;
  fileId: string;
  filePath?: string;
  name: string;
  qualifiedName?: string;
  kind: string;
  isExported?: boolean;
  signature?: string;
  startLine?: number;
  containerName?: string;
  containerId?: string;
};

export type NameLookupResult = {
  entry: NameEntry;
  evidence: ResolutionEvidence;
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
      for (const key of entryLookupKeys(entry)) {
        const list = this.byName.get(key) ?? [];
        list.push(entry);
        this.byName.set(key, list);
      }
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
    containerNames: readonly string[] = [],
    containerIds: readonly string[] = [],
  ): NameEntry | null {
    return (
      this.lookupWithEvidence(
        refName,
        srcFile,
        preferredFileIds,
        allowBareFallback,
        containerNames,
        containerIds,
      )?.entry ?? null
    );
  }

  lookupWithEvidence(
    refName: string,
    srcFile: string,
    preferredFileIds: readonly string[] = [],
    allowBareFallback = true,
    containerNames: readonly string[] = [],
    containerIds: readonly string[] = [],
    allowedKinds: ReadonlySet<string> | undefined = undefined,
  ): NameLookupResult | null {
    const exactCandidates = this.byName.get(refName);
    let candidates =
      exactCandidates ??
      (allowBareFallback ? this.byName.get(bareName(refName)) : undefined) ??
      [];
    if (allowedKinds) {
      candidates = candidates.filter((candidate) =>
        allowedKinds.has(candidate.kind),
      );
    }
    if (containerNames.length > 0) {
      const containers = new Set(containerNames);
      const scoped = candidates.filter(
        (candidate) =>
          candidate.containerName !== undefined &&
          containers.has(candidate.containerName),
      );
      // A fully qualified symbol name already supplies equivalent scope
      // evidence for languages where namespaces/modules are not graph nodes.
      if (scoped.length === 1)
        return { entry: scoped[0]!, evidence: "container_scope" };
      if (scoped.length > 1) {
        const preferred = new Set(preferredFileIds);
        const visibleScoped = scoped.filter((candidate) =>
          preferred.has(candidate.fileId),
        );
        if (visibleScoped.length === 1)
          return { entry: visibleScoped[0]!, evidence: "preferred_file" };
        const counterpart =
          crossFileDeclarationDefinitionGroup(visibleScoped) ??
          equivalentDeclarationGroup(visibleScoped);
        return counterpart
          ? { entry: counterpart, evidence: "container_scope" }
          : null;
      }
      // Keep an unscoped exact hit only when the lookup itself carried a
      // qualified identity (for example `ns::Type`). When the resolver asks
      // for bare member `new` inside container `Cursor`, a same-file
      // `Connection::new` is not an exact scoped match and must not leak
      // through the later same-file fallback.
      if (exactCandidates === undefined || bareName(refName) === refName)
        candidates = [];
    }
    if (containerIds.length > 0) {
      for (const containerId of containerIds) {
        const scoped = candidates.filter(
          (candidate) => candidate.containerId === containerId,
        );
        if (scoped.length === 1)
          return { entry: scoped[0]!, evidence: "container_scope" };
        if (scoped.length > 1) return null;
      }
      return null;
    }
    if (candidates.length === 0) {
      return null;
    }
    const sameFile = candidates.filter((c) => c.fileId === srcFile);
    if (sameFile.length === 1) {
      return { entry: sameFile[0]!, evidence: "same_file" };
    }
    const sameFileLogical = equivalentDeclarationGroup(sameFile);
    if (sameFileLogical) {
      return { entry: sameFileLogical, evidence: "same_file" };
    }
    if (preferredFileIds.length > 0) {
      const preferred = new Set(preferredFileIds);
      const imported = candidates.filter((c) => preferred.has(c.fileId));
      if (imported.length === 1) {
        return { entry: imported[0]!, evidence: "preferred_file" };
      }
      const importedType = primaryTypeDeclaration(imported);
      if (importedType) {
        return { entry: importedType, evidence: "preferred_file" };
      }
    }
    // An unqualified cross-file reference may fall back to a unique global
    // symbol, but never to a class member from an unrelated container. A
    // same-named member in another language or module is not evidence that it
    // is the intended target.
    const workspaceGlobals = candidates.filter(
      (candidate) => candidate.containerId === undefined,
    );
    if (workspaceGlobals.length === 1) {
      return { entry: workspaceGlobals[0]!, evidence: "workspace_unique" };
    }
    const declarationDefinition =
      crossFileDeclarationDefinitionGroup(workspaceGlobals);
    if (declarationDefinition) {
      return { entry: declarationDefinition, evidence: "workspace_unique" };
    }
    // Ambiguous across files: leave unresolved (failed).
    return null;
  }

  /** Resolve a static qualified type name relative to enclosing scopes. */
  lookupLexicalQualified(
    refName: string,
    sourceQualifiedName: string | undefined,
    allowedKinds?: ReadonlySet<string>,
  ): NameLookupResult | null {
    const qualified = refName.replaceAll(".", "::");
    const scopes = sourceQualifiedName?.split("::") ?? [];
    const names = [
      qualified,
      ...scopes.map((_, index) =>
        [...scopes.slice(0, scopes.length - index), qualified].join("::"),
      ),
    ];
    for (const name of names) {
      const candidates = (this.byName.get(name) ?? []).filter(
        (candidate) => !allowedKinds || allowedKinds.has(candidate.kind),
      );
      const entry =
        candidates.length === 1
          ? candidates[0]
          : (crossFileDeclarationDefinitionGroup(candidates) ??
            equivalentDeclarationGroup(candidates));
      if (entry) return { entry, evidence: "container_scope" };
    }
    return null;
  }

  candidates(name: string, fileIds: readonly string[]): NameEntry[] {
    const allowed = new Set(fileIds);
    return [...(this.byName.get(name) ?? [])]
      .filter((entry) => allowed.has(entry.fileId))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  uniqueTopLevelCandidate(
    name: string,
    fileId: string,
    allowedKinds?: ReadonlySet<string>,
  ): NameEntry | null {
    const candidates = (this.byName.get(name) ?? []).filter(
      (entry) =>
        entry.fileId === fileId &&
        entry.containerId === undefined &&
        (!allowedKinds || allowedKinds.has(entry.kind)),
    );
    if (candidates.length === 1) return candidates[0]!;
    return equivalentDeclarationGroup(candidates) ?? null;
  }

  defaultExport(
    fileId: string,
    allowedKinds?: ReadonlySet<string>,
  ): NameEntry | null {
    const topLevel = [...this.byId.values()].filter(
      (entry) =>
        entry.fileId === fileId &&
        entry.containerId === undefined &&
        (!allowedKinds || allowedKinds.has(entry.kind)),
    );
    const components = topLevel.filter((entry) => entry.kind === "component");
    if (components.length === 1) return components[0]!;
    const exported = topLevel.filter((entry) => entry.isExported);
    return exported.length === 1 ? exported[0]! : null;
  }

  has(name: string): boolean {
    return (
      (this.byName.get(name)?.length ?? 0) > 0 ||
      (this.byName.get(bareName(name))?.length ?? 0) > 0
    );
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
    for (const key of [...entryLookupKeys(existing), bareName(existing.name)]) {
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

const TYPE_KINDS = new Set([
  "class",
  "interface",
  "trait",
  "abstract_class",
  "struct",
  "enum",
  "type",
]);

function primaryTypeDeclaration(
  candidates: readonly NameEntry[],
): NameEntry | undefined {
  if (
    candidates.length < 2 ||
    !candidates.every((candidate) => TYPE_KINDS.has(candidate.kind))
  )
    return undefined;
  // Rust models each impl block as a type-like container so its methods retain
  // stable ownership. For a type import, however, those containers are not
  // competing declarations: select the sole struct/enum/trait declaration.
  const declarations = candidates.filter(
    (candidate) => !/^\s*impl(?:\s|<)/.test(candidate.signature ?? ""),
  );
  return declarations.length === 1 ? declarations[0] : undefined;
}

function crossFileDeclarationDefinitionGroup(
  candidates: readonly NameEntry[],
): NameEntry | undefined {
  if (candidates.length < 2) return undefined;
  const first = candidates[0]!;
  const identity = first.qualifiedName ?? first.name;
  if (
    !candidates.every(
      (candidate) => (candidate.qualifiedName ?? candidate.name) === identity,
    )
  )
    return undefined;
  const declarations = candidates.filter((candidate) =>
    isHeaderPath(candidate.filePath),
  );
  const definitions = candidates.filter(
    (candidate) => candidate.filePath && !isHeaderPath(candidate.filePath),
  );
  if (declarations.length === 1 && definitions.length === 1)
    return definitions[0];
  if (!first.signature) return undefined;
  // Multiple overloads may share one qualified name. Only collapse that
  // larger group when every declaration and definition has the same stored
  // signature; otherwise ambiguity is real.
  return declarations.length > 0 &&
    definitions.length === 1 &&
    candidates.every((candidate) => candidate.signature === first.signature)
    ? definitions[0]
    : undefined;
}

function equivalentDeclarationGroup(
  candidates: readonly NameEntry[],
): NameEntry | undefined {
  if (candidates.length < 2) return undefined;
  const first = candidates[0]!;
  if (!first.signature) return undefined;
  const identity = first.qualifiedName ?? first.name;
  if (
    !candidates.every(
      (candidate) =>
        (candidate.qualifiedName ?? candidate.name) === identity &&
        candidate.signature === first.signature,
    )
  )
    return undefined;
  // Prefer the later source declaration (normally the body-bearing C-family
  // definition) without depending on SQLite or insertion order. The id is a
  // stable final tie-breaker for generated symbols without source ranges.
  return [...candidates].sort(compareDeclarationPosition).at(-1);
}

function compareDeclarationPosition(left: NameEntry, right: NameEntry): number {
  return (
    (left.startLine ?? -1) - (right.startLine ?? -1) ||
    left.id.localeCompare(right.id)
  );
}

function entryLookupKeys(entry: NameEntry): string[] {
  return [
    ...new Set(
      [
        entry.name,
        entry.qualifiedName,
        entry.qualifiedName?.replaceAll("::", "."),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
}
