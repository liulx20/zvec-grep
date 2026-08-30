import assert from "node:assert/strict";
import test from "node:test";
import { CodeExtractor } from "../../../dist/engine/extraction/code/extractor.js";
import { extractForIndexing } from "../../../dist/engine/extraction/runtime.js";
import { vectorContentForFragment } from "../../../dist/engine/extraction/vector-content.js";

function codeSource(format, text, relativePath = `fixture.${format}`) {
  return {
    kind: "text",
    text,
    file: {
      id: `file-${format}`,
      absolutePath: `/repo/${relativePath}`,
      relativePath,
      rootPath: "/repo",
      sizeBytes: text.length,
      lastModifiedTime: 1,
      kind: "code",
      format,
    },
  };
}

function fragmentNamed(fragments, name) {
  const fragment = fragments.find(
    (candidate) => candidate.metadata?.symbolName === name,
  );
  assert.ok(fragment, `expected a fragment for ${name}`);
  return fragment;
}

function assertSourceBackedFragment(source, fragment) {
  assert.equal(fragment.range.kind, "text");
  assert.equal(fragment.content.kind, "text");
  assert.equal(
    fragment.content.text,
    source.text.slice(fragment.range.startOffset, fragment.range.endOffset),
  );
}

test("code extractor preserves TypeScript metadata, scope, and source ranges", async () => {
  const source = codeSource(
    "typescript",
    [
      "/** Adds one. */",
      "async function add(value: number): Promise<number> {",
      "  return helper(value);",
      "}",
      "export function publish() { return add(1); }",
      "class Box {",
      "  private value = 1;",
      "  static create() { return new Box(); }",
      "}",
    ].join("\n"),
    "contract.ts",
  );
  const fragments = await new CodeExtractor().extract(source, {
    maxChunkChars: 500,
    chunkOverlapChars: 50,
  });
  const add = fragmentNamed(fragments, "add");
  const publish = fragmentNamed(fragments, "publish");
  const create = fragmentNamed(fragments, "create");

  assertSourceBackedFragment(source, add);
  assertSourceBackedFragment(source, publish);
  assertSourceBackedFragment(source, create);
  assert.deepEqual(add.metadata, {
    kind: "code",
    symbolType: "function",
    symbolName: "add",
    scope: null,
    nodeType: "function_declaration",
    signature: "async function add(value: number): Promise<number>",
    arity: 1,
    doc: "Adds one.",
    modifiers: ["async"],
  });
  assert.deepEqual(publish.metadata.modifiers, ["exported"]);
  assert.deepEqual(create.metadata, {
    kind: "code",
    symbolType: "function",
    symbolName: "create",
    scope: "Box",
    nodeType: "method_definition",
    signature: "static create()",
    arity: 0,
    doc: null,
    modifiers: ["static"],
  });
  assert.equal(add.range.startLine, 2);
  assert.equal(create.range.startLine, 8);
  assert.equal(
    new Set(fragments.map((fragment) => fragment.id)).size,
    fragments.length,
  );
  assert.equal(
    fragments.every((fragment) => fragment.id.length === 64),
    true,
  );
});

test("code extractor attaches declaration decorators to the decorated member", async () => {
  const analysis = await new CodeExtractor().analyzeForIndexing(
    codeSource(
      "typescript",
      [
        "class Controller {",
        "  @Route('queue/:id')",
        "  queue(@Param('id') id: string) { return id; }",
        "}",
      ].join("\n"),
    ),
  );
  const queue = analysis.fragments.find(
    ({ fragment }) => fragment.metadata?.symbolName === "queue",
  );
  assert.ok(queue);
  assert.match(queue.embeddingText ?? "", /^@Route\('queue\/:id'\)/);

  const decorated = analysis.refs.flatMap((owner) =>
    owner.sites
      .filter((site) => site.kind === "decorates")
      .map((site) => ({ owner: owner.name, name: site.name })),
  );
  assert.deepEqual(decorated, [
    { owner: "queue", name: "Param" },
    { owner: "queue", name: "Route" },
  ]);
});

