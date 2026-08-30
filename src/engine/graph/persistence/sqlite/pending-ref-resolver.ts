import { performance } from "node:perf_hooks";
import { dirname } from "node:path";
import { escapeRegExp } from "../../../utils/regex.js";
import { FilePathIndex } from "../../imports/path-index.js";
import {
  resetImportResolutionCaches,
  resolveImportPath,
} from "../../imports/resolve-path.js";
import { NameIndex } from "../../name-index.js";
import { referenceResolutionPolicy } from "../../reference-resolution-policy.js";
import {
  FUNCTION_POINTER_ARRAY_CONTAINER,
  referenceTargetFromRaw,
} from "../../../reference-target.js";
import type { ReferenceResolutionHints } from "../../../reference-target.js";
import { resolveRef } from "../../resolve.js";
import type { PendingRef, ResolvePendingOptions } from "../../types.js";
import { type RefRow, type SymbolRow } from "./reader.js";
import type { SqliteGraphDatabase } from "./database.js";
import { isCallableSymbolKind } from "../../symbol-kinds.js";
import {
  type CallableReturnCandidate,
  SemanticCandidateRepository,
  type SemanticCandidateResolution,
} from "./candidate-repository.js";
import { DirectSemanticCandidateIndex } from "./direct-candidate-index.js";
import { bareName, isExternalReceiverType } from "../../builtins.js";
import { CppReceiverTypeInference } from "../../cpp-receiver-inference.js";
import { SqliteCounterpartProjector } from "./counterpart-projector.js";
import { SqliteProjectionBuffer } from "./projection-buffer.js";
import { resolutionSemantics } from "../../../extraction/index.js";
import { isTestPath } from "../../path-policy.js";

const PER_NAME_CEILING = 500;
// Keep enough rows in one transaction to avoid repeatedly sorting the
// shrinking unresolved queue and rebuilding JSON projection statements. The
// bound still caps invocation memory for generated workspaces with millions
// of references.
const RESOLVE_BATCH_SIZE = 20_000;
// Invocation-local bound: visibility-aware keys normally repeat within source
// files, while the cap prevents a pathological generated workspace from
// retaining every candidate array until indexing completes.
const SEMANTIC_CANDIDATE_CACHE_SIZE = 5_000;

function timingLanguage(language: string): string {
  return language.replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
}

type ResolvePhase =
  | "imports"
  | "inheritance"
  | "instantiations"
  | "function_registrations"
  | "symbols";

type OwnerContext = {
  file_id: string;
  qualified_name: string | null;
  container_id: string | null;
  container_name: string | null;
};

type ResolutionInvocation = {
  names: NameIndex;
  paths: FilePathIndex;
  filePaths: ReadonlyMap<string, string>;
  attempt: number;
  retryFailed: boolean;
};

type ImportBinding = {
  imported_name: string;
  dst_file_id: string;
  local_name: string;
  reexport: boolean;
};

type DeclaredFields = {
  fileId: string;
  fields: Map<string, string>;
};

type ConstructorTarget = { id: string; arity: number | null };

/** Converts pending call/ref/import sites into persisted graph edges. */
export class SqlitePendingRefResolver {
  private readonly candidates: SemanticCandidateRepository;
  private readonly counterparts: SqliteCounterpartProjector;
  private readonly projections: SqliteProjectionBuffer;
  private directCandidates?: DirectSemanticCandidateIndex;
  private cppReceivers = new CppReceiverTypeInference();
  private readonly semanticCandidateCache = new Map<
    string,
    SemanticCandidateResolution
  >();
  private readonly functionPointerCandidateCache = new Map<string, string[]>();
  private readonly namespaceCandidateCache = new Map<string, string[]>();
  private readonly callableReturnCache = new Map<
    string,
    CallableReturnCandidate[]
  >();
  private readonly functionPointerSlots = new Set<string>();
  private readonly owners = new Map<string, OwnerContext>();
  private readonly preferredFiles = new Map<string, string[]>();
  private readonly importAdjacency = new Map<string, string[]>();
  private readonly importedFileClosure = new Map<string, readonly string[]>();
  private readonly importBindings = new Map<string, ImportBinding[]>();
  private readonly abstractTypeFiles = new Map<string, Set<string>>();
  private readonly typeFiles = new Map<string, Set<string>>();
  private readonly typeAliases = new Map<
    string,
    { target: string; fileId: string }[]
  >();
  private readonly declaredFieldsByContainer = new Map<
    string,
    ReadonlyMap<string, string>
  >();
  private readonly declaredFieldsByType = new Map<string, DeclaredFields[]>();
  private readonly aliasObjectFields = new Map<string, DeclaredFields[]>();
  private readonly constructorsByContainer = new Map<
    string,
    ConstructorTarget[]
  >();
  private readonly failedRefIds = new Set<string>();
  private readonly fileDirectories = new Map<string, string>();
  private readonly filesByDirectory = new Map<string, string[]>();
  private readonly testFileIds = new Set<string>();
  private semanticCandidateQueries = 0;
  private semanticCandidateCacheHits = 0;
  private semanticCandidateDurationMs = 0;
  private readonly semanticCandidateStatsByLanguage = new Map<
    string,
    { count: number; durationMs: number }
  >();
  private directCandidateHits = 0;

  constructor(private readonly database: SqliteGraphDatabase) {
    this.candidates = new SemanticCandidateRepository(database);
    this.counterparts = new SqliteCounterpartProjector(database);
    this.projections = new SqliteProjectionBuffer(database);
  }

  private assertWritable(): void {
    this.database.assertWritable();
  }

  private transaction(work: () => void): void {
    this.database.transaction(work);
  }

  private all<T>(sql: string, ...params: Array<string | number>): T[] {
    return this.database.all<T>(sql, ...params);
  }

  private one<T>(
    sql: string,
    ...params: Array<string | number>
  ): T | undefined {
    return this.database.one<T>(sql, ...params);
  }

  private timed<T>(
    options: ResolvePendingOptions,
    name: string,
    work: () => T,
  ): T {
    const startedAt = performance.now();
    const result = work();
    options.onTiming?.(
      name,
      performance.now() - startedAt,
      typeof result === "number" ? result : undefined,
    );
    return result;
  }

  async resolvePending(options: ResolvePendingOptions = {}): Promise<void> {
    this.assertWritable();
    const rebuildCounterparts = this.database.isBulkLoad();
    this.timed(options, "graph_bulk_finalize", () =>
      this.database.endBulkLoad(),
    );
    resetImportResolutionCaches();
    const retryFailed = options.retryFailed ?? true;
    const resolvable =
      this.one<{ count: number }>(
        `SELECT COUNT(*) AS count FROM unresolved_refs
         WHERE status='pending' OR (?=1 AND status='failed')`,
        retryFailed ? 1 : 0,
      )?.count ?? 0;
    if (resolvable === 0) {
      this.timed(options, "graph_counterpart_projection", () =>
        this.counterparts.refresh(rebuildCounterparts),
      );
      return;
    }
    const invocation = this.timed(options, "graph_resolve_prepare", () =>
      this.prepareInvocation(options, retryFailed),
    );
    this.timed(options, "graph_resolve_imports", () => {
      const count = this.drainPhase(
        "imports",
        invocation.attempt,
        invocation.retryFailed,
        (ref) => this.resolveImport(ref, invocation.paths, invocation.attempt),
      );
      this.retireResolvedRustImportAlternatives(invocation.attempt);
      return count;
    });
    // Import edges are strong declaration/definition evidence. Project after
    // imports so a fresh build can use them instead of relying on path shape.
    this.timed(options, "graph_counterpart_projection", () =>
      this.counterparts.refresh(rebuildCounterparts),
    );
    this.timed(options, "graph_resolve_context", () => {
      this.prepareResolutionContext();
      this.loadDefaultExportCandidates(invocation.names, invocation.filePaths);
    });
    this.resolvePhase(options, "inheritance", invocation);
    this.resolvePhase(options, "function_registrations", invocation);
    this.resolvePhase(options, "instantiations", invocation);
    this.semanticCandidateCache.clear();
    this.timed(options, "graph_resolve_direct_index", () => {
      this.directCandidates = new DirectSemanticCandidateIndex(
        this.database,
        this.testFileIds,
      );
    });
    // Build/cache hierarchy lookups only after every inheritance batch has
    // completed, so calls never observe a partial inheritance graph.
    const hierarchyCache = new Map<string, readonly string[]>();
    this.resolvePhase(options, "symbols", invocation, hierarchyCache);
    this.reportResolutionMetrics(options);
    this.database.markResolvedProjections();
  }

