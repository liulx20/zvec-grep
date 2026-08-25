import { resolveAdapter } from "./adapter.js";
import type { TextSource } from "../source.js";
import { hasGrammar } from "./tree-sitter/grammar.js";
import type { TSNode } from "./tree-sitter/nodes.js";
import { withParser } from "./tree-sitter/parser.js";

export type ImportSpec = {
  spec: string;
  line: number;
  bindings?: readonly ImportBinding[];
  /** Number of enclosing inline Rust `mod { ... }` scopes. */
  rustInlineModuleDepth?: number;
  /** true when #include <...> — always treated as external in v1 */
  systemInclude?: boolean;
};

export type ImportBinding = { imported: string; local: string };

const IMPORT_NODE_TYPES = new Set([
  "import_statement",
  "import_from_statement",
  "export_statement",
  "preproc_include",
  "import_declaration",
  "mod_item",
  "use_declaration",
]);

/**
 * Collect import/include module specs from a source file (inside withParser).
 * Drops obvious externals early; path resolution happens in resolvePending.
 */
export async function collectImportSpecs(
  source: TextSource,
): Promise<readonly ImportSpec[]> {
  if (source.file.kind !== "code" || !hasGrammar(source.file.format)) {
    return [];
  }
  if (!resolveAdapter(source.file.format)) {
    return [];
  }

  const language = source.file.format;
  const collected = await withParser(source.text, language, (tree) => {
    return collectImportSpecsFromNode(tree.rootNode, language);
  });

  return collected ?? [];
}

export function collectImportSpecsFromNode(
  root: TSNode,
  language: string,
): ImportSpec[] {
  const out: ImportSpec[] = [];
  const seen = new Set<string>();
  const visit = (node: TSNode): void => {
    if (
      IMPORT_NODE_TYPES.has(node.type) ||
      (isJavaScriptFamily(language) && node.type === "call_expression")
    ) {
      for (const spec of extractSpecsFromNode(node, language)) {
        if (spec.systemInclude) continue;
        const key = importSpecKey(spec);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(spec);
        }
      }
    }
    for (const child of node.namedChildren ?? []) visit(child);
  };
  visit(root);
  if (language === "python") {
    for (const candidate of pythonQualifiedModuleCandidates(root, out)) {
      const key = importSpecKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
  }
  return out;
}

function importSpecKey(spec: ImportSpec): string {
  const bindings = [...(spec.bindings ?? [])]
    .map((binding) => `${binding.imported}\0${binding.local}`)
    .sort()
    .join("\0");
  return `${spec.spec}\0${spec.line}\0${bindings}`;
}

function pythonQualifiedModuleCandidates(
  root: TSNode,
  imports: readonly ImportSpec[],
): ImportSpec[] {
  const qualifiedReceivers = new Set<string>();
  const visit = (node: TSNode): void => {
    if (node.type === "attribute") {
      const object = node.childForFieldName("object") ?? node.namedChildren[0];
      if (object?.type === "identifier") qualifiedReceivers.add(object.text);
    }
    for (const child of node.namedChildren ?? []) visit(child);
  };
  visit(root);

  return imports.flatMap((item) =>
    (item.bindings ?? []).flatMap((binding) => {
      if (binding.imported === "*" || !qualifiedReceivers.has(binding.local))
        return [];
      const separator = item.spec.endsWith(".") ? "" : ".";
      return [
        {
          spec: `${item.spec}${separator}${binding.imported}`,
          line: item.line,
          bindings: [{ imported: "*", local: binding.local }],
        },
      ];
    }),
  );
}