test("code extractor indexes callable TypeScript class fields", async () => {
  const fragments = await new CodeExtractor().extract(
    codeSource(
      "typescript",
      `class Client {
  #invoke(value: string) { return value; }
  invoke: {
    (value: string): string;
    use(handler: () => void): void;
  } = Object.assign(this.#invoke, { use(handler: () => void) { handler(); } });
}`,
      "client.ts",
    ),
  );
  const invoke = fragments.find(
    (fragment) =>
      fragment.metadata?.kind === "code" &&
      fragment.metadata.symbolName === "invoke",
  );
  assert.ok(invoke);
  assert.equal(invoke.metadata.symbolType, "function");
  assert.equal(invoke.metadata.scope, "Client");
  assert.equal(invoke.metadata.nodeType, "public_field_definition");
});

test("code extractor finds actions returned by an exported object factory", async () => {
  const extractor = new CodeExtractor();
  const fragments = await extractor.extract(
    codeSource(
      "typescript",
      `export const useStore = create((set, get) => ({
  value: 0,
  fetchUser: async () => { get().reset(); },
  reset: () => set({ value: 0 }),
}));`,
      "store.ts",
    ),
  );
  const actions = fragments.filter(
    (fragment) =>
      fragment.metadata.kind === "code" &&
      fragment.metadata.symbolType === "function",
  );
  assert.deepEqual(
    actions.map((fragment) => fragment.metadata.symbolName).sort(),
    ["fetchUser", "reset"],
  );
  assert.equal(
    actions.every((fragment) => fragment.metadata.scope === "useStore"),
    true,
  );

  const local = await extractor.extract(
    codeSource(
      "typescript",
      "const local = create(() => ({ hidden: () => 1 }));",
      "local.ts",
    ),
  );
  assert.equal(
    local.some(
      (fragment) =>
        fragment.metadata.kind === "code" &&
        fragment.metadata.symbolName === "hidden",
    ),
    false,
  );

  const nested = await extractor.extract(
    codeSource(
      "typescript",
      `export const useStore = defineStore({
  getters: {
    upperName: (state) => state.name.toUpperCase(),
  },
  actions: {
    async fetchMenu() { return loadMenu(); },
    reset: () => clearMenu(),
  },
});`,
      "nested-store.ts",
    ),
  );
  assert.deepEqual(
    nested
      .filter(
        (fragment) =>
          fragment.metadata.kind === "code" &&
          fragment.metadata.symbolType === "function",
      )
      .map((fragment) => fragment.metadata.symbolName)
      .sort(),
    ["fetchMenu", "reset", "upperName"],
  );

  const nestedFactory = await extractor.extract(
    codeSource(
      "typescript",
      `export const api = createApi({
  endpoints: build => ({
    load: build.query({ queryFn: async () => fetchData() }),
  }),
});`,
      "api.ts",
    ),
  );
  const queryFn = nestedFactory.find(
    (fragment) =>
      fragment.metadata.kind === "code" &&
      fragment.metadata.symbolName === "queryFn",
  );
  assert.ok(queryFn);
  assert.equal(queryFn.metadata.scope, "api::endpoints::load");

  const exportedBindings = await extractor.extract(
    codeSource(
      "javascript",
      `const mutations = { SET_TOKEN(state, token) { state.token = token; } };
const actions = { login() { persistToken(); } };
const unrelated = { hidden() {} };
export default { namespaced: true, mutations, commands: actions };`,
      "module.js",
    ),
  );
  assert.deepEqual(
    exportedBindings
      .filter(
        (fragment) =>
          fragment.metadata.kind === "code" &&
          fragment.metadata.symbolType === "function",
      )
      .map((fragment) => fragment.metadata.symbolName)
      .sort(),
    ["SET_TOKEN", "login"],
  );

  const setupStore = await extractor.extract(
    codeSource(
      "typescript",
      `export const useChatStore = defineStore("chat", () => {
  const list = reactive([]);
  const getList = async () => fetchList();
  function pushItem(item: string) { list.push(item); }
  const hidden = () => false;
  return { list, refresh: getList, getList, pushItem };
});`,
      "setup-store.ts",
    ),
  );
  const setupActions = setupStore.filter(
    (fragment) =>
      fragment.metadata.kind === "code" &&
      fragment.metadata.symbolType === "function",
  );
  assert.deepEqual(
    setupActions.map((fragment) => fragment.metadata.symbolName).sort(),
    ["getList", "pushItem", "refresh"],
  );
  assert.equal(
    setupActions.every(
      (fragment) => fragment.metadata.scope === "useChatStore",
    ),
    true,
  );
});