  private prepareInvocation(
    options: ResolvePendingOptions,
    retryFailed: boolean,
  ): ResolutionInvocation {
    const files = options.files ?? [];
    this.resetInvocationState(files);
    const names = new NameIndex();
    const lookupNames = this.pendingSymbolNames();
    const filePaths = new Map(
      files.map((file) => [file.id, file.relativePath]),
    );
    names.load(
      this.all<
        SymbolRow & {
          container_id: string | null;
          container_name: string | null;
          start_line: number | null;
        }
      >(
        `SELECT s.id,s.file_id,s.name,s.qualified_name,s.kind,s.is_exported,s.signature,
                json_extract(s.range_json,'$.startLine') AS start_line,
                p.id AS container_id,p.name AS container_name
         FROM symbols s
         LEFT JOIN contains c ON c.child_id=s.id
         LEFT JOIN symbols p ON p.id=c.parent_id
         WHERE s.name IN (SELECT value FROM json_each(?))
            OR s.qualified_name IN (SELECT value FROM json_each(?))`,
        JSON.stringify(lookupNames),
        JSON.stringify(lookupNames),
      ).map((row) => ({
        id: row.id,
        fileId: row.file_id,
        filePath: filePaths.get(row.file_id),
        name: row.name!,
        qualifiedName: row.qualified_name ?? undefined,
        kind: row.kind,
        isExported: row.is_exported === 1,
        signature: row.signature ?? undefined,
        startLine: row.start_line ?? undefined,
        containerName: row.container_name ?? undefined,
        containerId: row.container_id ?? undefined,
      })),
    );
    return {
      names,
      paths: new FilePathIndex(files),
      filePaths,
      attempt: this.nextAttempt(),
      retryFailed,
    };
  }

  private resetInvocationState(files: ResolvePendingOptions["files"]): void {
    this.fileDirectories.clear();
    this.filesByDirectory.clear();
    this.testFileIds.clear();
    for (const file of this.all<{ id: string; relative_path: string | null }>(
      "SELECT id,relative_path FROM files",
    ))
      if (file.relative_path && isTestPath(file.relative_path))
        this.testFileIds.add(file.id);
    for (const file of files ?? []) {
      // Absolute directory identity keeps same-named packages in different
      // workspace roots independent. Relative keys merge unrelated packages.
      const directory = dirname(file.absolutePath);
      this.fileDirectories.set(file.id, directory);
      this.filesByDirectory.set(directory, [
        ...(this.filesByDirectory.get(directory) ?? []),
        file.id,
      ]);
    }
    this.cppReceivers = new CppReceiverTypeInference(files ?? []);
    for (const cache of [
      this.semanticCandidateCache,
      this.semanticCandidateStatsByLanguage,
      this.functionPointerCandidateCache,
      this.namespaceCandidateCache,
      this.callableReturnCache,
      this.functionPointerSlots,
    ])
      cache.clear();
    this.semanticCandidateQueries = 0;
    this.semanticCandidateCacheHits = 0;
    this.semanticCandidateDurationMs = 0;
    this.directCandidateHits = 0;
    this.directCandidates = undefined;
    for (const [name, candidates] of this.candidates.loadCallableReturns())
      this.callableReturnCache.set(name, candidates);
  }

  private reportResolutionMetrics(options: ResolvePendingOptions): void {
    const report = (name: string, durationMs: number, count: number) =>
      options.onTiming?.(name, durationMs, count);
    report("graph_resolve_semantic_queries", 0, this.semanticCandidateQueries);
    report(
      "graph_resolve_semantic_cache_hits",
      0,
      this.semanticCandidateCacheHits,
    );
    report("graph_resolve_direct_hits", 0, this.directCandidateHits);
    report(
      "graph_resolve_semantic_sql",
      this.semanticCandidateDurationMs,
      this.semanticCandidateQueries,
    );
    for (const [language, stats] of [
      ...this.semanticCandidateStatsByLanguage.entries(),
    ].sort(([left], [right]) => left.localeCompare(right)))
      report(
        `graph_resolve_semantic_sql_${timingLanguage(language)}`,
        stats.durationMs,
        stats.count,
      );
  }

  private resolvePhase(
    options: ResolvePendingOptions,
    phase: Exclude<ResolvePhase, "imports">,
    invocation: ResolutionInvocation,
    hierarchyCache: Map<string, readonly string[]> = new Map(),
  ): void {
    this.semanticCandidateCache.clear();
    this.timed(options, `graph_resolve_${phase}`, () => {
      const count = this.drainPhase(
        phase,
        invocation.attempt,
        invocation.retryFailed,
        (ref) =>
          this.resolveSymbol(
            ref,
            invocation.names,
            invocation.attempt,
            hierarchyCache,
          ),
      );
      if (phase === "function_registrations") this.loadFunctionPointerSlots();
      return count;
    });
  }

  private loadDefaultExportCandidates(
    names: NameIndex,
    filePaths: ReadonlyMap<string, string>,
  ): void {
    const fileIds = [
      ...new Set(
        [...this.importBindings.values()].flatMap((bindings) =>
          bindings
            .filter((binding) => binding.imported_name === "default")
            .map((binding) => binding.dst_file_id),
        ),
      ),
    ];
    if (fileIds.length === 0) return;
    names.upsert(
      this.all<
        SymbolRow & {
          container_id: null;
          container_name: null;
        }
      >(
        `SELECT symbol.id,symbol.file_id,symbol.name,symbol.qualified_name,
                symbol.kind,symbol.is_exported,symbol.signature,
                NULL AS container_id,NULL AS container_name
           FROM symbols symbol
           LEFT JOIN contains ownership ON ownership.child_id=symbol.id
          WHERE symbol.file_id IN (SELECT value FROM json_each(?))
            AND symbol.is_exported=1
            AND ownership.child_id IS NULL`,
        JSON.stringify(fileIds),
      ).map((row) => ({
        id: row.id,
        fileId: row.file_id,
        filePath: filePaths.get(row.file_id),
        name: row.name!,
        qualifiedName: row.qualified_name ?? undefined,
        kind: row.kind,
        isExported: true,
        signature: row.signature ?? undefined,
      })),
    );
  }

  private pendingSymbolNames(): string[] {
    const rows = this.all<{
      ref_name: string;
      member_name: string | null;
      imported_name: string | null;
    }>(
      `SELECT ref_name,member_name,imported_name FROM unresolved_refs
       WHERE status IN ('pending','failed')`,
    );
    const names = new Set<string>();
    for (const row of rows) {
      for (const value of [row.ref_name, row.member_name, row.imported_name]) {
        if (!value) continue;
        names.add(value);
        const bare = bareName(value);
        if (bare) names.add(bare);
      }
    }
    for (const row of this.all<{ imported_name: string }>(
      `SELECT DISTINCT imports.imported_name FROM unresolved_refs unresolved
       JOIN symbols owner ON owner.id=unresolved.owner_id
       JOIN edges imports ON imports.src_id=owner.file_id
         AND imports.src_is_file=1 AND imports.kind='IMPORTS'
       WHERE unresolved.owner_is_file=0
         AND unresolved.status IN ('pending','failed')
         AND imports.imported_name IS NOT NULL`,
    )) {
      if (row.imported_name !== "*") names.add(row.imported_name);
    }
    return [...names];
  }

  private drainPhase(
    phase: ResolvePhase,
    attempt: number,
    retryFailed: boolean,
    resolve: (ref: RefRow) => void,
  ): number {
    let processed = 0;
    while (true) {
      const refs = this.retryableRefs(attempt, phase, retryFailed);
      if (refs.length === 0) break;
      processed += refs.length;
      this.transaction(() => {
        this.projections.begin();
        this.failedRefIds.clear();
        for (const ref of refs) resolve(ref);
        this.projections.flush();
        this.flushFailedRefs(attempt);
      });
    }
    return processed;
  }

