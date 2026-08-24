import { readFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import type { FileInfo } from "../types.js";

const CPP_HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".hxx"]);
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const CPP_NON_TYPES = new Set([
  "auto",
  "break",
  "case",
  "co_return",
  "continue",
  "else",
  "for",
  "if",
  "return",
  "static_assert",
  "switch",
  "throw",
  "typedef",
  "using",
  "while",
]);

export type CppReceiverTypeEvidence = {
  type: string;
  declarationFileId: string;
  source: "text_fallback" | "cross_file_text_fallback";
  confidence: number;
};

/** Invocation-local source cache used by C++ receiver inference. */
export class CppReceiverTypeInference {
  private readonly linesByPath = new Map<string, readonly string[] | null>();
  private readonly filesById = new Map<string, FileInfo>();
  private readonly headersByStem = new Map<string, FileInfo[]>();
  private readonly declarationsByFile = new Map<
    string,
    ReadonlyMap<string, readonly { line: number; type: string }[]>
  >();
  private readonly headerTypes = new Map<
    string,
    CppReceiverTypeEvidence | null
  >();

  constructor(files: readonly FileInfo[] = []) {
    for (const file of files) {
      this.filesById.set(file.id, file);
      if (!CPP_HEADER_EXTENSIONS.has(extname(file.relativePath).toLowerCase()))
        continue;
      const stem = basename(file.relativePath, extname(file.relativePath));
      const headers = this.headersByStem.get(stem) ?? [];
      headers.push(file);
      this.headersByStem.set(stem, headers);
    }
  }

  infer(
    receiverName: string,
    callLine: number,
    sourceFileId: string,
  ): string | undefined {
    return this.inferWithEvidence(receiverName, callLine, sourceFileId)?.type;
  }

  inferWithEvidence(
    receiverName: string,
    callLine: number,
    sourceFileId: string,
  ): CppReceiverTypeEvidence | undefined {
    const source = this.filesById.get(sourceFileId);
    if (!source || source.format !== "cpp") return undefined;
    const receiver = simpleReceiver(receiverName);
    if (!receiver) return undefined;

    const local = this.lines(source);
    const localType = local
      ? this.inferLocal(source, local, receiver, Math.max(0, callLine - 1))
      : undefined;
    if (localType)
      return {
        type: localType,
        declarationFileId: sourceFileId,
        source: "text_fallback",
        confidence: 0.4,
      };

    const headerKey = `${source.id}\0${receiver}`;
    const cachedHeader = this.headerTypes.get(headerKey);
    if (cachedHeader !== undefined) {
      return cachedHeader ?? undefined;
    }
    for (const header of this.headerCandidates(source)) {
      const lines = this.lines(header);
      if (!lines) continue;
      const type = this.inferLocal(header, lines, receiver, lines.length - 1);
      if (type) {
        const evidence: CppReceiverTypeEvidence = {
          type,
          declarationFileId: header.id,
          source: "cross_file_text_fallback",
          confidence: 0.3,
        };
        this.headerTypes.set(headerKey, evidence);
        return evidence;
      }
    }
    this.headerTypes.set(headerKey, null);
    return undefined;
  }

  private inferLocal(
    file: FileInfo,
    lines: readonly string[],
    receiver: string,
    start: number,
  ): string | undefined {
    let byReceiver = this.declarationsByFile.get(file.id);
    if (!byReceiver) {
      byReceiver = declarationTypes(lines);
      this.declarationsByFile.set(file.id, byReceiver);
    }
    const declarations = byReceiver.get(receiver) ?? [];
    for (let index = declarations.length - 1; index >= 0; index--) {
      const declaration = declarations[index]!;
      if (declaration.line <= start) return declaration.type;
    }
    return undefined;
  }

  private headerCandidates(source: FileInfo): FileInfo[] {
    const stem = basename(source.relativePath, extname(source.relativePath));
    const sourceDir = dirname(source.relativePath);
    return [...(this.headersByStem.get(stem) ?? [])].sort((left, right) => {
      const leftSameDir = dirname(left.relativePath) === sourceDir ? 0 : 1;
      const rightSameDir = dirname(right.relativePath) === sourceDir ? 0 : 1;
      if (leftSameDir !== rightSameDir) return leftSameDir - rightSameDir;
      return (
        suffixDistance(source.relativePath, left.relativePath) -
        suffixDistance(source.relativePath, right.relativePath)
      );
    });
  }