test("code extractor indexes destructured module bindings independently", async () => {
  const fragments = await new CodeExtractor().extract(
    codeSource(
      "typescript",
      "export const { useFooQuery, useBarQuery: useAlias } = api;",
      "api.ts",
    ),
  );
  const bindings = fragments.filter(
    (fragment) => fragment.metadata?.symbolType === "value",
  );

  assert.deepEqual(
    bindings.map((fragment) => fragment.metadata.symbolName).sort(),
    ["useAlias", "useFooQuery"],
  );
  assert.equal(
    bindings.every((fragment) => fragment.metadata.scope === null),
    true,
  );
});

test("code extractor preserves language-specific symbols and scopes", async () => {
  const extractor = new CodeExtractor();
  const c = await extractor.extract(
    codeSource(
      "c",
      [
        "typedef struct Widget { int value; } Widget;",
        "static int add(int a, int b) { return a + b; }",
      ].join("\n"),
      "fixture.c",
    ),
  );
  const go = await extractor.extract(
    codeSource(
      "go",
      [
        "package demo",
        "type Widget struct { value int }",
        "func (w *Widget) Value() int { return w.value }",
        "type Reader interface { Read() string }",
      ].join("\n"),
      "fixture.go",
    ),
  );
  const python = await extractor.extract(
    codeSource(
      "python",
      [
        "class Service:",
        "    @staticmethod",
        "    async def fetch(value: str) -> str:",
        "        return value",
      ].join("\n"),
      "fixture.py",
    ),
  );

  assert.deepEqual(fragmentNamed(c, "Widget").metadata, {
    kind: "code",
    symbolType: "class",
    symbolName: "Widget",
    scope: null,
    nodeType: "type_definition",
    signature: "typedef struct Widget { int value; } Widget",
    arity: null,
    doc: null,
    modifiers: [],
  });
  assert.deepEqual(fragmentNamed(c, "add").metadata.modifiers, ["static"]);
  assert.deepEqual(fragmentNamed(go, "Value").metadata, {
    kind: "code",
    symbolType: "function",
    symbolName: "Value",
    scope: "Widget",
    nodeType: "method_declaration",
    signature: "func (w *Widget) Value() int",
    arity: 0,
    doc: null,
    modifiers: ["exported"],
  });
  assert.equal(fragmentNamed(go, "Reader").metadata.symbolType, "interface");
  assert.equal(fragmentNamed(go, "Read").metadata.scope, "Reader");
  assert.deepEqual(fragmentNamed(python, "fetch").metadata, {
    kind: "code",
    symbolType: "function",
    symbolName: "fetch",
    scope: "Service",
    nodeType: "decorated_definition",
    signature: "async def fetch(value: str) -> str:",
    arity: 1,
    doc: null,
    modifiers: ["async", "static"],
  });
});

test("Python ABC, Protocol, and abstract methods retain abstract semantics", async () => {
  const fragments = await new CodeExtractor().extract(
    codeSource(
      "python",
      [
        "from abc import ABC, abstractmethod",
        "from typing import Protocol",
        "class Driver(ABC):",
        "    @abstractmethod",
        "    def run(self) -> None: ...",
        "    def stop(self) -> None:",
        "        raise NotImplementedError",
        "class Shape(Protocol):",
        "    def area(self) -> float: ...",
        "class MetaDriver(metaclass=ABCMeta):",
        "    pass",
      ].join("\n"),
      "abstracts.py",
    ),
  );

  assert.ok(
    fragmentNamed(fragments, "Driver").metadata.modifiers.includes("abstract"),
  );
  assert.ok(
    fragmentNamed(fragments, "run").metadata.modifiers.includes("abstract"),
  );
  assert.ok(
    fragmentNamed(fragments, "stop").metadata.modifiers.includes("abstract"),
  );
  assert.ok(
    fragmentNamed(fragments, "Shape").metadata.modifiers.includes("abstract"),
  );
  assert.ok(
    fragmentNamed(fragments, "area").metadata.modifiers.includes("abstract"),
  );
  assert.ok(
    fragmentNamed(fragments, "MetaDriver").metadata.modifiers.includes(
      "abstract",
    ),
  );
});