  private prepareResolutionContext(): void {
    this.owners.clear();
    this.preferredFiles.clear();
    this.importAdjacency.clear();
    this.importedFileClosure.clear();
    this.importBindings.clear();
    this.abstractTypeFiles.clear();
    this.typeFiles.clear();
    this.typeAliases.clear();
    this.declaredFieldsByContainer.clear();
    this.declaredFieldsByType.clear();
    this.aliasObjectFields.clear();
    this.constructorsByContainer.clear();
    for (const row of this.all<OwnerContext & { id: string }>(
      `WITH owner_symbols AS (
         SELECT s.*,
           CASE WHEN s.qualified_name LIKE '%::' || s.name
             THEN substr(s.qualified_name,1,length(s.qualified_name)-length(s.name)-2)
           END AS qualified_container_name
         FROM symbols s
       )
       SELECT s.id,s.file_id,s.qualified_name,
         COALESCE(p.id,(
           SELECT CASE WHEN COUNT(*)=1 THEN MIN(candidate.id) END
           FROM symbols candidate
           WHERE candidate.name=s.qualified_container_name
             AND candidate.kind IN ('class','interface','trait','abstract_class')
         )) AS container_id,
         COALESCE(p.name,s.qualified_container_name) AS container_name
       FROM owner_symbols s
       LEFT JOIN contains c ON c.child_id=s.id
       LEFT JOIN symbols p ON p.id=c.parent_id`,
    ))
      this.owners.set(row.id, row);
    for (const row of this.all<{
      src_id: string;
      dst_id: string;
      imported_name: string | null;
      local_name: string | null;
      reexport: number;
    }>(
      `SELECT src_id,dst_id,imported_name,local_name,
              COALESCE(json_extract(resolution_hints,'$.reexport'),0) AS reexport
         FROM edges
       WHERE src_is_file=1 AND dst_is_file=1 AND kind='IMPORTS'
       ORDER BY src_id,dst_id`,
    )) {
      const preferred = this.preferredFiles.get(row.src_id) ?? [];
      if (!preferred.includes(row.dst_id)) preferred.push(row.dst_id);
      this.preferredFiles.set(row.src_id, preferred);
      const imported = this.importAdjacency.get(row.src_id) ?? [];
      if (!imported.includes(row.dst_id)) imported.push(row.dst_id);
      this.importAdjacency.set(row.src_id, imported);
      if (row.imported_name === null || row.local_name === null) continue;
      const bindings = this.importBindings.get(row.src_id) ?? [];
      bindings.push({
        imported_name: row.imported_name,
        dst_file_id: row.dst_id,
        local_name: row.local_name,
        reexport: row.reexport === 1,
      });
      this.importBindings.set(row.src_id, bindings);
    }
    for (const row of this.all<{ name: string; file_id: string }>(
      `SELECT name,file_id FROM symbols
       WHERE name IS NOT NULL
         AND kind IN ('interface','trait','abstract_class')`,
    )) {
      const files = this.abstractTypeFiles.get(row.name) ?? new Set<string>();
      files.add(row.file_id);
      this.abstractTypeFiles.set(row.name, files);
    }
    for (const row of this.all<{ name: string; file_id: string }>(
      `SELECT name,file_id FROM symbols
       WHERE name IS NOT NULL
         AND kind IN ('class','interface','trait','abstract_class')`,
    )) {
      const files = this.typeFiles.get(row.name) ?? new Set<string>();
      files.add(row.file_id);
      this.typeFiles.set(row.name, files);
    }
    for (const row of this.all<{
      name: string;
      signature: string;
      file_id: string;
    }>(
      `SELECT name,signature,file_id FROM symbols
       WHERE kind='alias' AND name IS NOT NULL AND signature IS NOT NULL`,
    )) {
      const files = this.typeFiles.get(row.name) ?? new Set<string>();
      files.add(row.file_id);
      this.typeFiles.set(row.name, files);
      const fields = typeAliasObjectFields(row.signature);
      if (fields.size > 0) {
        const declarations = this.aliasObjectFields.get(row.name) ?? [];
        declarations.push({ fileId: row.file_id, fields });
        this.aliasObjectFields.set(row.name, declarations);
      }
      const target = aliasTargetType(row.name, row.signature);
      if (!target) continue;
      const aliases = this.typeAliases.get(row.name) ?? [];
      aliases.push({ target, fileId: row.file_id });
      this.typeAliases.set(row.name, aliases);
    }
    for (const row of this.all<{
      container_id: string;
      container_name: string;
      file_id: string;
      name: string;
      signature: string;
    }>(
      `SELECT parent.id AS container_id,parent.name AS container_name,
              parent.file_id,field.name,field.signature
         FROM contains ownership
         JOIN symbols parent ON parent.id=ownership.parent_id
         JOIN symbols field ON field.id=ownership.child_id
        WHERE parent.name IS NOT NULL
          AND parent.kind IN ('class','abstract_class','interface')
          AND field.kind='value' AND field.name IS NOT NULL
          AND field.signature IS NOT NULL
        ORDER BY parent.id,field.name,field.id`,
    )) {
      const type = declaredFieldType(row.name, row.signature);
      if (!type) continue;
      const fields = new Map(
        this.declaredFieldsByContainer.get(row.container_id) ?? [],
      );
      fields.set(row.name, type);
      this.declaredFieldsByContainer.set(row.container_id, fields);
      let declarations = this.declaredFieldsByType.get(row.container_name);
      if (!declarations) {
        declarations = [];
        this.declaredFieldsByType.set(row.container_name, declarations);
      }
      let declaration = declarations.find(
        (candidate) => candidate.fileId === row.file_id,
      );
      if (!declaration) {
        declaration = { fileId: row.file_id, fields: new Map() };
        declarations.push(declaration);
      }
      declaration.fields.set(row.name, type);
    }
    for (const row of this.all<{
      container_id: string;
      id: string;
      arity: number | null;
    }>(
      `SELECT parent.id AS container_id,member.id,member.arity
         FROM contains ownership
         JOIN symbols parent ON parent.id=ownership.parent_id
         JOIN symbols member ON member.id=ownership.child_id
        WHERE member.kind IN ('function','method','constructor')
          AND (member.name IN ('constructor','__init__')
               OR member.name=parent.name
               OR member.node_type LIKE '%constructor%')
        ORDER BY parent.id,member.arity,member.id`,
    )) {
      const targets = this.constructorsByContainer.get(row.container_id) ?? [];
      targets.push({ id: row.id, arity: row.arity });
      this.constructorsByContainer.set(row.container_id, targets);
    }
  }

