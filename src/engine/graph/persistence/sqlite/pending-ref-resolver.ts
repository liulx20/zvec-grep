import { performance } from "node:perf_hooks";
import { dirname } from "node:path";
import { escapeRegExp } from "../../../utils/regex.js";
import { FilePathIndex } from "../../imports/path-index.js";
import { resolveImportPath } from "../../imports/resolve-path.js";
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
  container_id: string | null;
  container_name: string | null;
};

type ImportBinding = {
  imported_name: string;
  dst_file_id: string;
  local_name: string;
};

type BufferedEdge = {
  source: string;
  target: string;
  kind: string;
  metadata: string;
  line: number | null;
  col: number | null;
  provenance: string;
};

type BufferedDynamicRef = {
  id: string;
  metadata: string;
  candidates: string;
};

type BufferedCandidate = {
  edge_id: string;
  target_id: string;
  reason: string;
  confidence: number;
};

/** Converts pending call/ref/import sites into persisted graph edges. */
export class SqlitePendingRefResolver {
  private readonly candidates: SemanticCandidateRepository;
  private directCandidates?: DirectSemanticCandidateIndex;
  private cppReceivers = new CppReceiverTypeInference();
  private readonly semanticCandidateCache = new Map<
    string,
    SemanticCandidateResolution
  >();
  private readonly functionPointerCandidateCache = new Map<string, string[]>();
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
  private readonly failedRefIds = new Set<string>();
  private readonly bufferedEdges: BufferedEdge[] = [];
  private readonly bufferedDynamicRefs: BufferedDynamicRef[] = [];
  private readonly bufferedCandidates: BufferedCandidate[] = [];
  private readonly bufferedExternalRefIds = new Set<string>();
  private readonly bufferedResolvedRefIds = new Set<string>();
  private readonly fileDirectories = new Map<string, string>();
  private readonly filesByDirectory = new Map<string, string[]>();
  private semanticCandidateQueries = 0;
  private semanticCandidateCacheHits = 0;
  private semanticCandidateDurationMs = 0;
  private readonly semanticCandidateStatsByLanguage = new Map<
    string,
    { count: number; durationMs: number }
  >();
  private directCandidateHits = 0;
  private attemptCounter = 0;