test("C field-shaped API declarations with pointer parameters remain functions", async () => {
  const fragments = await new CodeExtractor().extract(
    codeSource(
      "c",
      [
        "struct parser_recovery_scope {",
        "  UV_EXTERN void uv_close(uv_handle_t* handle, uv_close_cb close_cb);",
        "  void (*on_close)(int code);",
        "};",
      ].join("\n"),
      "include/api.h",
    ),
  );

  assert.equal(
    fragmentNamed(fragments, "uv_close").metadata.symbolType,
    "function",
  );
  assert.equal(
    fragmentNamed(fragments, "on_close").metadata.symbolType,
    "value",
  );
});

test("large code entities emit searchable outlines and grouped source windows", async () => {
  const source = codeSource(
    "typescript",
    [
      "export class Service {",
      "  first(value: string) { return value.repeat(20); }",
      "  second() { return this.first(fetchValue()); }",
      "  third() { return new Service(); }",
      "}",
      "export function orchestrate(value: string) {",
      "  const first = load(value);",
      "  const second = client.fetch(first);",
      "  return finalize(second);",
      "}",
    ].join("\n"),
    "large.ts",
  );
  const maxChunkChars = 140;
  const fragments = await new CodeExtractor().extract(source, {
    maxChunkChars,
    chunkOverlapChars: 30,
  });
  const serviceOutline = fragments.find(
    (fragment) =>
      fragment.metadata?.symbolName === "Service" &&
      fragment.group === fragment.id,
  );
  const functionOutline = fragments.find(
    (fragment) =>
      fragment.metadata?.symbolName === "orchestrate" &&
      fragment.group === fragment.id,
  );
  assert.ok(serviceOutline);
  assert.ok(functionOutline);
  assert.match(serviceOutline.content.text, /members:/);
  assert.match(serviceOutline.content.text, /function first\(value: string\)/);
  assert.match(serviceOutline.content.text, /function second\(\)/);
  assert.match(
    functionOutline.content.text,
    /calls: load, client\.fetch, finalize/,
  );

  const serviceWindows = fragments.filter(
    (fragment) =>
      fragment.group === serviceOutline.id && fragment.id !== serviceOutline.id,
  );
  assert.ok(serviceWindows.length >= 2);
  for (const fragment of serviceWindows) {
    assertSourceBackedFragment(source, fragment);
    assert.ok(fragment.content.text.length <= maxChunkChars);
  }
  assert.ok(
    serviceWindows[0].range.endOffset > serviceWindows[1].range.startOffset,
    "adjacent windows should preserve the requested overlap",
  );
});

test("indexing compacts AST gaps without changing stored source windows", async () => {
  const source = codeSource(
    "python",
    [
      "def spaced() -> str:",
      "    first_value = prepare()",
      ...Array.from({ length: 70 }, () => ""),
      "    second_value = transform(first_value)",
      "    return second_value",
    ].join("\n"),
    "spaced.py",
  );
  const maxChunkChars = 120;
  const prepared = await extractForIndexing(source, {
    maxChunkChars,
    chunkOverlapChars: 18,
  });
  const major = prepared.find(
    ({ fragment }) =>
      fragment.metadata?.symbolName === "spaced" &&
      fragment.group === fragment.id,
  );
  assert.ok(major);
  assert.match(major.fragment.content.text, /calls: prepare, transform/);

  const compactWindow = prepared.find(
    ({ fragment, embeddingSource }) =>
      fragment.group === major.fragment.id &&
      embeddingSource?.kind === "text" &&
      embeddingSource.text.includes("first_value = prepare()") &&
      embeddingSource.text.includes("second_value = transform(first_value)"),
  );
  assert.ok(compactWindow);
  assertSourceBackedFragment(source, compactWindow.fragment);
  assert.ok(compactWindow.fragment.content.text.length > maxChunkChars);
  assert.doesNotMatch(compactWindow.embeddingSource.text, /\n\n/u);

  const vectorContent = vectorContentForFragment(
    compactWindow.fragment,
    compactWindow.embeddingSource,
    maxChunkChars,
  );
  assert.equal(vectorContent.kind, "text");
  assert.ok(vectorContent.text.length <= maxChunkChars);
  assert.match(vectorContent.text, /^symbol: function spaced/m);
});