  private resolveSymbol(
    ref: RefRow,
    names: NameIndex,
    attempt: number,
    hierarchyCache: Map<string, readonly string[]>,
  ): void {
    const owner = this.owners.get(ref.owner_id);
    if (!owner) return this.failRef(ref.id, attempt);
    const pending: PendingRef = {
      src: ref.owner_id,
      src_file: owner.file_id,
      ref_id: ref.id,
      ref_name: ref.ref_name,
      ref_kind: ref.ref_kind,
      line: ref.line,
      status: ref.status,
      source_language: ref.source_language ?? undefined,
      target: {
        raw: ref.ref_name,
        member: ref.member_name ?? referenceTargetFromRaw(ref.ref_name).member,
        receiver:
          ref.receiver_kind && ref.receiver_name
            ? { kind: ref.receiver_kind, name: ref.receiver_name }
            : undefined,
        hints: parseResolutionHints(ref.resolution_hints),
      },
    };
    const reference = referenceResolutionPolicy.analyzeReference(
      pending.target ?? ref.ref_name,
      ref.source_language ?? undefined,
    );
    const preferred = this.preferredFilesFor(
      owner.file_id,
      ref.source_language ?? undefined,
    );
    const receiver = refReceiver(ref.ref_name);
    const qualifiedReceiverBinding = Boolean(receiver && ref.member_name);
    const directBinding = (this.importBindings.get(owner.file_id) ?? [])
      .filter(
        (candidate) =>
          candidate.local_name === ref.ref_name ||
          candidate.local_name === receiver,
      )
      .sort((left, right) => {
        const bindingRank = (candidate: ImportBinding): number => {
          if (
            qualifiedReceiverBinding &&
            candidate.local_name === receiver &&
            candidate.imported_name === "*"
          )
            return 0;
          if (
            !qualifiedReceiverBinding &&
            candidate.local_name === ref.ref_name &&
            candidate.imported_name !== "*"
          )
            return 0;
          return 1;
        };
        const rankDelta = bindingRank(left) - bindingRank(right);
        const leftExact = left.local_name === ref.ref_name ? 0 : 1;
        const rightExact = right.local_name === ref.ref_name ? 0 : 1;
        return (
          rankDelta ||
          leftExact - rightExact ||
          left.dst_file_id.localeCompare(right.dst_file_id) ||
          left.imported_name.localeCompare(right.imported_name)
        );
      })[0];
    const binding = this.resolveReexportBinding(directBinding);
    if (pending.target?.hints?.dynamicDispatch) {
      const functionPointerCandidates = this.functionPointerTargets(
        ref,
        pending.target,
      );
      if (functionPointerCandidates.length > 0) {
        this.persistDynamicCall(
          ref,
          pending.target,
          functionPointerCandidates,
          "polymorphic_dispatch",
          "function_pointer",
          0.85,
        );
        return;
      }
      const namespaceCandidates = this.namespaceDispatchTargets(
        ref,
        pending.target,
        owner.file_id,
      );
      this.persistDynamicCall(
        ref,
        pending.target,
        namespaceCandidates,
        "runtime_dispatch",
        namespaceCandidates.length > 0 ? "namespace_export" : undefined,
        0.7,
      );
      return;
    }
    const goPackageTarget =
      resolutionSemantics(ref.source_language).packageQualifiedCalls &&
      binding?.imported_name === "*" &&
      binding.local_name === receiver &&
      ref.member_name
        ? this.uniqueGoPackageTarget(
            names,
            binding.dst_file_id,
            ref.member_name,
          )
        : null;
    if (goPackageTarget) {
      this.insertSymbolEdge(
        ref,
        goPackageTarget,
        refKindToEdgeKind(ref.ref_kind),
        {
          provenance: "static",
          confidence: 1,
          evidence: "preferred_file",
        },
      );
      return;
    }
    if (
      ref.ref_kind === "call" &&
      pending.target?.hints?.lexicallyBound &&
      !pending.target.receiver
    ) {
      const lexicalCandidate = this.lexicalSourceCandidate(
        names,
        owner.file_id,
        pending.target.member,
        pending.target.hints.lexicalSource,
      );
      if (lexicalCandidate) {
        this.insertSymbolEdge(ref, lexicalCandidate, "CALLS", {
          provenance: "heuristic",
          confidence: 0.85,
          evidence: "preferred_file",
          resolutionHints: pending.target.hints,
        });
        return;
      }
      this.persistDynamicCall(ref, pending.target, [], "lexical_dispatch");
      return;
    }
    // Match CodeGraph's knownNames gate: if an untyped reference has no
    // symbol under either its full or member name and no import binding, no
    // later resolver strategy can succeed. Park it without source inference
    // or candidate SQL. Typed receivers remain eligible for dynamic-boundary
    // projection even when their member is currently absent.
    if (
      !pending.target?.hints?.receiverType &&
      !binding &&
      !names.has(ref.ref_name) &&
      !(ref.member_name && names.has(ref.member_name))
    ) {
      if (
        referenceResolutionPolicy.isExternal(reference) ||
        referenceResolutionPolicy.isExternalReceiver(reference)
      )
        this.projections.markExternal(ref.id);
      else this.failRef(ref.id, attempt);
      return;
    }
    const structuredTarget = this.withInferredDeclaredReceiverType(
      pending.target!,
      ref,
      owner,
      hierarchyCache,
    );
    const cppReceiver = this.withInferredCppReceiverType(
      structuredTarget,
      ref,
      owner.file_id,
    );
    const target = this.withInferredFactoryReceiverType(
      cppReceiver.target,
      ref,
      owner.file_id,
      binding,
      preferred,
    );
    const functionPointerCandidates = target.hints?.receiverType
      ? this.functionPointerTargets(ref, target)
      : [];
    if (functionPointerCandidates.length > 0) {
      this.persistDynamicCall(
        ref,
        target,
        functionPointerCandidates,
        "polymorphic_dispatch",
        "function_pointer",
        0.85,
      );
      return;
    }
    const semanticResolution = target.hints?.receiverType
      ? this.resolveSemanticCandidates(
          ref,
          target,
          cppReceiver.declarationFileId,
        )
      : { candidates: [], abstractDispatch: false, rtaActive: false };
    const semanticCandidates = semanticResolution.candidates;
    const receiverEvidence = target.hints?.receiverTypeEvidence;
    const receiverTypeIsTextFallback =
      receiverEvidence?.source === "text_fallback" ||
      receiverEvidence?.source === "cross_file_text_fallback";
    const targetHasExternalReceiver = this.receiverTypeIsExternal(
      target.hints?.candidateTypes ??
        (target.hints?.receiverType ? [target.hints.receiverType] : []),
      ref.source_language ?? undefined,
    );
    if (
      semanticCandidates.length === 0 &&
      !semanticResolution.abstractDispatch &&
      (referenceResolutionPolicy.isExternalReceiver(reference) ||
        targetHasExternalReceiver)
    ) {
      this.projections.markExternal(ref.id);
      return;
    }
    // Source-text inference is deliberately an uncertainty signal. It cannot
    // account for macros, lexical shadowing, or complete declaration syntax,
    // so it must never be projected as a definite CALLS edge.
    if (ref.ref_kind === "call" && receiverTypeIsTextFallback) {
      this.persistDynamicCall(
        ref,
        target,
        semanticCandidates,
        "lexical_dispatch",
        "hierarchy",
        receiverEvidence.confidence,
      );
      return;
    }
    // A typed receiver that is absent from the visible graph must not fall
    // through to the global same-member heuristic. The missing type is useful
    // uncertainty, not evidence that an unrelated class is the target.
    if (
      ref.ref_kind === "call" &&
      semanticCandidates.length === 0 &&
      !semanticResolution.abstractDispatch &&
      target.hints?.receiverType
    ) {
      this.persistDynamicCall(ref, target, [], "unknown_receiver_type");
      return;
    }
    if (
      semanticCandidates.length === 1 &&
      (!semanticResolution.abstractDispatch || semanticResolution.rtaActive)
    ) {
      this.insertSymbolEdge(
        ref,
        semanticCandidates[0]!,
        refKindToEdgeKind(ref.ref_kind),
        {
          provenance: "heuristic",
          confidence: 0.75,
          evidence: "receiver_type_member",
          resolutionHints: target.hints,
        },
      );
      return;
    }
    if (
      ref.ref_kind === "call" &&
      ((semanticResolution.abstractDispatch && !semanticResolution.rtaActive) ||
        semanticCandidates.length > 1)
    ) {
      this.persistDynamicCall(
        ref,
        target,
        semanticCandidates,
        "polymorphic_dispatch",
      );
      return;
    }
    const result = resolveRef(
      pending,
      names,
      binding ? this.bindingVisibleFiles(binding) : preferred,
      binding
        ? {
            importedName: binding.imported_name,
            fileId: binding.dst_file_id,
            kind: binding.local_name === ref.ref_name ? "exact" : "receiver",
          }
        : undefined,
      owner.container_name ?? undefined,
      owner.container_id ?? undefined,
      reference.receiver.kind !== "qualified" && owner.container_id
        ? this.cachedInheritanceContainers(
            hierarchyCache,
            owner.container_id,
            reference.receiver.kind === "owner"
              ? reference.receiver.includeOwner
              : true,
          )
        : [],
      reference,
      owner.qualified_name ?? undefined,
    );
    if (result.status === "external") {
      this.projections.markExternal(ref.id);
      return;
    }
    if (result.status !== "resolved") {
      if (
        ref.ref_kind === "function" &&
        binding &&
        this.bindingResolvesOnlyToNonCallables(ref, binding, names)
      ) {
        this.projections.markExternal(ref.id);
        return;
      }
      const heuristic =
        binding || target.hints?.lexicallyBound
          ? this.heuristicCandidate(
              ref,
              names,
              owner.file_id,
              binding ? this.bindingVisibleFiles(binding) : preferred,
              Boolean(binding),
            )
          : null;
      if (!heuristic) {
        // Preserve a qualified call as an explicit uncertainty boundary. A
        // missing receiver type is not evidence for an arbitrary same-named
        // method, and a stable boundary must not be retried on every unrelated
        // resolve invocation.
        if (
          ref.ref_kind === "call" &&
          reference.receiver.kind === "qualified" &&
          ref.member_name
        ) {
          this.persistDynamicCall(ref, target, [], "unknown_receiver_type");
          return;
        }
        return this.failRef(ref.id, attempt);
      }
      this.insertSymbolEdge(ref, heuristic, refKindToEdgeKind(ref.ref_kind), {
        provenance: "heuristic",
        confidence: 0.35,
        evidence: "unique_member_in_visible_files",
      });
      return;
    }
    this.insertSymbolEdge(ref, result.dst, result.edgeKind, {
      provenance: "static",
      confidence: 1,
      // A same-file resolution is derivable from the edge endpoints. Persist
      // only evidence that cannot be reconstructed from the graph itself.
      evidence: result.evidence === "same_file" ? undefined : result.evidence,
    });
  }

  private bindingResolvesOnlyToNonCallables(
    ref: RefRow,
    binding: { imported_name: string; dst_file_id: string },
    names: NameIndex,
  ): boolean {
    const lookupName =
      binding.imported_name === "*"
        ? (ref.member_name ?? ref.ref_name)
        : binding.imported_name;
    const targets = names.candidates(lookupName, [binding.dst_file_id]);
    return (
      targets.length > 0 &&
      targets.every((target) => !isCallableSymbolKind(target.kind))
    );
  }

  private uniqueGoPackageTarget(
    names: NameIndex,
    importedFileId: string,
    memberName: string,
  ): string | null {
    const packageDirectory = this.fileDirectories.get(importedFileId);
    if (packageDirectory === undefined) return null;
    const candidates = names
      .snapshot()
      .filter(
        (entry) =>
          entry.name === memberName &&
          entry.containerId === undefined &&
          this.fileDirectories.get(entry.fileId) === packageDirectory,
      );
    return candidates.length === 1 ? candidates[0]!.id : null;
  }

  private withInferredCppReceiverType(
    target: NonNullable<PendingRef["target"]>,
    ref: RefRow,
    sourceFileId: string,
  ): {
    target: NonNullable<PendingRef["target"]>;
    declarationFileId?: string;
  } {
    if (
      target.hints?.receiverType ||
      !resolutionSemantics(ref.source_language).sourceReceiverInference ||
      !target.receiver?.name
    )
      return { target };
    const inferred = this.cppReceivers.inferWithEvidence(
      target.receiver.name,
      ref.line,
      sourceFileId,
    );
    if (!inferred) return { target };
    return {
      target: {
        ...target,
        hints: {
          ...target.hints,
          receiverType: inferred.type,
          receiverTypeEvidence: {
            source: inferred.source,
            confidence: inferred.confidence,
          },
          candidateTypes: [inferred.type],
          dispatch: "virtual",
        },
      },
      declarationFileId: inferred.declarationFileId,
    };
  }

  private withInferredDeclaredReceiverType(
    target: NonNullable<PendingRef["target"]>,
    ref: RefRow,
    owner: OwnerContext,
    hierarchyCache: Map<string, readonly string[]>,
  ): NonNullable<PendingRef["target"]> {
    const derived = Boolean(target.hints?.resolutionDependencies?.length);
    const sourceTarget = derived
      ? { ...target, hints: sourceResolutionHints(target.hints) }
      : target;
    if (
      (sourceTarget.hints?.receiverType && !derived) ||
      !sourceTarget.receiver?.name ||
      !owner.container_id ||
      !resolutionSemantics(ref.source_language).ownerFieldInference
    )
      return sourceTarget;
    const fields = ownerFieldPath(sourceTarget.receiver.name);
    if (fields.length === 0) return sourceTarget;
    const hierarchy = this.cachedInheritanceContainers(
      hierarchyCache,
      owner.container_id,
      true,
    );
    const initialTypes = new Set(
      hierarchy.flatMap((containerId) => {
        const type = this.declaredFieldsByContainer
          .get(containerId)
          ?.get(fields[0]!);
        return type ? [type] : [];
      }),
    );
    if (initialTypes.size !== 1) return sourceTarget;
    const visibleFiles = new Set([
      owner.file_id,
      ...this.transitiveImportedFiles(owner.file_id),
    ]);
    let receiverType = [...initialTypes][0]!;
    const dependencies = new Set(fields);
    for (const name of typeDependencyNames(receiverType))
      dependencies.add(name);
    for (const field of fields.slice(1)) {
      const next = this.declaredNestedFieldType(
        receiverType,
        field,
        visibleFiles,
      );
      if (!next) return sourceTarget;
      receiverType = next;
      for (const name of typeDependencyNames(receiverType))
        dependencies.add(name);
    }
    receiverType = typeLookupName(receiverType);
    return {
      ...sourceTarget,
      hints: {
        ...sourceTarget.hints,
        receiverType,
        candidateTypes: [receiverType],
        resolutionDependencies: [...dependencies].sort(),
        ...(resolutionSemantics(ref.source_language).virtualReturnDispatch
          ? { dispatch: "virtual" as const }
          : {}),
      },
    };
  }

