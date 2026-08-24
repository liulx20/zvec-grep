/** Minimal builtin / common third-party names dropped at resolve time. */

const JS_BUILTINS = new Set([
  "Array",
  "Boolean",
  "Date",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "Reflect",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "WeakMap",
  "WeakSet",
  "console",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "eval",
  "fetch",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "require",
  "module",
  "exports",
  "process",
  "Buffer",
  "undefined",
  "NaN",
  "Infinity",
]);

const PYTHON_BUILTINS = new Set([
  "abs",
  "all",
  "any",
  "dict",
  "enumerate",
  "filter",
  "float",
  "format",
  "getattr",
  "hasattr",
  "int",
  "isinstance",
  "len",
  "list",
  "map",
  "max",
  "min",
  "open",
  "print",
  "range",
  "set",
  "sorted",
  "str",
  "sum",
  "super",
  "tuple",
  "type",
  "zip",
]);

const CPP_BUILTINS = new Set([
  "alignof",
  "const_cast",
  "dynamic_cast",
  "reinterpret_cast",
  "sizeof",
  "static_cast",
  "typeid",
]);

const COMMON_PACKAGES = new Set([
  "lodash",
  "react",
  "react-dom",
  "vue",
  "angular",
  "express",
  "fs",
  "path",
  "os",
  "util",
  "http",
  "https",
  "url",
  "crypto",
  "assert",
  "child_process",
  "stream",
  "events",
  "buffer",
  "node:fs",
  "node:path",
  "node:os",
  "node:util",
  "node:http",
  "node:crypto",
]);

const BUILTIN_RECEIVER_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  javascript: new Set([
    "array",
    "readonlyarray",
    "map",
    "readonlymap",
    "weakmap",
    "set",
    "readonlyset",
    "weakset",
    "string",
    "number",
    "boolean",
    "promise",
    "date",
    "regexp",
    "json",
    "uint8array",
    "int8array",
    "uint16array",
    "int16array",
    "uint32array",
    "int32array",
    "float32array",
    "float64array",
    "databasesync",
    "nodedatabasesync",
    "statementsync",
  ]),
  python: new Set([
    "list",
    "dict",
    "tuple",
    "set",
    "frozenset",
    "str",
    "bytes",
    "bytearray",
    "memoryview",
    "range",
    "deque",
    "counter",
    "defaultdict",
  ]),
  java: new Set([
    "string",
    "stringbuilder",
    "stringbuffer",
    "list",
    "arraylist",
    "linkedlist",
    "collection",
    "collections",
    "map",
    "hashmap",
    "linkedhashmap",
    "treemap",
    "set",
    "hashset",
    "linkedhashset",
    "treeset",
    "optional",
    "stream",
    "iterator",
    "iterable",
    "completablefuture",
  ]),
  go: new Set(["string", "error"]),
  rust: new Set([
    "vec",
    "vecdeque",
    "hashmap",
    "btreemap",
    "hashset",
    "btreeset",
    "option",
    "result",
    "string",
    "str",
    "box",
    "rc",
    "arc",
  ]),
  cpp: new Set([
    "atomic",
    "atomic_flag",
    "vector",
    "deque",
    "list",
    "map",
    "multimap",
    "unordered_map",
    "set",
    "multiset",
    "unordered_set",
    "string",
    "string_view",
    "optional",
    "variant",
    "tuple",
    "array",
    "unique_ptr",
    "shared_ptr",
    "weak_ptr",
    "thread",
    "jthread",
    "mutex",
    "recursive_mutex",
    "shared_mutex",
    "timed_mutex",
    "unique_lock",
    "shared_lock",
    "lock_guard",
    "scoped_lock",
    "condition_variable",
    "future",
    "shared_future",
    "promise",
    "packaged_task",
    "function",
    "span",
    "queue",
    "priority_queue",
    "stack",
    "bitset",
    "regex",
    "path",
  ]),
};

export function isExternalRefName(refName: string, language?: string): boolean {
  const bare = bareName(refName);
  if (!bare) {
    return false;
  }
  const root = refName.split(/[./]/)[0] ?? bare;
  const builtins =
    language === "python"
      ? PYTHON_BUILTINS
      : language === "cpp"
        ? CPP_BUILTINS
        : language &&
            !["javascript", "jsx", "typescript", "tsx"].includes(language)
          ? new Set<string>()
          : JS_BUILTINS;
  if (builtins.has(bare) || builtins.has(root)) {
    return true;
  }
  if (
    (language === "c" || language === "cpp") &&
    /^[A-Z_][A-Z0-9_]*$/.test(bare)
  )
    return true;
  return COMMON_PACKAGES.has(root) || COMMON_PACKAGES.has(bare);
}

export function isExternalReceiverType(
  receiverType: string,
  language?: string,
): boolean {
  const family = receiverLanguageFamily(language);
  if (!family) return false;
  const normalized = normalizeReceiverType(receiverType);
  return (
    normalized.length > 0 && BUILTIN_RECEIVER_TYPES[family]!.has(normalized)
  );
}

export function isExternalReceiverName(
  receiverName: string,
  language?: string,
): boolean {
  if (language !== "cpp") return false;
  const normalized = receiverName.replace(/\s+/g, "").replace(/^\(+/, "");
  return (
    normalized === "std" ||
    normalized.startsWith("std::") ||
    normalized.startsWith("std.")
  );
}

function receiverLanguageFamily(language?: string): string | undefined {
  if (["javascript", "jsx", "typescript", "tsx"].includes(language ?? ""))
    return "javascript";
  if (["python", "java", "go", "rust", "cpp"].includes(language ?? ""))
    return language;
  return undefined;
}

function normalizeReceiverType(value: string): string {
  const withoutNamespace = value
    .trim()
    .replace(/^(?:java\.util\.|java\.lang\.|std::)/, "")
    .replace(/<.*$/, "")
    .replace(/\[.*\]$/, "")
    .replace(/\[\]$/, "array")
    .replace(/[&*?]/g, "")
    .trim();
  return withoutNamespace.split(/[.\s]/).pop()?.toLowerCase() ?? "";
}

export function bareName(refName: string): string {
  const trimmed = refName.trim();
  if (!trimmed) {
    return "";
  }
  const parts = trimmed.split(/::|->|\./);
  return parts[parts.length - 1] ?? trimmed;
}
