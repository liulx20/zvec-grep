import { makeEntityId } from "../ids.js";
import type { GraphRefKind, NameEdge, WalkEdge } from "./types.js";

/**
 * Mutable state carried through a single AST walk.
 *
 * Mirrors the three-segment collection design validated against codegraph:
 *
 * 1. `scopeStack` — entity IDs on the containment path. A new entity pushes
 *    its ID; `contains` edges are emitted from the stack top, so both
 *    endpoints are position-known at walk time (no name lookup needed).
 * 2. `symbolTable` — name → entity IDs, registered as entities are produced.
 *    The post-walk partition consults it to resolve in-file references
 *    (forward references included, because partition runs after the walk).
 * 3. `resolvedEdges` / `nameEdges` — the two output buffers. Position-based
 *    edges (contains) go straight to `resolvedEdges`; name-based references
 *    (calls/imports/extends/implements) are buffered in `nameEdges` because
 *    their targets are unknown during the walk.
 *
 * The future walker integration passes a `WalkContext` into `walkCodeNode`;
 * entity ID assignment moves into the walk (via {@link nextEntityId}) so that
 * `contains` edges can reference freshly created entities.
 */
export class WalkContext {
  readonly resolvedEdges: WalkEdge[] = [];
  readonly nameEdges: NameEdge[] = [];
  private readonly scopeStack: string[] = [];
  private readonly symbolTable = new Map<string, string[]>();
  private readonly seenNameEdges = new Set<string>();
  private entityIdCounter = 0;

  constructor(readonly fileId: string) {}

  /** Allocates the next position-stable entity ID for this file. */
  nextEntityId(): string {
    return makeEntityId(this.fileId, this.entityIdCounter++);
  }

  /** Current containing entity ID, or undefined at file top level. */
  currentScopeId(): string | undefined {
    return this.scopeStack[this.scopeStack.length - 1];
  }

  /** Enters an entity's scope; must be paired with {@link popScope}. */
  pushScope(entityId: string): void {
    this.scopeStack.push(entityId);
  }

  /** Leaves the innermost entity scope. */
  popScope(): void {
    this.scopeStack.pop();
  }

  /** Registers a symbol so partition can resolve in-file references to it. */
  registerSymbol(name: string | undefined, entityId: string): void {
    if (!name) {
      return;
    }
    const ids = this.symbolTable.get(name);
    if (ids) {
      ids.push(entityId);
    } else {
      this.symbolTable.set(name, [entityId]);
    }
  }

  /** Entity IDs in this file that declare `name`, if any. */
  lookupSymbol(name: string): readonly string[] | undefined {
    return this.symbolTable.get(name);
  }

  /** True when exactly one entity in this file declares `name`. */
  isUniqueSymbol(name: string): boolean {
    return this.symbolTable.get(name)?.length === 1;
  }

  /** Emits a `contains` edge from the current (or given) parent scope. */
  addContainsEdge(
    targetId: string,
    position: { line: number; column: number },
    sourceId?: string,
  ): void {
    const source = sourceId ?? this.currentScopeId();
    if (!source) {
      // Top-level entities are contained by the file node; the persistence
      // layer links them via the file ID when the file node is materialized.
      return;
    }
    this.resolvedEdges.push({
      kind: "contains",
      sourceId: source,
      targetId,
      line: position.line,
      column: position.column,
    });
  }

  /**
   * Buffers a name-based reference. Duplicate references (same owner, kind,
   * and name — e.g. a callee invoked in a loop) collapse to the first
   * occurrence; per-site evidence can be accumulated later via metadata.
   */
  addNameEdge(edge: NameEdge): void {
    const key = `${edge.refKind}\0${edge.ownerId}\0${edge.refName}`;
    if (this.seenNameEdges.has(key)) {
      return;
    }
    this.seenNameEdges.add(key);
    this.nameEdges.push(edge);
  }

  /** Convenience wrapper for buffered call references. */
  addCallEdge(
    ownerId: string,
    refName: string,
    options: {
      receiverName?: string;
      rawText?: string;
      arity?: number;
      line: number;
      column: number;
    },
  ): void {
    this.addNameEdge({
      refKind: "calls",
      ownerId,
      refName,
      ...options,
    });
  }

  /** Convenience wrapper for buffered import references. */
  addImportEdge(
    ownerId: string,
    modulePath: string,
    options: {
      rawText?: string;
      line: number;
      column: number;
    },
  ): void {
    this.addNameEdge({
      refKind: "imports",
      ownerId,
      refName: modulePath,
      ...options,
    });
  }

  /** Convenience wrapper for buffered extends/implements references. */
  addInheritanceEdge(
    refKind: Extract<GraphRefKind, "extends" | "implements">,
    ownerId: string,
    refName: string,
    options: {
      rawText?: string;
      line: number;
      column: number;
    },
  ): void {
    this.addNameEdge({
      refKind,
      ownerId,
      refName,
      ...options,
    });
  }
}