  private declaredNestedFieldType(
    ownerType: string,
    field: string,
    visibleFiles: ReadonlySet<string>,
  ): string | undefined {
    const returnAlias = /^ReturnType\s*<\s*([A-Za-z_$][\w$.:]*)\s*>$/.exec(
      ownerType,
    )?.[1];
    const declarations = returnAlias
      ? (this.aliasObjectFields.get(typeLookupName(returnAlias)) ?? [])
      : (this.declaredFieldsByType.get(typeLookupName(ownerType)) ?? []);
    const types = new Set(
      declarations
        .filter((declaration) => visibleFiles.has(declaration.fileId))
        .map((declaration) => declaration.fields.get(field))
        .filter((type): type is string => Boolean(type)),
    );
    return types.size === 1 ? [...types][0] : undefined;
  }

  private resolveSemanticCandidates(
    ref: RefRow,
    target: NonNullable<PendingRef["target"]>,
    inferredDeclarationFileId?: string,
  ): SemanticCandidateResolution {
    const sourceFile = this.owners.get(ref.owner_id)?.file_id ?? ref.owner_id;
    const sourceDirectory = this.fileDirectories.get(sourceFile);
    const semantics = resolutionSemantics(ref.source_language);
    const packageFiles =
      semantics.packageVisibility === "directory" &&
      sourceDirectory !== undefined
        ? (this.filesByDirectory.get(sourceDirectory) ?? [])
        : [];
    const importedFiles = this.transitiveImportedFiles(sourceFile);
    // A Go import names a package, not one source file. Path resolution keeps
    // one deterministic representative file for the IMPORTS edge, but member
    // lookup must see every indexed `.go` file in that package directory.
    // Without this expansion, resolution depended on which sibling happened
    // to be selected as the representative (for example chain.go vs chi.go).
    const importedPackageFiles =
      semantics.packageVisibility === "directory"
        ? importedFiles.flatMap((fileId) => {
            const directory = this.fileDirectories.get(fileId);
            return directory === undefined
              ? []
              : (this.filesByDirectory.get(directory) ?? []);
          })
        : [];
    const visibleFileIds = [
      ...new Set([
        ...importedFiles,
        ...importedPackageFiles,
        ...packageFiles,
        ...(inferredDeclarationFileId ? [inferredDeclarationFileId] : []),
      ]),
    ];
    const visibleFiles = new Set([sourceFile, ...visibleFileIds]);
    const typeNames = this.expandTypeAliases(
      target.hints?.candidateTypes ?? [target.hints!.receiverType!],
      visibleFiles,
    );
    // The candidate query anchors its recursive provider closure at a named
    // type in the visible file set. If no such root exists, the SQL cannot
    // produce a valid candidate. Skipping it is both faster and stricter than
    // falling back to an unrelated same-named method elsewhere in the graph.
    if (
      !typeNames.some((typeName) => this.isVisibleType(typeName, visibleFiles))
    ) {
      return { candidates: [], abstractDispatch: false, rtaActive: false };
    }
    const direct = this.directCandidates?.resolve({
      sourceLanguage: ref.source_language ?? undefined,
      sourceFileId: sourceFile,
      typeNames,
      memberName: target.member,
      callArity: target.hints?.callArity,
      visibleFiles,
    });
    if (direct) {
      this.directCandidateHits++;
      return direct;
    }
    const query = {
      sourceId: ref.owner_id,
      sourceLanguage: ref.source_language ?? undefined,
      typeNames,
      memberName: target.member,
      callArity: target.hints?.callArity,
      limit: 65,
      // A source-inferred C++ receiver is still constrained by translation-unit
      // visibility. Expanding every inferred member lookup to the full
      // workspace turns ordinary `field->method()` calls into workspace-wide
      // provider/method-set CTEs and can make graph resolution quadratic.
      // Quoted include roots are resolved into IMPORTS edges, so the regular
      // recursive visibility closure is both more precise and much cheaper.
      workspaceVisible: false,
      visibleFileIds,
      expandImports: false,
      abstractRootHint: typeNames.some((typeName) =>
        this.isVisibleAbstractType(typeName, visibleFiles),
      ),
      excludedInstantiationFileIds: this.testFileIds.has(sourceFile)
        ? []
        : [...this.testFileIds],
    };
    const key = [
      ref.source_language ?? "",
      sourceFile,
      [...visibleFileIds].sort().join("\0"),
      [...typeNames].sort().join("\0"),
      target.member,
      target.hints?.callArity ?? -1,
    ].join("\x01");
    const cached = this.semanticCandidateCache.get(key);
    if (cached) {
      this.semanticCandidateCacheHits++;
      this.semanticCandidateCache.delete(key);
      this.semanticCandidateCache.set(key, cached);
      return cached;
    }
    this.semanticCandidateQueries++;
    const startedAt = performance.now();
    const resolved = this.candidates.resolve(query);
    const durationMs = performance.now() - startedAt;
    this.semanticCandidateDurationMs += durationMs;
    const language = ref.source_language ?? "unknown";
    const languageStats = this.semanticCandidateStatsByLanguage.get(
      language,
    ) ?? { count: 0, durationMs: 0 };
    languageStats.count++;
    languageStats.durationMs += durationMs;
    this.semanticCandidateStatsByLanguage.set(language, languageStats);
    if (this.semanticCandidateCache.size >= SEMANTIC_CANDIDATE_CACHE_SIZE) {
      const oldest = this.semanticCandidateCache.keys().next().value;
      if (oldest !== undefined) this.semanticCandidateCache.delete(oldest);
    }
    this.semanticCandidateCache.set(key, resolved);
    return resolved;
  }

  private isVisibleAbstractType(
    typeName: string,
    visibleFiles: ReadonlySet<string>,
  ): boolean {
    for (const fileId of this.abstractTypeFiles.get(typeName) ?? [])
      if (visibleFiles.has(fileId)) return true;
    return false;
  }

  private isVisibleType(
    typeName: string,
    visibleFiles: ReadonlySet<string>,
  ): boolean {
    for (const fileId of this.typeFiles.get(typeLookupName(typeName)) ?? [])
      if (visibleFiles.has(fileId)) return true;
    return false;
  }

  private expandTypeAliases(
    typeNames: readonly string[],
    visibleFiles?: ReadonlySet<string>,
  ): string[] {
    const expanded = new Set<string>();
    for (const original of typeNames) {
      let current = typeLookupName(original);
      const seen = new Set<string>();
      for (let depth = 0; depth < 16 && !seen.has(current); depth++) {
        seen.add(current);
        expanded.add(current);
        const aliases = this.typeAliases.get(current) ?? [];
        const targets = new Set(
          aliases
            .filter((alias) => !visibleFiles || visibleFiles.has(alias.fileId))
            .map((alias) => alias.target),
        );
        // Package/module aliases may reuse the same local name. Continue only
        // when the active visibility scope proves one logical target.
        if (targets.size !== 1) break;
        const next = [...targets][0]!;
        current = typeLookupName(next);
      }
    }
    return [...expanded];
  }

  private receiverTypeIsExternal(
    typeNames: readonly string[],
    language?: string,
  ): boolean {
    return this.expandTypeAliases(typeNames).some((typeName) =>
      isExternalReceiverType(typeName, language),
    );
  }

  private transitiveImportedFiles(sourceFileId: string): readonly string[] {
    const cached = this.importedFileClosure.get(sourceFileId);
    if (cached) return cached;
    const visited = new Set<string>();
    const pending = [...(this.importAdjacency.get(sourceFileId) ?? [])];
    while (pending.length > 0) {
      const fileId = pending.pop()!;
      if (fileId === sourceFileId || visited.has(fileId)) continue;
      visited.add(fileId);
      for (const imported of this.importAdjacency.get(fileId) ?? [])
        if (!visited.has(imported)) pending.push(imported);
    }
    const closure = [...visited].sort();
    this.importedFileClosure.set(sourceFileId, closure);
    return closure;
  }

  private preferredFilesFor(
    sourceFileId: string,
    language?: string,
  ): readonly string[] {
    const preferred = this.preferredFiles.get(sourceFileId) ?? [];
    if (!resolutionSemantics(language).transitivePreferredFiles)
      return preferred;
    return [
      ...new Set(
        preferred.flatMap((fileId) => {
          const directory = this.fileDirectories.get(fileId);
          return directory === undefined
            ? [fileId]
            : (this.filesByDirectory.get(directory) ?? [fileId]);
        }),
      ),
    ];
  }