  constructor(private readonly database: SqliteGraphDatabase) {
    this.candidates = new SemanticCandidateRepository(database);
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
  async resolvePending(options: ResolvePendingOptions = {}): Promise<void> {
    this.assertWritable();
    let startedAt = performance.now();
    this.database.endBulkLoad();
    options.onTiming?.("graph_bulk_finalize", performance.now() - startedAt);
    const retryFailed = options.retryFailed ?? true;
    const resolvable =
      this.one<{ count: number }>(
        `SELECT COUNT(*) AS count FROM unresolved_refs
         WHERE status='pending' OR (?=1 AND status='failed')`,
        retryFailed ? 1 : 0,
      )?.count ?? 0;
    if (resolvable === 0) return;
    startedAt = performance.now();
    const names = new NameIndex();
    this.fileDirectories.clear();
    this.filesByDirectory.clear();
    for (const file of options.files ?? []) {
      // Absolute directory identity keeps same-named packages in different
      // workspace roots independent. Relative directory keys accidentally
      // merged multi-root Java packages and Go modules.
      const directory = dirname(file.absolutePath);
      this.fileDirectories.set(file.id, directory);
      const files = this.filesByDirectory.get(directory) ?? [];
      files.push(file.id);
      this.filesByDirectory.set(directory, files);
    }
    const lookupNames = this.pendingSymbolNames();
    const filePaths = new Map(
      (options.files ?? []).map((file) => [file.id, file.relativePath]),
    );
    names.load(
      this.all<
        SymbolRow & {
          container_id: string | null;
          container_name: string | null;
        }
      >(
        `SELECT s.id,s.file_path AS file_id,s.name,s.qualified_name,s.kind,s.is_exported,s.signature,
                p.id AS container_id,p.name AS container_name
         FROM nodes s
         LEFT JOIN edges c ON c.target=s.id AND c.kind='contains'
         LEFT JOIN nodes p ON p.id=c.source
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
        containerName: row.container_name ?? undefined,
        containerId: row.container_id ?? undefined,
      })),
    );
    const paths = new FilePathIndex(options.files ?? []);
    this.cppReceivers = new CppReceiverTypeInference(options.files ?? []);
    this.semanticCandidateCache.clear();
    this.semanticCandidateQueries = 0;
    this.semanticCandidateCacheHits = 0;
    this.semanticCandidateDurationMs = 0;
    this.semanticCandidateStatsByLanguage.clear();
    this.directCandidateHits = 0;
    this.directCandidates = undefined;
    this.functionPointerCandidateCache.clear();
    this.callableReturnCache.clear();
    for (const [name, candidates] of this.candidates.loadCallableReturns())
      this.callableReturnCache.set(name, candidates);
    this.functionPointerSlots.clear();
    const attempt = this.nextAttempt();
    options.onTiming?.("graph_resolve_prepare", performance.now() - startedAt);
    startedAt = performance.now();
    const imports = this.drainPhase("imports", attempt, retryFailed, (ref) =>
      this.resolveImport(ref, paths, attempt),
    );
    this.retireResolvedRustImportAlternatives(attempt);
    options.onTiming?.(
      "graph_resolve_imports",
      performance.now() - startedAt,
      imports,
    );
    startedAt = performance.now();
    this.prepareResolutionContext();
    this.loadDefaultExportCandidates(names, filePaths);
    options.onTiming?.("graph_resolve_context", performance.now() - startedAt);
    startedAt = performance.now();
    const inheritance = this.drainPhase(
      "inheritance",
      attempt,
      retryFailed,
      (ref) => this.resolveSymbol(ref, names, attempt, new Map()),
    );
    options.onTiming?.(
      "graph_resolve_inheritance",
      performance.now() - startedAt,
      inheritance,
    );
    this.semanticCandidateCache.clear();
    startedAt = performance.now();
    const functionRegistrations = this.drainPhase(
      "function_registrations",
      attempt,
      retryFailed,
      (ref) => this.resolveSymbol(ref, names, attempt, new Map()),
    );
    this.loadFunctionPointerSlots();
    options.onTiming?.(
      "graph_resolve_function_registrations",
      performance.now() - startedAt,
      functionRegistrations,
    );
    this.semanticCandidateCache.clear();
    startedAt = performance.now();
    const instantiations = this.drainPhase(
      "instantiations",
      attempt,
      retryFailed,
      (ref) => this.resolveSymbol(ref, names, attempt, new Map()),
    );
    options.onTiming?.(
      "graph_resolve_instantiations",
      performance.now() - startedAt,
      instantiations,
    );
    this.semanticCandidateCache.clear();
    startedAt = performance.now();
    this.directCandidates = new DirectSemanticCandidateIndex(this.database);
    options.onTiming?.(
      "graph_resolve_direct_index",
      performance.now() - startedAt,
    );
    // Build/cache hierarchy lookups only after every inheritance batch has
    // completed, so calls never observe a partial inheritance graph.
    const hierarchyCache = new Map<string, readonly string[]>();
    startedAt = performance.now();
    const symbols = this.drainPhase("symbols", attempt, retryFailed, (ref) =>
      this.resolveSymbol(ref, names, attempt, hierarchyCache),
    );
    options.onTiming?.(
      "graph_resolve_symbols",
      performance.now() - startedAt,
      symbols,
    );
    options.onTiming?.(
      "graph_resolve_semantic_queries",
      0,
      this.semanticCandidateQueries,
    );
    options.onTiming?.(
      "graph_resolve_semantic_cache_hits",
      0,
      this.semanticCandidateCacheHits,
    );
    options.onTiming?.(
      "graph_resolve_direct_hits",
      0,
      this.directCandidateHits,
    );
    options.onTiming?.(
      "graph_resolve_semantic_sql",
      this.semanticCandidateDurationMs,
      this.semanticCandidateQueries,
    );
    for (const [language, stats] of [
      ...this.semanticCandidateStatsByLanguage.entries(),
    ].sort(([left], [right]) => left.localeCompare(right))) {
      options.onTiming?.(
        `graph_resolve_semantic_sql_${timingLanguage(language)}`,
        stats.durationMs,
        stats.count,
      );
    }
    this.database.markResolvedProjections();
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
        `SELECT symbol.id,symbol.file_path AS file_id,symbol.name,symbol.qualified_name,
                symbol.kind,symbol.is_exported,symbol.signature,
                NULL AS container_id,NULL AS container_name
           FROM nodes symbol
           LEFT JOIN edges ownership ON ownership.target=symbol.id AND ownership.kind='contains'
          WHERE symbol.file_path IN (SELECT value FROM json_each(?))
            AND symbol.is_exported=1
            AND ownership.target IS NULL`,
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
      `SELECT reference_name AS ref_name,
              json_extract(metadata,'$.member') AS member_name,
              json_extract(metadata,'$.importedName') AS imported_name
       FROM unresolved_refs
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
      `SELECT DISTINCT json_extract(imports.metadata,'$.importedName') AS imported_name
       FROM unresolved_refs unresolved
       LEFT JOIN nodes owner ON owner.id=unresolved.from_node_id
       JOIN edges imports ON imports.source=COALESCE(owner.file_path,unresolved.from_node_id) AND imports.kind='imports'
       WHERE unresolved.from_node_id IS NOT NULL
         AND unresolved.status IN ('pending','failed')
         AND json_extract(imports.metadata,'$.importedName') IS NOT NULL`,
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
        this.clearProjectionBuffers();
        this.failedRefIds.clear();
        for (const ref of refs) resolve(ref);
        this.flushProjectionBuffers();
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
    for (const row of this.all<OwnerContext & { id: string }>(
      `WITH owner_symbols AS (
         SELECT s.*,
           CASE WHEN s.qualified_name LIKE '%::' || s.name
             THEN substr(s.qualified_name,1,length(s.qualified_name)-length(s.name)-2)
           END AS qualified_container_name
         FROM nodes s
       )
       SELECT s.id,s.file_path AS file_id,
         COALESCE(p.id,(
           SELECT CASE WHEN COUNT(*)=1 THEN MIN(candidate.id) END
           FROM nodes candidate
           WHERE candidate.name=s.qualified_container_name
             AND candidate.kind IN ('class','interface','trait','abstract_class')
         )) AS container_id,
         COALESCE(p.name,s.qualified_container_name) AS container_name
       FROM owner_symbols s
       LEFT JOIN edges c ON c.target=s.id AND c.kind='contains'
       LEFT JOIN nodes p ON p.id=c.source`,
    ))
      this.owners.set(row.id, row);
    for (const row of this.all<{
      src_id: string;
      dst_id: string;
      imported_name: string | null;
      local_name: string | null;
    }>(
      `SELECT COALESCE(src.file_path,e.source) AS src_id,e.target AS dst_id,
              json_extract(e.metadata,'$.importedName') AS imported_name,
              json_extract(e.metadata,'$.localName') AS local_name
       FROM edges e
       LEFT JOIN nodes src ON src.id=e.source
       WHERE e.kind='imports'
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
      });
      this.importBindings.set(row.src_id, bindings);
    }
    for (const row of this.all<{ name: string; file_id: string }>(
      `SELECT name,file_path AS file_id FROM nodes
       WHERE name IS NOT NULL
         AND kind IN ('interface','trait','abstract_class')`,
    )) {
      const files = this.abstractTypeFiles.get(row.name) ?? new Set<string>();
      files.add(row.file_id);
      this.abstractTypeFiles.set(row.name, files);
    }
    for (const row of this.all<{ name: string; file_id: string }>(
      `SELECT name,file_path AS file_id FROM nodes
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
      `SELECT name,signature,file_path AS file_id FROM nodes
       WHERE kind='alias' AND name IS NOT NULL AND signature IS NOT NULL`,
    )) {
      const target = aliasTargetType(row.name, row.signature);
      if (!target) continue;
      const aliases = this.typeAliases.get(row.name) ?? [];
      aliases.push({ target, fileId: row.file_id });
      this.typeAliases.set(row.name, aliases);
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
    const binding = (this.importBindings.get(owner.file_id) ?? [])
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
      this.persistDynamicCall(ref, pending.target, [], "runtime_dispatch");
      return;
    }
    const goPackageTarget =
      ref.source_language === "go" &&
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
    if (ref.ref_kind === "calls" && pending.target?.hints?.lexicallyBound) {
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
        this.bufferedExternalRefIds.add(ref.id);
      else this.failRef(ref.id, attempt);
      return;
    }
    const cppReceiver = this.withInferredCppReceiverType(
      pending.target!,
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
      this.bufferedExternalRefIds.add(ref.id);
      return;
    }
    // A typed receiver that is absent from the visible graph must not fall
    // through to the global same-member heuristic. The missing type is useful
    // uncertainty, not evidence that an unrelated class is the target.
    if (
      ref.ref_kind === "calls" &&
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
        },
      );
      return;
    }
    if (
      ref.ref_kind === "calls" &&
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
    );
    if (result.status === "external") {
      this.bufferedExternalRefIds.add(ref.id);
      return;
    }
    if (result.status !== "resolved") {
      if (
        ref.ref_kind === "function" &&
        binding &&
        this.bindingResolvesOnlyToNonCallables(ref, binding, names)
      ) {
        this.bufferedExternalRefIds.add(ref.id);
        return;
      }
      const heuristic = binding
        ? this.heuristicCandidate(
            ref,
            names,
            owner.file_id,
            this.bindingVisibleFiles(binding),
          )
        : null;
      if (!heuristic) {
        // Preserve a qualified call as an explicit uncertainty boundary. A
        // missing receiver type is not evidence for an arbitrary same-named
        // method, and a stable boundary must not be retried on every unrelated
        // resolve invocation.
        if (
          ref.ref_kind === "calls" &&
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
      ref.source_language !== "cpp" ||
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
          candidateTypes: [inferred.type],
          dispatch: "virtual",
        },
      },
      declarationFileId: inferred.declarationFileId,
    };
  }

  private resolveSemanticCandidates(
    ref: RefRow,
    target: NonNullable<PendingRef["target"]>,
    inferredDeclarationFileId?: string,
  ): SemanticCandidateResolution {
    const sourceFile = this.owners.get(ref.owner_id)?.file_id ?? ref.owner_id;
    const sourceDirectory = this.fileDirectories.get(sourceFile);
    const packageFiles =
      (ref.source_language === "go" || ref.source_language === "java") &&
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
      ref.source_language === "go" || ref.source_language === "java"
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
    if (language !== "java") return preferred;
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

  private bindingVisibleFiles(binding: ImportBinding): readonly string[] {
    return [
      binding.dst_file_id,
      ...this.transitiveImportedFiles(binding.dst_file_id),
    ];
  }

  private heuristicCandidate(
    ref: RefRow,
    names: NameIndex,
    sourceFileId: string,
    preferredFileIds: readonly string[],
  ): string | null {
    if (ref.receiver_kind !== "qualified" || !ref.member_name) return null;
    // Qualified syntax alone does not justify a bare-name fallback. Require
    // an imported/preferred scope so Cursor::new cannot bind to the current
    // class's new(), nor console.log to an unrelated local log().
    if (preferredFileIds.length === 0) return null;
    const candidates = names
      .candidates(ref.member_name, [sourceFileId, ...preferredFileIds])
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
      "hierarchy" | "generic_bound" | "method_set" | "function_pointer",
    candidateConfidence = 0.65,
  ): void {
    const dynamicMetadata: Record<string, unknown> = {};
    if (reason) dynamicMetadata.dynamicReason = reason;
    if (target.member) dynamicMetadata.member = target.member;
    if (target.receiver?.kind)
      dynamicMetadata.receiverKind = target.receiver.kind;
    if (target.receiver?.name)
      dynamicMetadata.receiverName = target.receiver.name;
    if (target.hints) dynamicMetadata.resolutionHints = target.hints;
    this.bufferedDynamicRefs.push({
      id: ref.id,
      metadata: JSON.stringify(dynamicMetadata),
      candidates: JSON.stringify(candidates),
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
    } = { provenance: "static", confidence: 1 },
  ): void {
    if (ref.ref_kind === "new") {
      this.bufferedEdges.push({
        source: ref.owner_id,
        target: dst,
        kind: "instantiates",
        metadata: buildEdgeMetadata(ref, "new", {
          provenance: "static",
          confidence: 1,
        }),
        line: ref.line,
        col: null,
        provenance: "static",
      });
    }
    this.bufferedEdges.push({
      source: ref.owner_id,
      target: dst,
      kind: edgeKindToDb(edgeKind),
      metadata: buildEdgeMetadata(ref, ref.ref_kind, metadata),
      line: ref.line,
      col: null,
      provenance: metadata.provenance,
    });
    this.bufferedResolvedRefIds.add(ref.id);
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
    let importedName = ref.imported_name;
    let result =
      from.format === "rust" &&
      rustImportStaysInCurrentFile(ref.ref_name, rustInlineModuleDepth)
        ? {
            status: "resolved" as const,
            fileId: from.id,
            absolutePath: from.absolutePath,
          }
        : from.format === "python" &&
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
      this.bufferedExternalRefIds.add(ref.id);
      return;
    }
    if (result.status !== "resolved") return this.failRef(ref.id, attempt);
    this.bufferedEdges.push({
      source: ref.owner_id,
      target: result.fileId,
      kind: "imports",
      metadata: buildEdgeMetadata(
        { ...ref, imported_name: importedName },
        "import",
        { provenance: "static", confidence: 1 },
      ),
      line: ref.line,
      col: null,
      provenance: "static",
    });
    this.bufferedResolvedRefIds.add(ref.id);
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
       SET status='external',
           metadata=json_set(COALESCE(metadata,'{}'),'$.lastAttempt',?)
       WHERE unresolved.status='failed'
         AND unresolved.reference_kind='imports'
         AND unresolved.language='rust'
         AND EXISTS (
           SELECT 1 FROM edges resolved
           WHERE resolved.kind='imports'
             AND resolved.source=unresolved.from_node_id
             AND resolved.line=unresolved.line
             AND (
               json_extract(unresolved.metadata,'$.localName') IS NULL
               OR json_extract(resolved.metadata,'$.localName')=
                  json_extract(unresolved.metadata,'$.localName')
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
    const projection = `SELECT id,
           from_node_id AS owner_id,
           CASE WHEN files.path IS NOT NULL THEN 1 ELSE 0 END AS owner_is_file,
           reference_name AS ref_name,
           reference_kind AS ref_kind,
           line,
           status,
           json_extract(metadata,'$.importedName') AS imported_name,
           json_extract(metadata,'$.localName') AS local_name,
           unresolved_refs.language AS source_language,
           json_extract(metadata,'$.receiverKind') AS receiver_kind,
           json_extract(metadata,'$.receiverName') AS receiver_name,
           json_extract(metadata,'$.member') AS member_name,
           json_extract(metadata,'$.resolutionHints') AS resolution_hints,
           COALESCE(json_extract(metadata,'$.lastAttempt'),0) AS last_attempt
    FROM unresolved_refs
    LEFT JOIN files ON files.path=from_node_id`;
    return this.all<RefRow>(
      `SELECT id,owner_id,owner_is_file,ref_name,ref_kind,line,status,imported_name,local_name,source_language,receiver_kind,receiver_name,member_name,resolution_hints,last_attempt
       FROM (
         SELECT unresolved_refs.*,
                row_number() OVER (PARTITION BY ref_name ORDER BY last_attempt,id) AS retry_rank
         FROM (${projection}) unresolved_refs
         WHERE status='failed' AND ?=1 AND last_attempt<? AND ${phaseCondition}
       )
       WHERE retry_rank<=?
       UNION ALL
       SELECT id,owner_id,owner_is_file,ref_name,ref_kind,line,status,imported_name,local_name,source_language,receiver_kind,receiver_name,member_name,resolution_hints,last_attempt
       FROM (${projection}) unresolved_refs
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
         SELECT e.target,h.depth+1
         FROM edges e JOIN hierarchy h ON e.source=h.id
         WHERE e.kind='extends'
           AND COALESCE(json_extract(e.metadata,'$.rel'),'extends') IN ('extends','implements')
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
         json_extract(json_extract(metadata,'$.resolutionHints'),
                      '$.functionPointerRegistration.containerType')
           AS container_type,
         json_extract(json_extract(metadata,'$.resolutionHints'),
                      '$.functionPointerRegistration.field') AS field
       FROM edges
       WHERE json_extract(metadata,'$.sourceLanguage') IN ('c','cpp')
         AND json_type(json_extract(metadata,'$.resolutionHints'),
                       '$.functionPointerRegistration')='object'`,
    ))
      this.functionPointerSlots.add(
        functionPointerSlotKey(row.container_type, row.field),
      );
  }

  private functionPointerTargets(
    ref: RefRow,
    target: ReturnType<typeof referenceTargetFromRaw>,
  ): string[] {
    if (ref.source_language !== "c" && ref.source_language !== "cpp") return [];
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
      sourceLanguage: ref.source_language,
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
        ...(ref.source_language &&
        ["java", "cpp", "typescript", "tsx"].includes(ref.source_language)
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

  private clearProjectionBuffers(): void {
    this.bufferedEdges.length = 0;
    this.bufferedDynamicRefs.length = 0;
    this.bufferedCandidates.length = 0;
    this.bufferedExternalRefIds.clear();
    this.bufferedResolvedRefIds.clear();
  }

  private aggregateBufferedEdges(): BufferedEdge[] {
    // Group edges that share the same (source, target, kind, provenance, rel)
    // so they can be merged into a single row. The unique index on
    // edges(source, target, kind, line, col) would otherwise cause
    // INSERT OR IGNORE to drop the second edge.
    const groups = new Map<string, BufferedEdge>();
    for (const edge of this.bufferedEdges) {
      const metadata = JSON.parse(edge.metadata) as Record<string, unknown>;
      const key = `${edge.source}\0${edge.target}\0${edge.kind}\0${metadata.rel ?? ""}\0${edge.provenance}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, { ...edge });
        continue;
      }
      const existingMeta = JSON.parse(existing.metadata) as Record<string, unknown>;
      // Merge metadata: take union of all fields, sum counts.
      // Fields like importedName/localName from an import_binding edge
      // are preserved even when the first edge lacked them.
      for (const [k, v] of Object.entries(metadata)) {
        if (k === "count") continue;
        if (existingMeta[k] === undefined && v !== undefined && v !== null) {
          existingMeta[k] = v;
        }
      }
      existingMeta.count =
        (Number(existingMeta.count) || 1) + (Number(metadata.count) || 1);
      existing.metadata = JSON.stringify(existingMeta);
      if (
        existing.line === null ||
        (edge.line !== null && edge.line < existing.line)
      ) {
        existing.line = edge.line;
      }
    }
    return [...groups.values()];
  }

  private flushProjectionBuffers(): void {
    if (this.bufferedEdges.length > 0) {
      const aggregated = this.aggregateBufferedEdges();
      this.database
        .prepare(
          `INSERT OR IGNORE INTO edges(source, target, kind, metadata, line, col, provenance)
           SELECT json_extract(value,'$.source'),json_extract(value,'$.target'),
                  json_extract(value,'$.kind'),json_extract(value,'$.metadata'),
                  json_extract(value,'$.line'),json_extract(value,'$.col'),
                  json_extract(value,'$.provenance')
           FROM json_each(?)`,
        )
        .run(JSON.stringify(aggregated));
    }
    if (this.bufferedDynamicRefs.length > 0) {
      const dynamicJson = JSON.stringify(this.bufferedDynamicRefs);
      this.database
        .prepare(
          `UPDATE unresolved_refs AS unresolved
           SET status='dynamic',
               candidates=json_extract(item.value,'$.candidates'),
               metadata=json_patch(COALESCE(metadata,'{}'),json_extract(item.value,'$.metadata'))
           FROM json_each(?) AS item
           WHERE unresolved.id=json_extract(item.value,'$.id')`,
        )
        .run(dynamicJson);
    }
    if (this.bufferedExternalRefIds.size > 0) {
      this.database
        .prepare(
          `UPDATE unresolved_refs SET status='external'
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .run(JSON.stringify([...this.bufferedExternalRefIds]));
    }
    if (this.bufferedResolvedRefIds.size > 0) {
      this.database
        .prepare(
          `UPDATE unresolved_refs SET status='resolved'
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .run(JSON.stringify([...this.bufferedResolvedRefIds]));
    }
    this.clearProjectionBuffers();
  }

  private failRef(id: string, _attempt: number): void {
    this.failedRefIds.add(id);
  }

  private flushFailedRefs(attempt: number): void {
    if (this.failedRefIds.size === 0) return;
    this.database
      .prepare(
        `UPDATE unresolved_refs
         SET status='failed',
             metadata=json_set(COALESCE(metadata,'{}'),'$.lastAttempt',?)
         WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .run(attempt, JSON.stringify([...this.failedRefIds]));
  }

  private nextAttempt(): number {
    this.attemptCounter++;
    return this.attemptCounter;
  }
}

function resolvePhaseCondition(phase: ResolvePhase): string {
  if (phase === "imports") return "(owner_is_file=1 OR ref_kind='imports')";
  if (phase === "inheritance")
    return "owner_is_file=0 AND ref_kind IN ('extends','implements','overrides')";
  if (phase === "instantiations") return "owner_is_file=0 AND ref_kind='new'";
  if (phase === "function_registrations")
    return "owner_is_file=0 AND json_type(resolution_hints,'$.functionPointerRegistration')='object'";
  return `owner_is_file=0
    AND ref_kind NOT IN ('imports','extends','implements','overrides','new')
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

function edgeKindToDb(kind: "CALLS" | "REFS" | "INHERITS"): string {
  if (kind === "CALLS") return "calls";
  if (kind === "REFS") return "references";
  return "extends";
}

function buildEdgeMetadata(
  ref: RefRow,
  rel: string,
  metadata: {
    provenance: "static" | "heuristic";
    confidence: number;
    evidence?: string;
  },
): string {
  const payload: Record<string, unknown> = {};
  payload.rel = rel;
  payload.count = 1;
  payload.refName = ref.ref_name;
  if (ref.source_language) payload.sourceLanguage = ref.source_language;
  if (ref.imported_name) payload.importedName = ref.imported_name;
  if (ref.local_name) payload.localName = ref.local_name;
  if (ref.receiver_kind) payload.receiverKind = ref.receiver_kind;
  if (ref.receiver_name) payload.receiverName = ref.receiver_name;
  if (ref.member_name) payload.member = ref.member_name;
  if (ref.resolution_hints) payload.resolutionHints = ref.resolution_hints;
  payload.confidence = metadata.confidence;
  if (metadata.evidence) payload.evidence = metadata.evidence;
  return JSON.stringify(payload);
}

function refKindToEdgeKind(kind: string): "CALLS" | "REFS" | "INHERITS" {
  if (kind === "call" || kind === "calls") return "CALLS";
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
