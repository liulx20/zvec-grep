import type { SQLOutputValue } from "node:sqlite";
import type { FileEdge, GraphEdgeKind } from "../../types.js";
import type { GraphStorage, NeighborhoodOptions } from "../storage.js";
import type { GraphDatabase } from "./database.js";

const EDGE_KINDS: readonly GraphEdgeKind[] = [
  "contains",
  "calls",
  "imports",
  "extends",
  "implements",
];

type EdgeQuery = {
  id: string;
  scope: "source" | "target" | "both" | "file_id";
  kinds?: readonly GraphEdgeKind[];
};

/** One-hop relationship reads; node metadata stays in zvec. */
export class SqliteGraphReader implements Pick<
  GraphStorage,
  | "neighborhood"
  | "getCallers"
  | "getCallees"
  | "getImports"
  | "getInheritance"
  | "getSubclasses"
  | "getImplementations"
> {
  constructor(private readonly database: GraphDatabase) {}

  async neighborhood(options: NeighborhoodOptions): Promise<FileEdge[]> {
    const direction = options.direction ?? "both";
    if (!["in", "out", "both"].includes(direction)) {
      throw new Error("Graph direction must be in, out or both");
    }
    return this.readAll({
      ...options,
      scope:
        direction === "in" ? "target" : direction === "out" ? "source" : "both",
    });
  }

  async getCallers(targetId: string): Promise<FileEdge[]> {
    return this.readAll({ id: targetId, scope: "target", kinds: ["calls"] });
  }

  async getCallees(sourceId: string): Promise<FileEdge[]> {
    return this.readAll({ id: sourceId, scope: "source", kinds: ["calls"] });
  }

  async getImports(fileId: string): Promise<FileEdge[]> {
    return this.readAll({ id: fileId, scope: "file_id", kinds: ["imports"] });
  }

  async getInheritance(typeId: string): Promise<FileEdge[]> {
    return this.readAll({ id: typeId, scope: "source", kinds: ["extends"] });
  }

  async getSubclasses(typeId: string): Promise<FileEdge[]> {
    return this.readAll({ id: typeId, scope: "target", kinds: ["extends"] });
  }

  async getImplementations(typeId: string): Promise<FileEdge[]> {
    return this.readAll({ id: typeId, scope: "target", kinds: ["implements"] });
  }

  private readAll(query: EdgeQuery): FileEdge[] {
    const db = this.database.connection;
    if (query.id.trim().length === 0) {
      throw new Error("Graph endpoint or file ID must not be empty");
    }
    const kinds = [...new Set(query.kinds ?? EDGE_KINDS)].sort();
    if (kinds.some((kind) => !EDGE_KINDS.includes(kind))) {
      throw new Error("Unknown graph edge kind");
    }
    if (kinds.length === 0) {
      return [];
    }
    const endpoint =
      query.scope === "both"
        ? "(source = ? OR target = ?)"
        : `${query.scope} = ?`;
    const endpointValues =
      query.scope === "both" ? [query.id, query.id] : [query.id];
    const rows = db
      .prepare(
        `
      SELECT id, kind, source, target, line, column, provenance, metadata
      FROM edges
      WHERE ${endpoint} AND kind IN (${kinds.map(() => "?").join(", ")})
      ORDER BY id ASC
    `,
      )
      .all(...endpointValues, ...kinds);
    return rows.map(rowToEdge);
  }
}

function rowToEdge(row: Record<string, SQLOutputValue>): FileEdge {
  // Column types and JSON object shape are enforced by the STRICT schema.
  return {
    kind: row.kind as FileEdge["kind"],
    source: row.source as string,
    target: row.target as string,
    line: row.line as number | null,
    column: row.column as number | null,
    provenance: row.provenance as FileEdge["provenance"],
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
  };
}