  private lexicalSourceCandidate(
    names: NameIndex,
    sourceFileId: string,
    member: string,
    lexicalSource: string | undefined,
  ): string | undefined {
    if (!lexicalSource || lexicalSource.includes(".")) return undefined;
    const binding = this.resolveReexportBinding(
      (this.importBindings.get(sourceFileId) ?? []).find(
        (candidate) => candidate.local_name === lexicalSource,
      ),
    );
    const directFiles = [binding?.dst_file_id ?? sourceFileId];
    const direct = names
      .candidates(member, directFiles)
      .filter((candidate) => isCallableSymbolKind(candidate.kind));
    if (direct.length !== 0)
      return direct.length === 1 ? direct[0]!.id : undefined;
    if (!binding) return undefined;
    const immediate = names
      .candidates(member, this.importAdjacency.get(binding.dst_file_id) ?? [])
      .filter((candidate) => isCallableSymbolKind(candidate.kind));
    if (immediate.length !== 0)
      return immediate.length === 1 ? immediate[0]!.id : undefined;
    const transitive = names
      .candidates(member, this.transitiveImportedFiles(binding.dst_file_id))
      .filter((candidate) => isCallableSymbolKind(candidate.kind));
    return transitive.length === 1 ? transitive[0]!.id : undefined;
  }

  private bindingVisibleFiles(binding: ImportBinding): readonly string[] {
    return [
      binding.dst_file_id,
      ...this.transitiveImportedFiles(binding.dst_file_id),
    ];
  }

  private resolveReexportBinding(
    binding: ImportBinding | undefined,
  ): ImportBinding | undefined {
    if (!binding) return undefined;
    const localName = binding.local_name;
    const seen = new Set<string>();
    let current = binding;
    while (current.imported_name !== "*") {
      const key = `${current.dst_file_id}\0${current.imported_name}`;
      if (seen.has(key)) break;
      seen.add(key);
      const candidates = (
        this.importBindings.get(current.dst_file_id) ?? []
      ).filter(
        (candidate) =>
          candidate.reexport && candidate.local_name === current.imported_name,
      );
      if (candidates.length !== 1) break;
      current = { ...candidates[0]!, local_name: localName };
    }
    return current;
  }

  private heuristicCandidate(
    ref: RefRow,
    names: NameIndex,
    sourceFileId: string,
    preferredFileIds: readonly string[],
    includeSourceFile = true,
  ): string | null {
    if (ref.receiver_kind !== "qualified" || !ref.member_name) return null;
    // Qualified syntax alone does not justify a bare-name fallback. Require
    // an imported/preferred scope so Cursor::new cannot bind to the current
    // class's new(), nor console.log to an unrelated local log().
    if (preferredFileIds.length === 0) return null;
    const candidates = names
      .candidates(ref.member_name, [
        ...(includeSourceFile ? [sourceFileId] : []),
        ...preferredFileIds,
      ])
      .filter(
        (entry) => entry.id !== ref.owner_id && entry.containerId !== undefined,
      );
    return candidates.length === 1 ? candidates[0]!.id : null;
  }

  private persistDynamicCall(
    ref: RefRow,
    target: NonNullable<PendingRef["target"]>,
    candidates: readonly string[],
    reason:
      | "polymorphic_dispatch"
      | "unknown_receiver_type"
      | "lexical_dispatch"
      | "runtime_dispatch",
    explicitCandidateReason?:
      | "hierarchy"
      | "generic_bound"
      | "method_set"
      | "function_pointer"
      | "namespace_export",
    candidateConfidence = 0.65,
  ): void {
    this.projections.addDynamicRef({
      id: ref.id,
      reason,
      member_name: target.member,
      receiver_kind: target.receiver?.kind ?? null,
      receiver_name: target.receiver?.name ?? null,
      resolution_hints: target.hints ? JSON.stringify(target.hints) : null,
    });
    const candidateReason =
      explicitCandidateReason ??
      (target.hints?.genericBounds?.length ? "generic_bound" : "hierarchy");
    for (const candidate of candidates)
      this.projections.addCandidate({
        edge_id: ref.id,
        target_id: candidate,
        reason: candidateReason,
        confidence: candidateConfidence,
      });
  }

  private insertSymbolEdge(
    ref: RefRow,
    dst: string,
    edgeKind: "CALLS" | "REFS" | "INHERITS",
    metadata: {
      provenance: "static" | "heuristic";
      confidence: number;
      evidence?: string;
      resolutionHints?: ReferenceResolutionHints;
    } = { provenance: "static", confidence: 1 },
  ): void {
    let targetId = dst;
    let targetKind = edgeKind;
    if (ref.ref_kind === "new") {
      this.projections.addEdge({
        id: `${ref.id}:instantiates`,
        src_id: ref.owner_id,
        dst_id: dst,
        src_is_file: 0,
        dst_is_file: 0,
        kind: "INSTANTIATES",
        rel: "new",
        count: 1,
        first_line: ref.line,
        ref_name: ref.ref_name,
        source_language: ref.source_language,
        imported_name: null,
        local_name: null,
        receiver_kind: null,
        receiver_name: null,
        member_name: null,
        resolution_hints: null,
        provenance: "static",
        confidence: 1,
        evidence: null,
      });
      const arity = parseResolutionHints(ref.resolution_hints)?.callArity;
      const constructors = (this.constructorsByContainer.get(dst) ?? []).filter(
        (candidate) =>
          arity === undefined ||
          candidate.arity === null ||
          candidate.arity === arity,
      );
      if (constructors.length === 1) {
        targetId = constructors[0]!.id;
        targetKind = "CALLS";
      }
    }
    this.projections.addEdge({
      id: ref.id,
      src_id: ref.owner_id,
      dst_id: targetId,
      src_is_file: 0,
      dst_is_file: 0,
      kind: targetKind,
      rel: ref.ref_kind,
      count: 1,
      first_line: ref.line,
      ref_name: ref.ref_name,
      source_language: ref.source_language,
      imported_name: ref.imported_name,
      local_name: ref.local_name,
      receiver_kind: ref.receiver_kind,
      receiver_name: ref.receiver_name,
      member_name: ref.member_name,
      resolution_hints: metadata.resolutionHints
        ? JSON.stringify(metadata.resolutionHints)
        : ref.resolution_hints,
      provenance: metadata.provenance,
      confidence: metadata.confidence,
      evidence: metadata.evidence ?? null,
    });
    this.projections.markResolved(ref.id);
  }

  private resolveImport(
    ref: RefRow,
    paths: FilePathIndex,
    attempt: number,
  ): void {
    const from = paths.getById(ref.owner_id);
    if (!from) return this.failRef(ref.id, attempt);
    const rustInlineModuleDepth = parseRustInlineModuleDepth(
      ref.resolution_hints,
    );
    const importMode = resolutionSemantics(from.format).relativeImportMode;
    let importedName = ref.imported_name;
    let result =
      importMode === "rust" &&
      rustImportStaysInCurrentFile(ref.ref_name, rustInlineModuleDepth)
        ? {
            status: "resolved" as const,
            fileId: from.id,
            absolutePath: from.absolutePath,
          }
        : importMode === "python" &&
            importedName !== null &&
            /^\.+$/.test(ref.ref_name)
          ? resolveImportPath(
              `${ref.ref_name}${importedName}`,
              ref.owner_id,
              from.format,
              paths,
              { rustInlineModuleDepth },
            )
          : { status: "failed" as const };
    if (result.status === "resolved") importedName = "*";
    else
      result = resolveImportPath(
        ref.ref_name,
        ref.owner_id,
        from.format,
        paths,
        { rustInlineModuleDepth },
      );
    if (result.status === "external") {
      this.projections.markExternal(ref.id);
      return;
    }
    if (result.status !== "resolved") return this.failRef(ref.id, attempt);
    this.projections.addEdge({
      id: ref.id,
      src_id: ref.owner_id,
      dst_id: result.fileId,
      src_is_file: 1,
      dst_is_file: 1,
      kind: "IMPORTS",
      rel: "import",
      count: 1,
      first_line: ref.line,
      ref_name: ref.ref_name,
      source_language: ref.source_language,
      imported_name: importedName,
      local_name: ref.local_name,
      receiver_kind: ref.receiver_kind,
      receiver_name: ref.receiver_name,
      member_name: ref.member_name,
      resolution_hints: ref.resolution_hints,
      provenance: "static",
      confidence: 1,
      evidence: null,
    });
    this.projections.markResolved(ref.id);
  }

  /**
   * A grouped Rust `use` leaf is syntactically ambiguous until paths are
   * resolved: it may be an item re-exported by the parent module or a child
   * module itself. Extraction retains both alternatives. Once either binding
   * resolves, retire the sibling alternative so it does not remain a failed
   * retry forever.
   */
  private retireResolvedRustImportAlternatives(attempt: number): void {
    this.database
      .prepare(
        `UPDATE unresolved_refs AS unresolved
       SET status='external',last_attempt=?
       WHERE unresolved.status='failed'
         AND unresolved.ref_kind='import'
         AND unresolved.source_language='rust'
         AND EXISTS (
           SELECT 1 FROM edges resolved
           WHERE resolved.kind='IMPORTS'
             AND resolved.src_is_file=1
             AND resolved.src_id=unresolved.owner_id
             AND resolved.first_line=unresolved.line
             AND (
               unresolved.local_name IS NULL
               OR resolved.local_name=unresolved.local_name
             )
         )`,
      )
      .run(attempt);
  }

