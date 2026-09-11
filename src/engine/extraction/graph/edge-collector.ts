import type { TSNode } from "../code/tree-sitter/nodes.js";
import {
  CALLEE_FIELDS,
  COMMON_CALL_TYPES,
  importVocabularyFor,
  interfacesFieldsFor,
  superclassFieldsFor,
} from "./languages.js";
import type { WalkContext } from "./walk-context.js";

/**
 * Walk-time collectors for name-based graph references.
 *
 * These run inside entity bodies — the region the symbol walker deliberately
 * does not descend into — so call sites are attributed to their innermost
 * owning entity without a second full parse.
 */

const MAX_CALLEE_TEXT_CHARS = 180;
const SEPARATOR_PATTERN = /[.:]/;

/** Splits a callee expression into its receiver and short member name. */
export function splitCalleeName(
  text: string,
): { refName: string; receiverName?: string } {
  const cleaned = text.replace(/\s+/g, " ").trim().replace(/^new\s+/, "");
  const lastSeparator = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf(":"));
  if (lastSeparator <= 0 || lastSeparator >= cleaned.length - 1) {
    return { refName: cleaned };
  }
  return {
    refName: cleaned.slice(lastSeparator + 1),
    receiverName: cleaned.slice(0, lastSeparator).replace(/:+$/, ""),
  };
}

/** True when the node is a call-ish expression per the shared vocabulary. */
export function isCallNode(node: TSNode): boolean {
  return COMMON_CALL_TYPES.has(node.type);
}

/** Extracts the callee expression text for a call node, if recoverable. */
export function calleeTextOf(node: TSNode): string | undefined {
  for (const field of CALLEE_FIELDS) {
    const target = node.childForFieldName(field);
    if (target) {
      return target.text;
    }
  }
  return node.namedChildren[0]?.text;
}

/** Counts call arguments when the grammar exposes an `arguments` field. */
export function callArityOf(node: TSNode): number | undefined {
  const args =
    node.childForFieldName("arguments") ?? node.childForFieldName("argument_list");
  if (!args) {
    return undefined;
  }
  const list = args.namedChildren.filter(
    (child: TSNode) => child.type !== "," && !child.type.endsWith("_comment"),
  );
  return list.length;
}

/**
 * Scans an entity body for call sites and buffers one `calls` reference per
 * distinct callee. Nested call expressions inside an argument list are
 * skipped: the inner call is collected on its own visit when the walker
 * reaches it as a sibling — keeping attribution shallow matches how the
 * outline collector treats nested calls and avoids double-counting chains.
 */
export function scanCallEdges(entityNode: TSNode, ownerId: string, ctx: WalkContext): void {
  const visit = (node: TSNode): void => {
    if (isCallNode(node)) {
      const text = calleeTextOf(node);
      if (text && text.length <= MAX_CALLEE_TEXT_CHARS && isIdentifierLike(text)) {
        const { refName, receiverName } = splitCalleeName(text);
        ctx.addCallEdge(ownerId, refName, {
          receiverName,
          rawText: text,
          arity: callArityOf(node),
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      // Do not descend into the call's own arguments here; other collectors
      // and future walk integration revisit that region.
      return;
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };
  visit(entityNode);
}

/** Normalizes an import module path for buffering (strips quotes/brackets). */
export function normalizeModulePath(text: string): string {
  return text
    .trim()
    .replace(/^[<"'`]+/, "")
    .replace(/[>"'`]+$/, "")
    .replace(/;+\s*$/, "")
    .trim();
}

/** Extracts the module path from an import node via grammar fields or text. */
export function modulePathOf(node: TSNode, format: string): string | undefined {
  const vocabulary = importVocabularyFor(format);
  if (vocabulary) {
    for (const field of vocabulary.moduleFields) {
      const target = node.childForFieldName(field);
      if (target) {
        const path = normalizeModulePath(target.text);
        if (path.length > 0) {
          return path;
        }
      }
    }
  }
  // Text fallback (Rust `use a::b;`, Go grouped imports, C includes whose
  // path field is nested in a string literal node).
  const text = normalizeModulePath(node.text);
  if (format === "rust") {
    const stripped = text
      .replace(/^use\s+/i, "")
      .replace(/\s+as\s+\w+$/i, "")
      .replace(/[{}]|\s+/g, "")
      .replace(/;$/, "");
    return stripped.length > 0 ? stripped : undefined;
  }
  if (text.length > 0 && !text.includes("\n")) {
    return text;
  }
  return undefined;
}

/**
 * Buffers an `imports` reference for an import declaration node. The owner
 * is the file ID: imports belong to the file scope, not to any entity.
 */
export function collectImportEdge(
  node: TSNode,
  format: string,
  ctx: WalkContext,
): void {
  const path = modulePathOf(node, format);
  if (!path) {
    return;
  }
  ctx.addImportEdge(ctx.fileId, path, {
    rawText: node.text,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/** True when the node type belongs to the language's import vocabulary. */
export function isImportNode(node: TSNode, format: string): boolean {
  return importVocabularyFor(format)?.importTypes.has(node.type) ?? false;
}

/**
 * Buffers `extends`/`implements` references for a class-like entity node,
 * reading the per-language grammar fields.
 */
export function collectInheritanceEdges(
  entityNode: TSNode,
  format: string,
  ownerId: string,
  ctx: WalkContext,
): void {
  for (const field of superclassFieldsFor(format)) {
    const sup = entityNode.childForFieldName(field);
    if (sup) {
      const names = typeNamesFromClause(sup);
      for (const name of names) {
        ctx.addInheritanceEdge("extends", ownerId, name, {
          rawText: sup.text,
          line: sup.startPosition.row + 1,
          column: sup.startPosition.column,
        });
      }
    }
  }
  for (const field of interfacesFieldsFor(format)) {
    const interfaces = entityNode.childForFieldName(field);
    if (interfaces) {
      for (const name of typeNamesFromClause(interfaces)) {
        ctx.addInheritanceEdge("implements", ownerId, name, {
          rawText: interfaces.text,
          line: interfaces.startPosition.row + 1,
          column: interfaces.startPosition.column,
        });
      }
    }
  }
}

/**
 * Splits an inheritance clause into type names. Handles the common shapes:
 * a single type node, a comma-separated list, and C++ base specifiers with
 * access labels (`public Base`).
 */
function typeNamesFromClause(clause: TSNode): string[] {
  const names: string[] = [];
  const visit = (node: TSNode): void => {
    const text = node.text.replace(/\s+/g, " ").trim();
    if (text.length === 0 || text.length > MAX_CALLEE_TEXT_CHARS) {
      return;
    }
    if (node.namedChildCount === 0 && isIdentifierLike(text)) {
      names.push(text);
      return;
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };
  visit(clause);
  return names;
}

function isIdentifierLike(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$.:]*$/.test(value) && !SEPARATOR_PATTERN.test(value.slice(0, 1));
}