test("component script extraction remaps multiple blocks and preserves fallbacks", async () => {
  const extractor = new CodeExtractor();
  const source = codeSource(
    "svelte",
    [
      "<h1>Hello</h1>",
      "<script>",
      "export const first = () => 1;",
      "</script>",
      "<p>Middle</p>",
      '<script lang="ts">',
      "export function second(value: number) { return value; }",
      "</script>",
    ].join("\n"),
    "fixture.svelte",
  );
  const fragments = await extractor.extract(source);
  const first = fragmentNamed(fragments, "first");
  const second = fragmentNamed(fragments, "second");

  assertSourceBackedFragment(source, first);
  assertSourceBackedFragment(source, second);
  assert.equal(first.range.startLine, 3);
  assert.equal(second.range.startLine, 7);
  assert.equal(
    new Set(fragments.map((fragment) => fragment.id)).size,
    fragments.length,
  );

  const plainSource = codeSource(
    "vue",
    '<template><p>x</p></template>\n<script lang="ts">\n// no declarations\n</script>',
    "plain.vue",
  );
  const [plain] = await extractor.extract(plainSource);
  assertSourceBackedFragment(plainSource, plain);
  assert.equal(plain.metadata?.kind, "code");
  assert.equal(plain.metadata?.symbolType, "component");
  assert.equal(plain.metadata?.symbolName, "plain");
  assert.equal(plain.content.text, plainSource.text);

  const noScriptSource = codeSource(
    "svelte",
    "<h1>No script</h1>",
    "no-script.svelte",
  );
  const [noScript] = await extractor.extract(noScriptSource);
  assertSourceBackedFragment(noScriptSource, noScript);
  assert.equal(noScript.metadata?.kind, "code");
  assert.equal(noScript.metadata?.symbolType, "component");
  assert.equal(noScript.metadata?.symbolName, "no-script");
  assert.equal(noScript.content.text, noScriptSource.text);

  for (const format of ["vue", "svelte"]) {
    const indexSource = codeSource(
      format,
      "<h1>Directory component</h1>",
      `components/ArticleList/index.${format}`,
    );
    const [indexComponent] = await extractor.extract(indexSource);
    assert.equal(indexComponent.metadata?.symbolType, "component");
    assert.equal(indexComponent.metadata?.symbolName, "ArticleList");
  }
});

test("code chunk boundaries never split Unicode surrogate pairs", async () => {
  const source = codeSource(
    "typescript",
    `export function emoji() { return "${"😀".repeat(80)}"; }`,
    "unicode.ts",
  );
  const fragments = await new CodeExtractor().extract(source, {
    maxChunkChars: 31,
    chunkOverlapChars: 7,
  });
  const windows = fragments.filter(
    (fragment) =>
      fragment.metadata?.symbolName === "emoji" &&
      fragment.group !== fragment.id,
  );
  assert.ok(windows.length > 2);

  for (const fragment of windows) {
    assertSourceBackedFragment(source, fragment);
    assert.ok(fragment.content.text.length <= 31);
    assert.doesNotMatch(fragment.content.text, /[\uD800-\uDBFF]$/u);
    assert.doesNotMatch(fragment.content.text, /^[\uDC00-\uDFFF]/u);
  }
});