  private retryableRefs(
    attemptWatermark: number,
    phase: ResolvePhase,
    retryFailed: boolean,
  ): RefRow[] {
    const phaseCondition = resolvePhaseCondition(phase);
    return this.all<RefRow>(
      `SELECT id,owner_id,owner_is_file,ref_name,ref_kind,line,status,imported_name,local_name,source_language,receiver_kind,receiver_name,member_name,resolution_hints,last_attempt
       FROM (
         SELECT unresolved_refs.*,
                row_number() OVER (PARTITION BY ref_name ORDER BY last_attempt,id) AS retry_rank
         FROM unresolved_refs
         WHERE status='failed' AND ?=1 AND last_attempt<? AND ${phaseCondition}
       )
       WHERE retry_rank<=?
       UNION ALL
       SELECT id,owner_id,owner_is_file,ref_name,ref_kind,line,status,imported_name,local_name,source_language,receiver_kind,receiver_name,member_name,resolution_hints,last_attempt
       FROM unresolved_refs
       WHERE status='pending' AND last_attempt<? AND ${phaseCondition}
       ORDER BY ref_name,id LIMIT ?`,
      retryFailed ? 1 : 0,
      attemptWatermark,
      PER_NAME_CEILING,
      attemptWatermark,
      RESOLVE_BATCH_SIZE,
    );
  }

  private inheritanceContainers(
    containerId: string,
    includeOwner: boolean,
  ): string[] {
    return this.all<{ id: string; depth: number }>(
      `WITH RECURSIVE hierarchy(id,depth) AS (
         SELECT ?,0
         UNION
         SELECT e.dst_id,h.depth+1
         FROM edges e JOIN hierarchy h ON e.src_id=h.id
         WHERE e.kind='INHERITS'
           AND e.rel IN ('extends','implements')
           AND h.depth<32
       )
       SELECT id,depth FROM hierarchy WHERE depth>=? ORDER BY depth,id`,
      containerId,
      includeOwner ? 0 : 1,
    ).map((row) => row.id);
  }

  private loadFunctionPointerSlots(): void {
    this.functionPointerSlots.clear();
    for (const row of this.all<{ container_type: string; field: string }>(
      `SELECT DISTINCT
         json_extract(resolution_hints,
                      '$.functionPointerRegistration.containerType')
           AS container_type,
         json_extract(resolution_hints,
                      '$.functionPointerRegistration.field') AS field
       FROM edges
       WHERE source_language IN ('c','cpp')
         AND json_type(resolution_hints,
                       '$.functionPointerRegistration')='object'`,
    ))
      this.functionPointerSlots.add(
        functionPointerSlotKey(row.container_type, row.field),
      );
  }

  private namespaceDispatchTargets(
    ref: RefRow,
    target: ReturnType<typeof referenceTargetFromRaw>,
    sourceFileId: string,
  ): string[] {
    const receiverSources = new Set([
      ...(target.hints?.dynamicDispatch?.receiverSources ?? []),
      ...(target.receiver?.name ? [target.receiver.name] : []),
    ]);
    const namespaceFiles = [
      ...new Set(
        (this.importBindings.get(sourceFileId) ?? [])
          .filter(
            (binding) =>
              binding.imported_name === "*" &&
              receiverSources.has(binding.local_name),
          )
          .map((binding) => binding.dst_file_id),
      ),
    ].sort();
    if (namespaceFiles.length === 0) return [];
    const member = target.member === "<dynamic>" ? "" : target.member;
    const key = `${ref.ref_kind}\x01${member}\x01${namespaceFiles.join("\0")}`;
    const cached = this.namespaceCandidateCache.get(key);
    if (cached) return cached;
    const rows = this.all<{ id: string; kind: string; name: string }>(
      `WITH RECURSIVE export_files(id) AS (
         SELECT value FROM json_each(?)
         UNION
         SELECT edge.dst_id FROM edges edge
         JOIN export_files source ON source.id=edge.src_id
         WHERE edge.kind='IMPORTS'
           AND edge.src_is_file=1 AND edge.dst_is_file=1
           AND COALESCE(json_extract(edge.resolution_hints,'$.reexport'),0)=1
       )
       SELECT symbol.id,symbol.kind,symbol.name
       FROM symbols symbol JOIN export_files file ON file.id=symbol.file_id
       WHERE symbol.name IS NOT NULL AND symbol.is_exported=1
         AND NOT EXISTS (
           SELECT 1 FROM contains ownership WHERE ownership.child_id=symbol.id
         )
       ORDER BY symbol.name,symbol.id LIMIT 512`,
      JSON.stringify(namespaceFiles),
    );
    const candidates = rows
      .filter(
        (row) =>
          (isCallableSymbolKind(row.kind) ||
            ["class", "component", "struct"].includes(row.kind)) &&
          (!member || row.name.toLowerCase() === member.toLowerCase()),
      )
      .map((row) => row.id);
    this.namespaceCandidateCache.set(key, candidates);
    return candidates;
  }

  private functionPointerTargets(
    ref: RefRow,
    target: ReturnType<typeof referenceTargetFromRaw>,
  ): string[] {
    if (!resolutionSemantics(ref.source_language).functionPointerDispatch)
      return [];
    const arrayName =
      target.hints?.dynamicDispatch?.form === "computed_member" &&
      target.receiver?.name &&
      /^[A-Za-z_]\w*$/.test(target.receiver.name)
        ? target.receiver.name
        : undefined;
    const typeNames = arrayName
      ? [FUNCTION_POINTER_ARRAY_CONTAINER]
      : (target.hints?.candidateTypes ??
        (target.hints?.receiverType ? [target.hints.receiverType] : []));
    const memberName = arrayName ?? target.member;
    if (
      !typeNames.some((typeName) =>
        this.functionPointerSlots.has(
          functionPointerSlotKey(typeName, memberName),
        ),
      )
    )
      return [];
    const key = `${ref.owner_id}\x01${[...typeNames].sort().join("\0")}\x01${memberName}`;
    const cached = this.functionPointerCandidateCache.get(key);
    if (cached) return cached;
    // Registration tables and handler definitions commonly live outside the
    // dispatching translation unit. The exact slot key is the precision
    // boundary, so workspace visibility is safe after the key gate above.
    const candidates = this.candidates.findFunctionPointerTargets({
      sourceId: ref.owner_id,
      sourceLanguage: ref.source_language ?? undefined,
      typeNames,
      memberName,
      workspaceVisible: !arrayName,
      limit: 300,
    });
    this.functionPointerCandidateCache.set(key, candidates);
    return candidates;
  }

  /**
   * Resolve `factory(...).member()` when the factory declaration lives in a
   * different file. Return types are durable symbol facts, so this works for
   * all adapters that expose a declared return type without reparsing source.
   */
  private withInferredFactoryReceiverType(
    target: ReturnType<typeof referenceTargetFromRaw>,
    ref: RefRow,
    sourceFileId: string,
    binding: ImportBinding | undefined,
    preferredFiles: readonly string[],
  ): ReturnType<typeof referenceTargetFromRaw> {
    if (target.hints?.receiverType || !target.receiver?.name) return target;
    const rawReceiver = receiverExpression(target.raw, target.member);
    const callableReceiver =
      stripTrailingCallArguments(target.receiver.name) ??
      (rawReceiver ? stripTrailingCallArguments(rawReceiver) : undefined);
    if (!callableReceiver) return target;

    const receiverParts = callableReceiver.split(/[.:]/).filter(Boolean);
    const factoryName = receiverParts.at(-1);
    if (!factoryName || !/^[A-Za-z_$]\w*$/.test(factoryName)) return target;
    const containerName =
      receiverParts.length > 1 ? receiverParts.at(-2) : null;
    const rows = this.callableReturnCache.get(factoryName) ?? [];
    if (rows.length === 0) return target;

    const boundFile =
      binding &&
      (binding.local_name === factoryName ||
        binding.local_name === receiverParts[0])
        ? binding.dst_file_id
        : undefined;
    const sourceDirectory = this.fileDirectories.get(sourceFileId);
    const ranked = rows
      .map((row) => ({
        row,
        rank:
          containerName && row.containerName === containerName
            ? 0
            : boundFile && row.fileId === boundFile
              ? 1
              : row.fileId === sourceFileId
                ? 2
                : preferredFiles.includes(row.fileId)
                  ? 3
                  : sourceDirectory &&
                      this.fileDirectories.get(row.fileId) === sourceDirectory
                    ? 4
                    : 5,
      }))
      .sort(
        (left, right) =>
          left.rank - right.rank || left.row.id.localeCompare(right.row.id),
      );
    const bestRank = ranked[0]!.rank;
    const best = ranked.filter((candidate) => candidate.rank === bestRank);
    const returnTypes = new Set(
      best.map((candidate) => {
        const normalized = normalizePersistedType(candidate.row.returnType);
        return isSelfReturnType(normalized) && candidate.row.containerName
          ? candidate.row.containerName
          : normalized;
      }),
    );
    if (returnTypes.size !== 1) return target;
    // A workspace-wide fallback is safe only when the callable itself is
    // unique. Scoped matches may have overloads as long as they agree on type.
    if (bestRank === 5 && rows.length !== 1) return target;
    const receiverType = returnTypes.values().next().value as string;
    return {
      ...target,
      hints: {
        ...target.hints,
        receiverType,
        candidateTypes: [receiverType],
        ...(resolutionSemantics(ref.source_language).virtualReturnDispatch
          ? { dispatch: "virtual" as const }
          : {}),
      },
    };
  }

