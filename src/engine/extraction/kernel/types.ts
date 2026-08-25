/**
 * CodeGraph kernel wire types — mirror of codegraph/src/types.ts
 * The ARRAY ORDER is part of the native kernel ABI; append only, never reorder.
 */

export const NODE_KINDS = [
  "file",
  "module",
  "class",
  "struct",
  "interface",
  "trait",
  "protocol",
  "function",
  "method",
  "property",
  "field",
  "variable",
  "constant",
  "enum",
  "enum_member",
  "type_alias",
  "namespace",
  "parameter",
  "import",
  "export",
  "route",
  "component",
  "union",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "contains",
  "calls",
  "imports",
  "exports",
  "extends",
  "implements",
  "references",
  "type_of",
  "returns",
  "instantiates",
  "overrides",
  "decorates",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

export type ReferenceKind = EdgeKind | "function_ref";

export type Node = {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  updatedAt: number;
  docstring?: string;
  signature?: string;
  visibility?: "public" | "private" | "protected" | "internal";
  isExported?: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];
  typeParameters?: string[];
  returnType?: string;
};

export type Edge = {
  source: string;
  target: string;
  kind: EdgeKind;
  line?: number;
  col?: number;
  provenance?: "tree-sitter" | "scip" | "heuristic";
  metadata?: Record<string, unknown>;
};

export type UnresolvedReference = {
  fromNodeId: string;
  referenceName: string;
  referenceKind: ReferenceKind;
  line: number;
  col: number;
  filePath?: string;
  language?: string;
  candidates?: string[];
};

export type ExtractionError = {
  message: string;
  line?: number;
  col?: number;
};

export type ExtractionResult = {
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  errors: ExtractionError[];
  durationMs: number;
};

export interface KernelBuffers {
  meta: Buffer;
  nodes: Buffer;
  edges: Buffer;
  refs: Buffer;
  arena: Buffer;
}

export interface KernelContractInfo {
  abiVersion: number;
  kernelVersion: string;
  nodeKinds: string[];
  edgeKinds: string[];
  languages: string[];
}

export interface KernelModule {
  extractFile(filePath: string, content: string, language: string): KernelBuffers;
  contractInfo(): KernelContractInfo;
}