  private lines(file: FileInfo): readonly string[] | null {
    const cached = this.linesByPath.get(file.absolutePath);
    if (cached !== undefined) return cached;
    if (file.sizeBytes > MAX_SOURCE_BYTES) {
      this.linesByPath.set(file.absolutePath, null);
      return null;
    }
    try {
      const lines = readFileSync(file.absolutePath, "utf8").split(/\r?\n/);
      this.linesByPath.set(file.absolutePath, lines);
      return lines;
    } catch {
      this.linesByPath.set(file.absolutePath, null);
      return null;
    }
  }
}

function simpleReceiver(value: string): string | undefined {
  const normalized = value
    .replace(/^(?:this|self|cls)(?:\.|->)/, "")
    .replace(/->/g, ".");
  const indexed = normalized.match(/^([A-Za-z_]\w*)\s*\[[^\]]+\]$/);
  if (indexed) return `${indexed[1]!}.$element`;
  const accessor = normalized.match(
    /^([A-Za-z_]\w*)\.(?:at|front|back)\s*\([^)]*\)$/,
  );
  if (accessor) return `${accessor[1]!}.$element`;
  return /^[A-Za-z_]\w*$/.test(normalized) ? normalized : undefined;
}

function declarationTypes(
  lines: readonly string[],
): ReadonlyMap<string, readonly { line: number; type: string }[]> {
  const result = new Map<string, { line: number; type: string }[]>();
  const declaration = new RegExp(
    `([A-Za-z_][\\w:]*(?:\\s*<[^;=(){}]+>)?(?:\\s*[*&]+)?)\\s+([A-Za-z_]\\w*)\\s*(?=[;=,)\\[{(]|$)`,
    "g",
  );
  for (let index = 0; index < lines.length; index++) {
    const line = stripCppComment(lines[index] ?? "");
    for (const match of line.matchAll(declaration)) {
      const type = normalizeCppType(match[1] ?? "");
      const receiver = match[2];
      if (!receiver || !type || CPP_NON_TYPES.has(type)) continue;
      const declarations = result.get(receiver) ?? [];
      declarations.push({ line: index, type });
      result.set(receiver, declarations);
      const elementType = cppCollectionElementType(match[1] ?? "");
      if (elementType) {
        const elements = result.get(`${receiver}.$element`) ?? [];
        elements.push({ line: index, type: elementType });
        result.set(`${receiver}.$element`, elements);
      }
    }
  }
  return result;
}

function cppCollectionElementType(value: string): string | undefined {
  const outer = value.match(/([A-Za-z_]\w*)\s*</)?.[1];
  if (
    !outer ||
    !new Set([
      "array",
      "deque",
      "list",
      "map",
      "set",
      "unordered_map",
      "unordered_set",
      "vector",
    ]).has(outer)
  )
    return undefined;
  const identifiers = [...value.matchAll(/[A-Za-z_]\w*/g)].map(
    (match) => match[0],
  );
  const wrappers = new Set([
    outer,
    "std",
    "unique_ptr",
    "shared_ptr",
    "weak_ptr",
    "optional",
    "const",
  ]);
  const leaf = identifiers.filter((name) => !wrappers.has(name)).at(-1);
  return leaf && /^[A-Za-z_]\w*$/.test(leaf) ? leaf : undefined;
}

function normalizeCppType(value: string): string | undefined {
  const wrapped = value.match(
    /(?:shared_ptr|unique_ptr|weak_ptr|optional)\s*<\s*([A-Za-z_]\w*(?:::\w+)*)/,
  );
  const normalized = (wrapped?.[1] ?? value)
    .replace(/\b(?:const|volatile|mutable|typename|class|struct)\b/g, " ")
    .replace(/[&*]+/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const last = normalized.split(/::/).filter(Boolean).at(-1)?.trim();
  return last && /^[A-Za-z_]\w*$/.test(last) ? last : undefined;
}

function suffixDistance(left: string, right: string): number {
  const a = dirname(left).split("/").reverse();
  const b = dirname(right).split("/").reverse();
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared])
    shared++;
  return -shared;
}

function stripCppComment(value: string): string {
  return value.replace(/\/\/.*$/, "");
}