  private cachedInheritanceContainers(
    cache: Map<string, readonly string[]>,
    containerId: string,
    includeOwner: boolean,
  ): readonly string[] {
    const key = `${containerId}\0${includeOwner ? "with-owner" : "bases-only"}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const containers = this.inheritanceContainers(containerId, includeOwner);
    cache.set(key, containers);
    return containers;
  }

  private failRef(id: string, _attempt: number): void {
    this.failedRefIds.add(id);
  }

  private flushFailedRefs(attempt: number): void {
    if (this.failedRefIds.size === 0) return;
    this.database
      .prepare(
        `UPDATE unresolved_refs SET status='failed',last_attempt=?
         WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .run(attempt, JSON.stringify([...this.failedRefIds]));
  }

  private nextAttempt(): number {
    const row = this.database
      .prepare(
        `INSERT INTO graph_meta(key,value) VALUES('pending_ref_attempt','1')
         ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1
         RETURNING value`,
      )
      .get() as { value: string };
    return Number(row.value);
  }
}

function resolvePhaseCondition(phase: ResolvePhase): string {
  if (phase === "imports") return "(owner_is_file=1 OR ref_kind='import')";
  if (phase === "inheritance")
    return "owner_is_file=0 AND ref_kind IN ('extends','implements','overrides')";
  if (phase === "instantiations") return "owner_is_file=0 AND ref_kind='new'";
  if (phase === "function_registrations")
    return "owner_is_file=0 AND json_type(resolution_hints,'$.functionPointerRegistration')='object'";
  return `owner_is_file=0
    AND ref_kind NOT IN ('import','extends','implements','overrides','new')
    AND COALESCE(json_type(
      resolution_hints,'$.functionPointerRegistration'
    ),'null')<>'object'`;
}

function functionPointerSlotKey(containerType: string, field: string): string {
  return `${containerType}\0${field}`;
}

function refReceiver(name: string): string {
  return name.split(/(?:[./]|::)/, 1)[0] ?? name;
}

function refKindToEdgeKind(kind: string): "CALLS" | "REFS" | "INHERITS" {
  if (kind === "call") return "CALLS";
  if (kind === "extends" || kind === "implements" || kind === "overrides")
    return "INHERITS";
  return "REFS";
}

function normalizePersistedType(value: string): string {
  return value
    .trim()
    .replace(/[;:]$/, "")
    .replace(/^(?:const\s+)+/, "")
    .replace(/^[*&]+|[&*]+$/g, "")
    .replace(/<.*>$/, "")
    .replace(/\[.*\]$/, "")
    .split(/::|\./)
    .at(-1)!;
}

function ownerFieldPath(receiver: string): string[] {
  const segments = receiver
    .split(".")
    .map((segment) => segment.replace(/[!?]+$/g, "").trim())
    .filter(Boolean);
  return segments[0] === "this" ? segments.slice(1) : [];
}

function sourceResolutionHints(
  hints: ReferenceResolutionHints | undefined,
): ReferenceResolutionHints | undefined {
  if (!hints) return undefined;
  const source = { ...hints };
  delete source.receiverType;
  delete source.receiverTypeEvidence;
  delete source.candidateTypes;
  delete source.resolutionDependencies;
  delete source.dispatch;
  return Object.keys(source).length > 0 ? source : undefined;
}

function typeDependencyNames(type: string): string[] {
  return [...type.matchAll(/[A-Za-z_$][\w$]*/g)]
    .map((match) => match[0])
    .filter((name) => name !== "ReturnType");
}

function declaredFieldType(name: string, signature: string): string | null {
  const marker = new RegExp(`${escapeRegExp(name)}[!?]?\\s*:\\s*`).exec(
    signature,
  );
  if (!marker) return null;
  const value = signature.slice(marker.index + marker[0].length).trim();
  const initializer = value.search(/=(?!=|>)/);
  return (
    (initializer >= 0 ? value.slice(0, initializer) : value)
      .trim()
      .replace(/[;,]$/, "") || null
  );
}

function typeAliasObjectFields(signature: string): Map<string, string> {
  const assignment = signature.indexOf("=");
  if (assignment < 0) return new Map();
  const target = signature.slice(assignment + 1).trim();
  const body =
    /=>\s*\{([\s\S]*)\}\s*;?$/.exec(target)?.[1] ??
    /^\{([\s\S]*)\}\s*;?$/.exec(target)?.[1];
  if (!body) return new Map();
  const fields = new Map<string, string>();
  for (const match of body.matchAll(
    /(?:^|[;,])\s*(?:readonly\s+)?([#$A-Za-z_]\w*)[?]?\s*:\s*([^;,{}]+)/g,
  )) {
    const type = match[2]!.trim();
    if (type) fields.set(match[1]!, type);
  }
  return fields;
}

function aliasTargetType(aliasName: string, signature: string): string | null {
  const assignment = signature.indexOf("=");
  let target =
    assignment >= 0
      ? signature.slice(assignment + 1)
      : signature
          .replace(/^\s*typedef\s+/, "")
          .replace(
            new RegExp(`\\b${escapeRegExp(aliasName)}\\b\\s*;?\\s*$`),
            "",
          );
  target = target.trim().replace(/;$/, "");
  if (!target) return null;
  target = unwrapSingleTargetTypeWrapper(target);
  const outer = target.match(
    /(?:^|\b)([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*(?:<|$)/,
  )?.[1];
  const normalized = outer?.startsWith("std::")
    ? outer
    : normalizePersistedType(outer ?? target);
  return normalized && normalized !== aliasName ? normalized : null;
}

const SINGLE_TARGET_TYPE_WRAPPERS = new Set([
  "Annotated",
  "ClassVar",
  "Final",
  "NotRequired",
  "Optional",
  "ReadOnly",
  "Required",
  "Type",
]);

function unwrapSingleTargetTypeWrapper(value: string): string {
  let current = value.trim();
  for (let depth = 0; depth < 8; depth++) {
    const match = /^(?:typing\.)?([A-Za-z_]\w*)\s*\[([\s\S]*)\]$/.exec(current);
    if (!match || !SINGLE_TARGET_TYPE_WRAPPERS.has(match[1]!)) break;
    const first = firstTopLevelTypeArgument(match[2]!);
    if (!first) break;
    current = first;
  }
  return current;
}

function firstTopLevelTypeArgument(value: string): string | undefined {
  let square = 0;
  let round = 0;
  let angle = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "[") square++;
    else if (char === "]") square--;
    else if (char === "(") round++;
    else if (char === ")") round--;
    else if (char === "<") angle++;
    else if (char === ">") angle--;
    else if (char === "," && square === 0 && round === 0 && angle === 0)
      return value.slice(0, index).trim() || undefined;
  }
  return value.trim() || undefined;
}

/** Normalize a source-language type spelling to the symbol-table leaf name. */
function typeLookupName(value: string): string {
  let normalized = value
    .trim()
    .replace(
      /^(?:(?:const|volatile|mut|class|struct|interface|enum|dyn|impl)\s+)+/,
      "",
    )
    .replace(/(?:\[\]|[&*?])+$/g, "")
    .trim();
  const generic = normalized.indexOf("<");
  if (generic >= 0) normalized = normalized.slice(0, generic).trim();
  const qualified = normalized.split(/::|\./).filter(Boolean);
  return qualified.at(-1) ?? normalized;
}

function isSelfReturnType(value: string): boolean {
  return /^(?:Self|self|this)$/.test(value);
}

/** Remove the final balanced argument list from a chained-call receiver. */
function stripTrailingCallArguments(receiver: string): string | undefined {
  const value = receiver.trim();
  if (!value.endsWith(")")) return undefined;
  let depth = 0;
  for (let index = value.length - 1; index >= 0; index--) {
    const char = value[index];
    if (char === ")") depth++;
    else if (char === "(") {
      depth--;
      if (depth === 0) return value.slice(0, index).trim() || undefined;
    }
  }
  return undefined;
}

function receiverExpression(raw: string, member: string): string | undefined {
  const escaped = member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(.*)(?:\\.|->|::)\\s*${escaped}$`).exec(raw)?.[1]?.trim();
}

function parseResolutionHints(
  value: string | null,
): ReferenceResolutionHints | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as ReferenceResolutionHints;
  } catch {
    return undefined;
  }
}

function parseRustInlineModuleDepth(value: string | null): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value) as { rustInlineModuleDepth?: unknown };
    return typeof parsed.rustInlineModuleDepth === "number" &&
      Number.isInteger(parsed.rustInlineModuleDepth) &&
      parsed.rustInlineModuleDepth > 0
      ? parsed.rustInlineModuleDepth
      : 0;
  } catch {
    return 0;
  }
}

function rustImportStaysInCurrentFile(
  spec: string,
  inlineModuleDepth: number,
): boolean {
  if (inlineModuleDepth <= 0) return false;
  const segments = spec.split("::").filter(Boolean);
  if (segments[0] === "self") return true;
  let parentCount = 0;
  while (segments[parentCount] === "super") parentCount++;
  return parentCount > 0 && parentCount <= inlineModuleDepth;
}