function extractSpecsFromNode(node: TSNode, language: string): ImportSpec[] {
  const line = node.startPosition.row + 1;

  if (language === "rust" && node.type === "mod_item") {
    // Inline modules own a body and do not refer to another source file.
    if (node.namedChildren.some((child) => child.type === "declaration_list"))
      return [];
    const name = node.childForFieldName("name")?.text.trim();
    return name
      ? [
          {
            spec: `./${name}`,
            line,
            bindings: [{ imported: "*", local: name }],
          },
        ]
      : [];
  }

  if (isJavaScriptFamily(language) && node.type === "call_expression") {
    const required = commonJsRequire(node, line);
    return required ? [required] : [];
  }

  if (language === "rust" && node.type === "use_declaration") {
    const rustInlineModuleDepth = enclosingInlineRustModuleDepth(node);
    return rustUseSpecs(node, line).map((spec) => ({
      ...spec,
      ...(rustInlineModuleDepth > 0 ? { rustInlineModuleDepth } : {}),
    }));
  }

  if (node.type === "preproc_include") {
    const text = node.text.trim();
    const angle = text.match(/#\s*include\s*<([^>]+)>/);
    if (angle?.[1]) {
      return [{ spec: angle[1], line, systemInclude: true }];
    }
    const quoted = text.match(/#\s*include\s*"([^"]+)"/);
    if (quoted?.[1]) {
      return [{ spec: quoted[1], line }];
    }
    return [];
  }

  if (language === "go" && node.type === "import_declaration") {
    return descendantsOfType(node, "import_spec").flatMap((specifier) => {
      const pathNode =
        specifier.childForFieldName("path") ??
        specifier.namedChildren.find(
          (child) => child.type === "interpreted_string_literal",
        );
      const spec = pathNode ? stripQuotes(pathNode.text) : "";
      if (!spec) return [];
      const aliasNode =
        specifier.childForFieldName("name") ??
        specifier.namedChildren.find(
          (child) =>
            child.type === "package_identifier" || child.type === "identifier",
        );
      const explicitAlias = aliasNode?.text.trim();
      const local = explicitAlias || defaultGoPackageName(spec);
      return [
        {
          spec,
          line: specifier.startPosition.row + 1,
          bindings:
            local && local !== "_" && local !== "."
              ? [{ imported: "*", local }]
              : [],
        },
      ];
    });
  }

  if (language === "java" && node.type === "import_declaration") {
    const importedPath = node.namedChildren.find(
      (child) => child.type === "scoped_identifier",
    )?.text;
    if (!importedPath) return [];
    const wildcard = node.namedChildren.some(
      (child) => child.type === "asterisk",
    );
    const isStatic = /^import\s+static\b/.test(node.text);
    const parts = importedPath.split(".").filter(Boolean);
    if (parts.length === 0) return [];
    const imported = parts.at(-1)!;
    const spec = isStatic
      ? parts.slice(0, -1).join(".")
      : wildcard
        ? `${importedPath}.*`
        : importedPath;
    if (!spec) return [];
    return [
      {
        spec,
        line,
        bindings: wildcard ? [] : [{ imported, local: imported }],
      },
    ];
  }

  if (language === "python" && node.type === "import_from_statement") {
    const module = node.childForFieldName("module_name");
    if (!module) {
      // `from . import x` — module_name may be missing; use leading dots from text
      const match = node.text.match(/^from\s+(\.+[\w.]*)/);
      if (match?.[1]) {
        return [
          {
            spec: match[1],
            line,
            bindings: pythonFromBindings(node, null),
          },
        ];
      }
      return [];
    }
    return [
      {
        spec: module.text.trim(),
        line,
        bindings: pythonFromBindings(node, module),
      },
    ];
  }

  if (language === "python" && node.type === "import_statement") {
    // `import a.b` / `import a, b` — take dotted names
    const specs: ImportSpec[] = [];
    for (const child of node.namedChildren) {
      if (
        child.type === "dotted_name" ||
        child.type === "aliased_import" ||
        child.type === "identifier"
      ) {
        const name =
          child.type === "aliased_import"
            ? (child.childForFieldName("name")?.text ?? child.text)
            : child.text;
        const spec = name.trim();
        if (spec) {
          specs.push({ spec, line });
        }
      }
    }
    return specs;
  }

  // JS/TS import_statement / export_statement … from '…'
  if (node.type === "import_statement" || node.type === "export_statement") {
    const sourceNode = node.childForFieldName("source");
    if (!sourceNode) {
      return [];
    }
    const spec = stripQuotes(sourceNode.text);
    return spec
      ? [{ spec, line, bindings: javascriptNamedBindings(node) }]
      : [];
  }

  return [];
}

function isJavaScriptFamily(language: string): boolean {
  return [
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact",
  ].includes(language);
}

function commonJsRequire(node: TSNode, line: number): ImportSpec | null {
  const callee = node.childForFieldName("function") ?? node.namedChildren[0];
  if (callee?.type !== "identifier" || callee.text !== "require") return null;
  const args =
    node.childForFieldName("arguments") ??
    node.namedChildren.find((child) => child.type === "arguments");
  const source = args?.namedChildren.find((child) =>
    ["string", "template_string"].includes(child.type),
  );
  const spec = source ? stripQuotes(source.text) : "";
  if (!spec || (source?.type === "template_string" && /\$\{/.test(source.text)))
    return null;

  let imported = "*";
  let expression: TSNode = node;
  const member = node.parent;
  if (
    member?.type === "member_expression" &&
    sameNode(
      member.childForFieldName("object") ?? member.namedChildren[0]!,
      node,
    )
  ) {
    const property =
      member.childForFieldName("property") ?? member.namedChildren.at(-1);
    if (property?.text.trim()) imported = property.text.trim();
    expression = member;
  }
  const declarator = enclosingValueDeclarator(expression);
  const pattern = declarator?.childForFieldName("name");
  return {
    spec,
    line,
    bindings: pattern ? commonJsBindings(pattern, imported) : [],
  };
}

function enclosingValueDeclarator(expression: TSNode): TSNode | null {
  for (let current = expression.parent; current; current = current.parent) {
    if (current.type === "variable_declarator") {
      const value = current.childForFieldName("value");
      return value && containsNode(value, expression) ? current : null;
    }
    if (
      ![
        "member_expression",
        "await_expression",
        "parenthesized_expression",
      ].includes(current.type)
    )
      break;
  }
  return null;
}

function containsNode(container: TSNode, candidate: TSNode): boolean {
  return (
    container.startIndex <= candidate.startIndex &&
    container.endIndex >= candidate.endIndex
  );
}

function commonJsBindings(pattern: TSNode, imported: string): ImportBinding[] {
  if (pattern.type === "identifier")
    return [{ imported, local: pattern.text.trim() }];
  if (pattern.type !== "object_pattern") return [];
  return pattern.namedChildren.flatMap((child) => {
    if (
      child.type === "shorthand_property_identifier_pattern" ||
      child.type === "identifier"
    ) {
      const name = child.text.trim();
      return name ? [{ imported: name, local: name }] : [];
    }
    if (child.type !== "pair_pattern" && child.type !== "pair") return [];
    const key = child.childForFieldName("key") ?? child.namedChildren[0];
    const value = child.childForFieldName("value") ?? child.namedChildren[1];
    const importedName = key?.text.trim();
    const local = value?.text.trim();
    return importedName && local ? [{ imported: importedName, local }] : [];
  });
}

function enclosingInlineRustModuleDepth(node: TSNode): number {
  let depth = 0;
  for (let current = node.parent; current; current = current.parent) {
    if (
      current.type === "mod_item" &&
      current.namedChildren.some((child) => child.type === "declaration_list")
    )
      depth++;
  }
  return depth;
}

function rustUseSpecs(node: TSNode, line: number): ImportSpec[] {
  const clause = node.namedChildren[0];
  if (!clause) return [];
  const candidates: Array<{
    module: string;
    imported: string;
    local: string;
  }> = [];
  const addLeaf = (segments: readonly string[], alias?: string): void => {
    const imported = segments.at(-1);
    const module = segments.slice(0, -1).join("::");
    if (!imported) return;
    const local = alias?.trim() || imported;
    if (module) candidates.push({ module, imported, local });
    // A grouped Rust import may name either an item (`DEFAULT_PORT`) or a
    // module (`server`). Persist both syntactic possibilities; path resolution
    // removes the impossible one, and qualified references prefer the module
    // binding while bare references prefer the item binding.
    candidates.push({
      module: segments.join("::"),
      imported: "*",
      local,
    });
  };
  const walk = (
    current: TSNode,
    prefix: readonly string[] = [],
    alias?: string,
  ): void => {
    if (current.type === "use_as_clause") {
      const path =
        current.childForFieldName("path") ?? current.namedChildren[0];
      const local =
        current.childForFieldName("alias") ?? current.namedChildren[1];
      if (path) walk(path, prefix, local?.text);
      return;
    }
    if (current.type === "scoped_use_list") {
      const list = current.namedChildren.find(
        (child) => child.type === "use_list",
      );
      const path = current.namedChildren.find((child) => child !== list);
      if (list) walk(list, [...prefix, ...rustPathSegments(path?.text ?? "")]);
      return;
    }
    if (current.type === "use_list") {
      for (const child of current.namedChildren) walk(child, prefix);
      return;
    }
    if (current.type === "use_wildcard") {
      const module = [...prefix, ...rustPathSegments(current.text)].join("::");
      if (module) candidates.push({ module, imported: "*", local: "*" });
      return;
    }
    if (current.type === "self") {
      const local = alias?.trim() || prefix.at(-1);
      if (prefix.length > 0 && local)
        candidates.push({
          module: prefix.join("::"),
          imported: "*",
          local,
        });
      return;
    }
    if (current.type === "identifier" || current.type === "scoped_identifier") {
      addLeaf([...prefix, ...rustPathSegments(current.text)], alias);
    }
  };
  walk(clause);

  const grouped = new Map<string, ImportBinding[]>();
  for (const candidate of candidates) {
    const bindings = grouped.get(candidate.module) ?? [];
    if (
      !bindings.some(
        (binding) =>
          binding.imported === candidate.imported &&
          binding.local === candidate.local,
      )
    )
      bindings.push({ imported: candidate.imported, local: candidate.local });
    grouped.set(candidate.module, bindings);
  }
  return [...grouped.entries()].map(([spec, bindings]) => ({
    spec,
    line,
    bindings,
  }));
}

function rustPathSegments(value: string): string[] {
  return value
    .replace(/^::/, "")
    .split("::")
    .map((part) => part.trim())
    .filter(Boolean);
}

function defaultGoPackageName(spec: string): string {
  const parts = spec.split("/").filter(Boolean);
  const last = parts.at(-1) ?? "";
  return /^v\d+$/.test(last) ? (parts.at(-2) ?? last) : last;
}

function javascriptNamedBindings(node: TSNode): ImportBinding[] {
  const defaultImports = descendantsOfType(node, "import_clause").flatMap(
    (clause) => {
      const local = clause.namedChildren.find(
        (child) => child.type === "identifier",
      )?.text;
      return local ? [{ imported: "default", local }] : [];
    },
  );
  const named = descendantsOfType(node, "import_specifier").flatMap(
    (specifier) => {
      const importedNode =
        specifier.childForFieldName("name") ?? specifier.namedChildren[0];
      const localNode =
        specifier.childForFieldName("alias") ?? specifier.namedChildren[1];
      const imported = importedNode?.text.replace(/^type\s+/, "").trim();
      const local = (localNode?.text ?? imported)?.trim();
      return imported && local ? [{ imported, local }] : [];
    },
  );
  const namespaces = descendantsOfType(node, "namespace_import").flatMap(
    (namespace) => {
      const localNode =
        namespace.childForFieldName("alias") ??
        namespace.namedChildren.find((child) => child.type === "identifier");
      const local = localNode?.text.trim();
      return local ? [{ imported: "*", local }] : [];
    },
  );
  return [...defaultImports, ...named, ...namespaces];
}

function pythonFromBindings(
  node: TSNode,
  moduleNode: TSNode | null,
): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const visit = (current: TSNode): void => {
    if (moduleNode && sameNode(current, moduleNode)) return;
    if (current.type === "aliased_import") {
      const importedNode =
        current.childForFieldName("name") ?? current.namedChildren[0];
      const localNode =
        current.childForFieldName("alias") ?? current.namedChildren[1];
      const imported = importedNode?.text.trim();
      const local = localNode?.text.trim();
      if (imported && local) bindings.push({ imported, local });
      return;
    }
    if (
      current !== node &&
      (current.type === "identifier" || current.type === "dotted_name")
    ) {
      const name = current.text.trim();
      if (name) bindings.push({ imported: name, local: name });
      return;
    }
    for (const child of current.namedChildren ?? []) visit(child);
  };
  visit(node);
  return bindings;
}

function sameNode(left: TSNode, right: TSNode): boolean {
  return (
    left.type === right.type &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  );
}

function descendantsOfType(node: TSNode, type: string): TSNode[] {
  const out: TSNode[] = [];
  const visit = (current: TSNode): void => {
    if (current.type === type) {
      out.push(current);
      return;
    }
    for (const child of current.namedChildren ?? []) visit(child);
  };
  visit(node);
  return out;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
