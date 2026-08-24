import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodeExtractor } from "../../dist/engine/extraction/code/extractor.js";
import {
  SqliteGraphStorage,
  extractFileGraph,
} from "../../dist/engine/graph/index.js";

function codeFile(relativePath = "mod.ts") {
  return {
    id: "file-1",
    collectionId: "collection-1",
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    rootPath: "/repo",
    sizeBytes: 100,
    lastModifiedTime: 1,
    kind: "code",
    format: "typescript",
  };
}

test("extractFileGraph builds local CALLS and pending cross-file refs", async () => {
  const file = codeFile("local.ts");
  const text = `
export function helper() {
  return 1;
}

export function run() {
  helper();
  helper();
  missingElsewhere();
  console.log("x");
}
`;
  const source = { kind: "text", text, file };
  const fragments = await new CodeExtractor().extract(source);
  const graphInput = await extractFileGraph(source, fragments);

  assert.ok(graphInput.nodes.some((n) => n.name === "run"));
  assert.ok(graphInput.nodes.some((n) => n.name === "helper"));

  const localCalls = graphInput.edges.filter((e) => e.kind === "CALLS");
  assert.equal(localCalls.length, 2);
  assert.equal(new Set(localCalls.map((edge) => edge.id)).size, 2);
  assert.deepEqual(
    localCalls.map((edge) => edge.count),
    [1, 1],
  );
  assert.equal(localCalls[0].rel, "call");

  assert.ok(
    graphInput.refs.some((r) => r.ref_name === "missingElsewhere"),
    "cross-file call should be pending",
  );
  assert.equal(
    graphInput.refs.some(
      (r) => r.ref_name === "console" || r.ref_name === "console.log",
    ),
    false,
    "builtin console should be dropped early",
  );

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    file.id,
    graphInput.nodes,
    graphInput.edges,
    graphInput.refs,
  );
  await graph.resolvePending();

  const run = graphInput.nodes.find((n) => n.name === "run");
  const helper = graphInput.nodes.find((n) => n.name === "helper");
  assert.ok(run && helper);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((s) => s.id),
    [helper.id],
  );
  assert.equal(graph.callees(run.id, 1, 10)[0].count, 2);

  graph.upsertFileGraph(
    "other-file",
    [
      {
        id: "other-helper",
        kind: "function",
        is_exported: true,
        name: "helper",
      },
    ],
    [],
    [],
  );
  await graph.resolvePending();
  assert.equal(
    graph.callees(run.id, 1, 10).find((item) => item.id === helper.id)?.count,
    2,
    "reprojection must preserve every local call occurrence",
  );
  graph.close();
});

test("nested exported object methods retain their own call ownership", async () => {
  const file = codeFile("store.ts");
  const text = `
function loadMenu() { return []; }
function clearMenu() {}
export const useStore = defineStore({
  actions: {
    async fetchMenu() { return loadMenu(); },
    reset: () => clearMenu(),
  },
});
`;
  const source = { kind: "text", text, file };
  const extractor = new CodeExtractor();
  const analysis = await extractor.analyzeForIndexing(source);
  const graphInput = await extractFileGraph(
    source,
    analysis.fragments.map(({ fragment }) => fragment),
    analysis,
  );
  const id = (name) => graphInput.nodes.find((node) => node.name === name)?.id;

  assert.ok(id("fetchMenu"));
  assert.ok(id("reset"));
  assert.ok(
    graphInput.edges.some(
      (edge) =>
        edge.kind === "CALLS" &&
        edge.src === id("fetchMenu") &&
        edge.dst === id("loadMenu"),
    ),
  );
  assert.ok(
    graphInput.edges.some(
      (edge) =>
        edge.kind === "CALLS" &&
        edge.src === id("reset") &&
        edge.dst === id("clearMenu"),
    ),
  );
});

test("Vue and Svelte script blocks retain file-level graph relations", async () => {
  for (const format of ["vue", "svelte"]) {
    const file = {
      ...codeFile(`component.${format}`),
      id: `file-${format}`,
      format,
    };
    const text = [
      "<template><p>component</p></template>",
      '<script lang="ts">',
      'import { remote } from "./remote";',
      "function helper() { return 1; }",
      "export function run() { return helper() + remote(); }",
      "</script>",
    ].join("\n");
    const source = { kind: "text", text, file };
    const extractor = new CodeExtractor();
    const analysis = await extractor.analyzeForIndexing(source);
    const graphInput = await extractFileGraph(
      source,
      analysis.fragments.map(({ fragment }) => fragment),
      analysis,
    );
    const run = graphInput.nodes.find((node) => node.name === "run");
    const helper = graphInput.nodes.find((node) => node.name === "helper");
    const component = graphInput.nodes.find(
      (node) => node.name === "component" && node.kind === "component",
    );

    assert.ok(component, `${format}: expected component symbol`);
    assert.ok(run, `${format}: expected run symbol`);
    assert.ok(helper, `${format}: expected helper symbol`);
    assert.ok(
      graphInput.edges.some(
        (edge) =>
          edge.kind === "CONTAINS" &&
          edge.src === component.id &&
          edge.dst === run.id,
      ),
      `${format}: expected component containment`,
    );
    assert.ok(
      graphInput.edges.some(
        (edge) =>
          edge.kind === "CALLS" &&
          edge.src === run.id &&
          edge.dst === helper.id &&
          edge.first_line === 5,
      ),
      `${format}: expected remapped local call`,
    );
    assert.ok(
      graphInput.refs.some(
        (ref) =>
          ref.ref_kind === "import" &&
          ref.ref_name === "./remote" &&
          ref.line === 3 &&
          ref.source_language === "typescript",
      ),
      `${format}: expected remapped TypeScript import`,
    );
    assert.ok(
      graphInput.refs.some(
        (ref) =>
          ref.ref_kind === "call" &&
          ref.ref_name === "remote" &&
          ref.line === 5 &&
          ref.source_language === "typescript",
      ),
      `${format}: expected remapped cross-file call`,
    );
  }
});

test("component templates link imported components and Svelte calls", async () => {
  const childFile = {
    ...codeFile("components/ChildWidget.vue"),
    id: "component-child",
    format: "vue",
  };
  const parentFile = {
    ...codeFile("components/ParentWidget.vue"),
    id: "component-parent",
    format: "vue",
  };
  const svelteFile = {
    ...codeFile("components/Panel.svelte"),
    id: "component-svelte",
    format: "svelte",
  };
  const prepare = async (file, text) => {
    const source = { kind: "text", file, text };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    return extractFileGraph(
      source,
      analysis.fragments.map(({ fragment }) => fragment),
      analysis,
    );
  };
  const child = await prepare(
    childFile,
    `<script setup lang="ts">export const label = "child";</script>`,
  );
  const parent = await prepare(
    parentFile,
    `<script setup lang="ts">import ChildWidget from "./ChildWidget.vue";</script>\n<template><!-- <FakeWidget /> --><Transition><child-widget /></Transition></template>`,
  );
  const svelte = await prepare(
    svelteFile,
    `<script>const state = $state(0); function formatLabel() { return "panel"; }</script>\n<p>{formatLabel()}</p>`,
  );
  const childComponent = child.nodes.find(
    (node) => node.name === "ChildWidget" && node.kind === "component",
  );
  const parentComponent = parent.nodes.find(
    (node) => node.name === "ParentWidget" && node.kind === "component",
  );
  const svelteComponent = svelte.nodes.find(
    (node) => node.name === "Panel" && node.kind === "component",
  );
  const formatLabel = svelte.nodes.find((node) => node.name === "formatLabel");
  assert.ok(
    childComponent && parentComponent && svelteComponent && formatLabel,
  );
  assert.equal(
    parent.refs.some(
      (ref) => ref.ref_name === "FakeWidget" || ref.ref_name === "Transition",
    ),
    false,
  );
  assert.equal(
    svelte.refs.some((ref) => ref.ref_name === "$state"),
    false,
  );

  const graph = new SqliteGraphStorage("", { inMemory: true });
  for (const [file, input] of [
    [childFile, child],
    [parentFile, parent],
    [svelteFile, svelte],
  ]) {
    graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  }
  await graph.resolvePending({ files: [childFile, parentFile, svelteFile] });

  assert.ok(
    graph
      .usages(childComponent.id, 10)
      .some((node) => node.id === parentComponent.id),
  );
  assert.ok(
    graph
      .callees(svelteComponent.id, 1, 10)
      .some((node) => node.id === formatLabel.id),
  );
  graph.close();
});

test("default imports resolve a uniquely exported target under a local alias", async () => {
  const targetFile = {
    ...codeFile("target.ts"),
    id: "default-target",
  };
  const callerFile = {
    ...codeFile("caller.ts"),
    id: "default-caller",
  };
  const prepare = async (file, text) => {
    const source = { kind: "text", file, text };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    return extractFileGraph(
      source,
      analysis.fragments.map(({ fragment }) => fragment),
      analysis,
    );
  };
  const target = await prepare(
    targetFile,
    `export default function internalTarget() { return 1; }`,
  );
  const caller = await prepare(
    callerFile,
    `import renamedTarget from "./target"; export function invokeDefault() { return renamedTarget(); }`,
  );
  const internalTarget = target.nodes.find(
    (node) => node.name === "internalTarget",
  );
  const invokeDefault = caller.nodes.find(
    (node) => node.name === "invokeDefault",
  );
  assert.ok(internalTarget && invokeDefault);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(targetFile.id, target.nodes, target.edges, target.refs);
  graph.upsertFileGraph(callerFile.id, caller.nodes, caller.edges, caller.refs);
  await graph.resolvePending({ files: [targetFile, callerFile] });
  assert.deepEqual(
    graph.callees(invokeDefault.id, 1, 10).map((node) => node.id),
    [internalTarget.id],
  );
  graph.close();
});

test("external import bindings never borrow same-name workspace symbols", async () => {
  const localFile = codeFile("local-map.ts");
  const consumerFile = {
    ...codeFile("consumer.ts"),
    id: "external-consumer",
  };
  const localSource = {
    kind: "text",
    file: localFile,
    text: `export function map() { return "local"; }`,
  };
  const consumerSource = {
    kind: "text",
    file: consumerFile,
    text: `import map from "lodash";
import * as React from "react";
export function runExternal() { map([]); React.useState(0); }`,
  };
  const localAnalysis = await new CodeExtractor().analyzeForIndexing(
    localSource,
  );
  const consumerAnalysis = await new CodeExtractor().analyzeForIndexing(
    consumerSource,
  );
  const local = await extractFileGraph(
    localSource,
    localAnalysis.fragments.map(({ fragment }) => fragment),
    localAnalysis,
  );
  const consumer = await extractFileGraph(
    consumerSource,
    consumerAnalysis.fragments.map(({ fragment }) => fragment),
    consumerAnalysis,
  );
  const run = consumer.nodes.find((node) => node.name === "runExternal");
  assert.ok(run);
  assert.equal(
    consumer.refs.some(
      (ref) => ref.ref_name === "map" || ref.ref_name === "React.useState",
    ),
    false,
  );
  assert.equal(
    consumer.edges.some((edge) => edge.kind === "CALLS" && edge.src === run.id),
    false,
  );
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(localFile.id, local.nodes, local.edges, local.refs);
  graph.upsertFileGraph(
    consumerFile.id,
    consumer.nodes,
    consumer.edges,
    consumer.refs,
  );
  await graph.resolvePending({ files: [localFile, consumerFile] });
  assert.deepEqual(graph.callees(run.id, 1, 10), []);
  graph.close();
});

test("C-family function-pointer slots expose only registered handlers", async () => {
  for (const format of ["c", "cpp"]) {
    const file = {
      ...codeFile(`dispatch.${format === "c" ? "c" : "cc"}`),
      format,
    };
    const text = `
struct cmd { int (*fn)(int); };
static int add(int x) { return x + 1; }
static int unused(int x) { return x; }
static struct cmd table[] = { { add } };
int dispatch(struct cmd *p, int x) { return p->fn(x); }
`;
    const source = { kind: "text", text, file };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const graphInput = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    const byName = (name) =>
      graphInput.nodes.find((node) => node.name === name);
    const slot = byName("fn");
    const table = byName("table");
    const add = byName("add");
    const unused = byName("unused");
    const dispatch = byName("dispatch");
    assert.ok(slot && table && add && unused && dispatch, format);
    assert.equal(slot.kind, "value", `${format}: callable slot is data`);

    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(
      file.id,
      graphInput.nodes,
      graphInput.edges,
      graphInput.refs,
    );
    await graph.resolvePending({ files: [file] });

    assert.ok(
      graph
        .outgoingEdges([table.id], ["REFS"], 20)
        .some(
          (edge) =>
            edge.dst === add.id &&
            edge.rel === "function" &&
            edge.provenance === "static",
        ),
      `${format}: the table retains its registered handler`,
    );
    assert.equal(
      graph
        .outgoingEdges([table.id], ["REFS"], 20)
        .some((edge) => edge.dst === unused.id),
      false,
      `${format}: unregistered functions do not become targets`,
    );
    assert.equal(
      graph
        .outgoingEdges([dispatch.id], ["CALLS"], 20)
        .some((edge) => edge.dst === slot.id),
      false,
      `${format}: dispatch must not call the storage slot declaration`,
    );
    const boundary = graph
      .dynamicBoundaries([dispatch.id], 20)
      .find((item) => item.target.member === "fn");
    assert.ok(boundary, `${format}: indirect dispatch remains explicit`);
    assert.equal(boundary.target.hints?.receiverType, "cmd");
    assert.deepEqual(boundary.candidates, [add.id]);
    assert.equal(boundary.candidateDetails[0]?.reason, "function_pointer");
    assert.equal(boundary.candidateDetails[0]?.confidence, 0.85);
    graph.close();
  }
});

test("C function-pointer candidates are isolated by struct field", async () => {
  const file = { ...codeFile("vtable.c"), format: "c" };
  const source = {
    kind: "text",
    file,
    text: `
struct io { int (*read)(void); int (*write)(int); };
static int do_read(void) { return 0; }
static int do_write(int x) { return x; }
static struct io handlers = { .read = do_read, .write = do_write };
int only_reads(struct io *p) { return p->read(); }
`,
  };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const node = (name) => input.nodes.find((item) => item.name === name);
  const onlyReads = node("only_reads");
  const doRead = node("do_read");
  const doWrite = node("do_write");
  assert.ok(onlyReads && doRead && doWrite);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  const boundary = graph
    .dynamicBoundaries([onlyReads.id], 20)
    .find((item) => item.target.member === "read");
  assert.ok(boundary);
  assert.deepEqual(boundary.candidates, [doRead.id]);
  assert.equal(boundary.candidates.includes(doWrite.id), false);
  graph.close();
});

test("C function-pointer positional tables retain every registered handler", async () => {
  const file = { ...codeFile("commands.c"), format: "c" };
  const source = {
    kind: "text",
    file,
    text: `
struct cmd { const char *name; int (*fn)(int); };
static int add(int x) { return x + 1; }
static int remove_item(int x) { return x - 1; }
static int unused(int x) { return x; }
static struct cmd table[] = {
  { "add", add },
  { "remove", remove_item },
};
int dispatch(struct cmd *p, int x) { return p->fn(x); }
`,
  };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const node = (name) => input.nodes.find((item) => item.name === name);
  const dispatch = node("dispatch");
  const add = node("add");
  const removeItem = node("remove_item");
  const unused = node("unused");
  assert.ok(dispatch && add && removeItem && unused);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  const boundary = graph
    .dynamicBoundaries([dispatch.id], 20)
    .find((item) => item.target.member === "fn");
  assert.ok(boundary);
  assert.deepEqual(
    new Set(boundary.candidates),
    new Set([add.id, removeItem.id]),
  );
  assert.equal(boundary.candidates.includes(unused.id), false);
  graph.close();
});

test("C bare function-pointer arrays resolve without cross-file slot bleed", async () => {
  const fixtures = [
    {
      file: { ...codeFile("first.c"), id: "first.c", format: "c" },
      text: `typedef int op_t(int);
static int first_op(int value) { return value; }
static op_t *ops[] = { first_op };
int first_step(int index, int value) { return ops[index](value); }`,
      dispatch: "first_step",
      handler: "first_op",
    },
    {
      file: { ...codeFile("second.c"), id: "second.c", format: "c" },
      text: `typedef int op_t(int);
static int second_op(int value) { return -value; }
static op_t *ops[] = { second_op };
int second_step(int index, int value) { return ops[index](value); }`,
      dispatch: "second_step",
      handler: "second_op",
    },
  ];
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const resolved = [];
  for (const fixture of fixtures) {
    const source = { kind: "text", file: fixture.file, text: fixture.text };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    const dispatch = input.nodes.find((item) => item.name === fixture.dispatch);
    const handler = input.nodes.find((item) => item.name === fixture.handler);
    assert.ok(dispatch && handler);
    resolved.push({ dispatch, handler });
    graph.upsertFileGraph(
      fixture.file.id,
      input.nodes,
      input.edges,
      input.refs,
    );
  }
  await graph.resolvePending({ files: fixtures.map(({ file }) => file) });

  for (const { dispatch, handler } of resolved) {
    const boundary = graph
      .dynamicBoundaries([dispatch.id], 20)
      .find((item) => item.target.receiver?.name === "ops");
    assert.ok(boundary);
    assert.deepEqual(boundary.candidates, [handler.id]);
    assert.equal(boundary.candidateDetails[0]?.reason, "function_pointer");
    assert.ok(
      graph.impact(handler.id, 1, 20).some((item) => item.id === dispatch.id),
      "impact must include candidate-backed indirect callers",
    );
  }

  const replacementSource = {
    kind: "text",
    file: fixtures[0].file,
    text: `typedef int op_t(int);
static int replacement_op(int value) { return value + 1; }
static op_t *ops[] = { replacement_op };
int first_step(int index, int value) { return ops[index](value); }`,
  };
  const replacementAnalysis = await new CodeExtractor().analyzeForIndexing(
    replacementSource,
  );
  const replacementInput = await extractFileGraph(
    replacementSource,
    replacementAnalysis.fragments.map((item) => item.fragment),
    replacementAnalysis,
  );
  graph.upsertFileGraph(
    fixtures[0].file.id,
    replacementInput.nodes,
    replacementInput.edges,
    replacementInput.refs,
  );
  await graph.resolvePending({ files: fixtures.map(({ file }) => file) });
  const replacementDispatch = replacementInput.nodes.find(
    (item) => item.name === "first_step",
  );
  const replacementHandler = replacementInput.nodes.find(
    (item) => item.name === "replacement_op",
  );
  assert.ok(replacementDispatch && replacementHandler);
  const replacementBoundary = graph
    .dynamicBoundaries([replacementDispatch.id], 20)
    .find((item) => item.target.receiver?.name === "ops");
  assert.ok(replacementBoundary);
  assert.deepEqual(replacementBoundary.candidates, [replacementHandler.id]);

  graph.close();
});

test("C direct function-pointer assignment resolves before its dispatch", async () => {
  const file = { ...codeFile("direct-registration.c"), format: "c" };
  const source = {
    kind: "text",
    file,
    text: `
struct cmd { int (*callback)(int); };
static int zed(int x) { return x; }
void register_handler(struct cmd *p) { p->callback = zed; }
int dispatch(struct cmd *p, int x) { return p->callback(x); }
`,
  };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const dispatch = input.nodes.find((item) => item.name === "dispatch");
  const zed = input.nodes.find((item) => item.name === "zed");
  assert.ok(dispatch && zed);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  const boundary = graph
    .dynamicBoundaries([dispatch.id], 20)
    .find((item) => item.target.member === "callback");
  assert.ok(boundary);
  assert.deepEqual(boundary.candidates, [zed.id]);
  graph.close();
});

test("C callback registration remains resolvable when the struct lives in a header", async () => {
  const fixtures = [
    {
      file: { ...codeFile("ops.h"), id: "ops.h", format: "c" },
      text: "struct ops { int (*handler)(int); };",
    },
    {
      file: { ...codeFile("register.c"), id: "register.c", format: "c" },
      text: `#include "ops.h"
static int on_event(int value) { return value; }
void register_ops(struct ops *ops) { ops->handler = on_event; }`,
    },
    {
      file: { ...codeFile("dispatch.c"), id: "dispatch.c", format: "c" },
      text: `#include "ops.h"
int dispatch(struct ops *ops, int value) { return ops->handler(value); }`,
    },
  ];
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const inputs = [];
  for (const fixture of fixtures) {
    const source = { kind: "text", ...fixture };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    inputs.push(input);
    graph.upsertFileGraph(
      fixture.file.id,
      input.nodes,
      input.edges,
      input.refs,
    );
  }
  await graph.resolvePending({ files: fixtures.map(({ file }) => file) });

  const nodes = inputs.flatMap((input) => input.nodes);
  const dispatch = nodes.find((node) => node.name === "dispatch");
  const handler = nodes.find((node) => node.name === "on_event");
  assert.ok(dispatch && handler);
  const boundary = graph
    .dynamicBoundaries([dispatch.id], 10)
    .find((item) => item.target.member === "handler");
  assert.ok(boundary);
  assert.deepEqual(boundary.candidates, [handler.id]);
  graph.close();
});

test("C function-pointer registrations reproject after a table-only update", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const dispatchFile = "dispatch.c";
  const handlersFile = "handlers.c";
  const tableFile = "table.c";
  const dispatch = "dispatch";
  const add = "add";
  const removeItem = "remove_item";
  const table = "table";
  graph.upsertFileGraph(
    handlersFile,
    [
      { id: add, kind: "function", name: "add", is_exported: true },
      {
        id: removeItem,
        kind: "function",
        name: "remove_item",
        is_exported: true,
      },
    ],
    [],
    [],
  );
  const registrationEdge = (target, id) => ({
    id,
    src: table,
    dst: target,
    rel: "function",
    count: 1,
    first_line: 3,
    ref_name: target,
    kind: "REFS",
    source_language: "c",
    target: {
      raw: target,
      member: target,
      hints: {
        functionPointerRegistration: { containerType: "cmd", field: "fn" },
      },
    },
  });
  graph.upsertFileGraph(
    tableFile,
    [{ id: table, kind: "value", name: "table", is_exported: false }],
    [registrationEdge(add, "register-add")],
    [],
  );
  graph.upsertFileGraph(
    dispatchFile,
    [
      {
        id: dispatch,
        kind: "function",
        name: "dispatch",
        is_exported: true,
      },
    ],
    [],
    [
      {
        type: "symbol",
        id: "dispatch-fn-call",
        owner: dispatch,
        ref_name: "p->fn",
        ref_kind: "call",
        line: 1,
        source_language: "c",
        target: {
          raw: "p->fn",
          receiver: { kind: "qualified", name: "p" },
          member: "fn",
          hints: { receiverType: "cmd", candidateTypes: ["cmd"] },
        },
      },
    ],
  );
  await graph.resolvePending();
  assert.deepEqual(graph.dynamicBoundaries([dispatch], 10)[0]?.candidates, [
    add,
  ]);

  graph.upsertFileGraph(
    tableFile,
    [{ id: table, kind: "value", name: "table", is_exported: false }],
    [registrationEdge(removeItem, "register-remove")],
    [],
  );
  await graph.resolvePending();
  assert.deepEqual(
    graph.dynamicBoundaries([dispatch], 10)[0]?.candidates,
    [removeItem],
    "changing only the registration fact must replace the stale projection",
  );
  graph.close();
});

test("language builtins do not hide a locally defined symbol", async () => {
  const file = codeFile("local-builtin-name.ts");
  const source = {
    kind: "text",
    file,
    text: `
export function map() { return 1; }
export function run() { return map(); }
`,
  };
  const fragments = await new CodeExtractor().extract(source);
  const graphInput = await extractFileGraph(source, fragments);
  const map = graphInput.nodes.find((node) => node.name === "map");
  const run = graphInput.nodes.find((node) => node.name === "run");
  assert.ok(map && run);
  assert.ok(
    graphInput.edges.some(
      (edge) =>
        edge.kind === "CALLS" && edge.src === run.id && edge.dst === map.id,
    ),
  );
});

test("callable parameters shadow same-named global functions across languages", async () => {
  const fixtures = [
    [
      "javascript",
      "function target() {} function invoke(target) { target(); }",
    ],
    ["jsx", "function target() {} function invoke(target) { target(); }"],
    [
      "typescript",
      "function target() {} function invoke(target: () => void) { target(); }",
    ],
    [
      "tsx",
      "function target() { return <div />; } function invoke(target: () => void) { target(); return <div />; }",
    ],
    ["python", "def target(): return 1\ndef invoke(target): return target()\n"],
    [
      "go",
      "package fixture\nfunc target() {}\nfunc invoke(target func()) { target() }\n",
    ],
    ["rust", "fn target() {} fn invoke(target: fn()) { target(); }"],
  ];

  for (const [format, text] of fixtures) {
    const file = { ...codeFile(`shadow.${format}`), format };
    const source = { kind: "text", file, text };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    const invoke = input.nodes.find((node) => node.name === "invoke");
    const target = input.nodes.find((node) => node.name === "target");
    assert.ok(invoke && target, format);
    assert.equal(
      input.edges.some(
        (edge) =>
          edge.kind === "CALLS" &&
          edge.src === invoke.id &&
          edge.dst === target.id,
      ),
      false,
      `${format}: local phase must not bind the callback to the global`,
    );

    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
    await graph.resolvePending();
    assert.equal(
      graph.callees(invoke.id, 1, 10).some((node) => node.id === target.id),
      false,
      `${format}: persisted resolver must preserve lexical shadowing`,
    );
    assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 1, format);
    graph.close();
  }
});

test("generic call syntax resolves the underlying C++ and Rust callable", async () => {
  const fixtures = [
    ["cpp", "template<class T> void helper() {} void run() { helper<int>(); }"],
    ["rust", "fn helper<T>() {} fn run() { helper::<u32>(); }"],
  ];
  for (const [format, text] of fixtures) {
    const file = { ...codeFile(`generic.${format}`), format };
    const source = { kind: "text", file, text };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    const run = input.nodes.find((node) => node.name === "run");
    const helper = input.nodes.find((node) => node.name === "helper");
    assert.ok(run && helper, format);
    assert.ok(
      input.edges.some(
        (edge) =>
          edge.kind === "CALLS" &&
          edge.src === run.id &&
          edge.dst === helper.id,
      ),
      `${format}: generic arguments must not become part of the lookup name`,
    );
  }
});

test("a lexical callback remains a dynamic boundary without a global namesake", async () => {
  const file = codeFile("callback.ts");
  const text = "function invoke(callback: () => void) { callback(); }";
  const source = { kind: "text", file, text };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();
  assert.equal(graph.stats().failedRefCount, 0);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.equal(boundary?.reason, "lexical_dispatch");
  graph.close();
});

test("computed member calls retain an explicit runtime dispatch boundary", async () => {
  const file = codeFile("computed-dispatch.ts");
  const source = {
    kind: "text",
    file,
    text: `function route(table: Record<string, (value: unknown) => void>, value: unknown) {
  table["save"](value);
}`,
  };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const route = input.nodes.find((node) => node.name === "route");
  assert.ok(route);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  const boundary = graph.dynamicBoundaries([route.id], 10)[0];
  assert.equal(boundary?.reason, "runtime_dispatch");
  assert.deepEqual(boundary?.target.hints?.dynamicDispatch, {
    form: "computed_member",
    key: "save",
  });
  graph.close();
});

test("Python getattr calls retain runtime-key uncertainty", async () => {
  const file = { ...codeFile("dynamic.py"), format: "python" };
  const source = {
    kind: "text",
    file,
    text: "def route(target, name, value):\n    return getattr(target, name)(value)\n",
  };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const route = input.nodes.find((node) => node.name === "route");
  assert.ok(route);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  const boundary = graph.dynamicBoundaries([route.id], 10)[0];
  assert.equal(boundary?.reason, "runtime_dispatch");
  assert.deepEqual(boundary?.target.hints?.dynamicDispatch, {
    form: "getattr",
  });
  graph.close();
});

test("Python assigned getattr call retains its scoped dynamic binding", async () => {
  const file = { ...codeFile("assigned-dynamic.py"), format: "python" };
  const source = {
    kind: "text",
    file,
    text: `def route(target, kind, value):
    handler = getattr(target, "handle_" + kind)
    return handler(value)
`,
  };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const route = input.nodes.find((node) => node.name === "route");
  assert.ok(route);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  const boundaries = graph.dynamicBoundaries([route.id], 10);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0]?.reason, "runtime_dispatch");
  assert.deepEqual(boundaries[0]?.target.hints?.dynamicDispatch, {
    form: "getattr",
    key: "handle_",
  });
  graph.close();
});

test("Python reassignment clears an earlier dynamic callable binding", async () => {
  const file = { ...codeFile("reassigned-dynamic.py"), format: "python" };
  const source = {
    kind: "text",
    file,
    text: `def route(target, fallback, value):
    handler = getattr(target, "save")
    handler = fallback
    return handler(value)
`,
  };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const route = input.nodes.find((node) => node.name === "route");
  assert.ok(route);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  assert.equal(
    graph
      .dynamicBoundaries([route.id], 10)
      .some((boundary) => boundary.reason === "runtime_dispatch"),
    false,
  );
  graph.close();
});

test("Java reflection retains one structured runtime dispatch boundary", async () => {
  const file = { ...codeFile("Reflective.java"), format: "java" };
  const source = {
    kind: "text",
    file,
    text: `class Reflective {
  void route(Object target) throws Exception {
    target.getClass().getMethod("save").invoke(target);
  }
}`,
  };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const route = input.nodes.find((node) => node.name === "route");
  assert.ok(route);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  const boundaries = graph.dynamicBoundaries([route.id], 10);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0]?.reason, "runtime_dispatch");
  assert.deepEqual(boundaries[0]?.target.hints?.dynamicDispatch, {
    form: "reflection",
    key: "save",
  });
  graph.close();
});

test("qualified builtin calls do not fall back to a local bare name", async () => {
  const file = codeFile("qualified-builtin.ts");
  const source = {
    kind: "text",
    file,
    text: `
export function log() { return 1; }
export function run() { console.log("external"); }
`,
  };
  const fragments = await new CodeExtractor().extract(source);
  const graphInput = await extractFileGraph(source, fragments);
  const log = graphInput.nodes.find((node) => node.name === "log");
  const run = graphInput.nodes.find((node) => node.name === "run");
  assert.ok(log && run);
  assert.equal(
    graphInput.edges.some(
      (edge) =>
        edge.kind === "CALLS" && edge.src === run.id && edge.dst === log.id,
    ),
    false,
  );
  assert.equal(
    graphInput.refs.some((ref) => ref.ref_name === "console.log"),
    false,
  );
});

for (const fixture of [
  {
    name: "TypeScript this receiver",
    path: "this-call.ts",
    format: "typescript",
    text: `class Demo {
  helper() { return 1; }
  run() { return this.helper(); }
}`,
  },
  {
    name: "Python self receiver",
    path: "self_call.py",
    format: "python",
    text: `class Demo:
    def helper(self):
        return 1
    def run(self):
        return self.helper()
`,
  },
]) {
  test(`${fixture.name} resolves to the local method`, async () => {
    const file = { ...codeFile(fixture.path), format: fixture.format };
    const source = { kind: "text", file, text: fixture.text };
    const fragments = await new CodeExtractor().extract(source);
    const graphInput = await extractFileGraph(source, fragments);
    const helper = graphInput.nodes.find((node) => node.name === "helper");
    const run = graphInput.nodes.find((node) => node.name === "run");
    assert.ok(helper && run);
    assert.ok(
      graphInput.edges.some(
        (edge) =>
          edge.kind === "CALLS" &&
          edge.src === run.id &&
          edge.dst === helper.id,
      ),
    );
  });
}

test("language-aware pending refs resolve cross-file builtin names", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const callerFile = { ...codeFile("caller.ts"), id: "caller-file" };
  const targetFile = { ...codeFile("target.ts"), id: "target-file" };
  const callerSource = {
    kind: "text",
    file: callerFile,
    text: `export function run() { return map(); }`,
  };
  const targetSource = {
    kind: "text",
    file: targetFile,
    text: `export function map() { return 1; }`,
  };
  const callerInput = await extractFileGraph(
    callerSource,
    await new CodeExtractor().extract(callerSource),
  );
  const targetInput = await extractFileGraph(
    targetSource,
    await new CodeExtractor().extract(targetSource),
  );
  graph.upsertFileGraph(
    callerFile.id,
    callerInput.nodes,
    callerInput.edges,
    callerInput.refs,
  );
  graph.upsertFileGraph(
    targetFile.id,
    targetInput.nodes,
    targetInput.edges,
    targetInput.refs,
  );
  await graph.resolvePending();

  const run = callerInput.nodes.find((node) => node.name === "run");
  const map = targetInput.nodes.find((node) => node.name === "map");
  assert.ok(run && map);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((item) => item.id),
    [map.id],
  );
  graph.close();
});

test("extractFileGraph resolves cross-file calls after second file indexed", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });

  const aFile = {
    ...codeFile("a.ts"),
    id: "file-a",
    absolutePath: "/repo/a.ts",
    relativePath: "a.ts",
  };
  const bFile = {
    ...codeFile("b.ts"),
    id: "file-b",
    absolutePath: "/repo/b.ts",
    relativePath: "b.ts",
  };

  const aSource = {
    kind: "text",
    file: aFile,
    text: `export function caller() { target(); target(); }\n`,
  };
  const bSource = {
    kind: "text",
    file: bFile,
    text: `export function target() { return 1; }\n`,
  };

  const aFrags = await new CodeExtractor().extract(aSource);
  const bFrags = await new CodeExtractor().extract(bSource);
  const aGraph = await extractFileGraph(aSource, aFrags);
  const bGraph = await extractFileGraph(bSource, bFrags);

  assert.equal(aGraph.refs.filter((r) => r.ref_name === "target").length, 2);

  graph.upsertFileGraph(aFile.id, aGraph.nodes, aGraph.edges, aGraph.refs);
  graph.upsertFileGraph(bFile.id, bGraph.nodes, bGraph.edges, bGraph.refs);
  await graph.resolvePending();

  const caller = aGraph.nodes.find((n) => n.name === "caller");
  const target = bGraph.nodes.find((n) => n.name === "target");
  assert.ok(caller && target);
  assert.deepEqual(
    graph.callees(caller.id, 1, 10).map((s) => s.id),
    [target.id],
  );
  assert.equal(graph.callees(caller.id, 1, 10)[0].count, 2);
  graph.close();
});

for (const format of ["c", "cpp"]) {
  test(`${format} include-root imports constrain cross-file call resolution`, async () => {
    const graph = new SqliteGraphStorage("", { inMemory: true });
    const extension = format === "c" ? "c" : "cc";
    const callerFile = {
      ...codeFile(`src/app.${extension}`),
      id: `${format}-include-caller`,
      format,
      absolutePath: `/repo/src/app.${extension}`,
      relativePath: `src/app.${extension}`,
    };
    const targetFile = {
      ...codeFile("include/project/api/helper.h"),
      id: `${format}-include-target`,
      format,
      absolutePath: "/repo/include/project/api/helper.h",
      relativePath: "include/project/api/helper.h",
    };
    const decoyFile = {
      ...codeFile("src/other.cc"),
      id: `${format}-include-decoy`,
      format,
      absolutePath: "/repo/src/other.cc",
      relativePath: "src/other.cc",
    };
    const callerSource = {
      kind: "text",
      file: callerFile,
      text: '#include "project/api/helper.h"\nvoid run_include_root() { project_helper(); }\n',
    };
    const targetSource = {
      kind: "text",
      file: targetFile,
      text: "void project_helper();\n",
    };
    const decoySource = {
      kind: "text",
      file: decoyFile,
      text: "void project_helper() {}\n",
    };
    const inputs = [];
    for (const source of [callerSource, targetSource, decoySource]) {
      const fragments = await new CodeExtractor().extract(source);
      const input = await extractFileGraph(source, fragments);
      inputs.push(input);
      graph.upsertFileGraph(
        source.file.id,
        input.nodes,
        input.edges,
        input.refs,
      );
    }
    await graph.resolvePending({
      files: [callerFile, targetFile, decoyFile],
    });

    const caller = inputs[0].nodes.find(
      (node) => node.name === "run_include_root",
    );
    const target = inputs[1].nodes.find(
      (node) => node.name === "project_helper",
    );
    const decoy = inputs[2].nodes.find(
      (node) => node.name === "project_helper",
    );
    assert.ok(caller && target && decoy);
    const callees = graph.callees(caller.id, 1, 10).map((node) => node.id);
    assert.ok(callees.includes(target.id));
    assert.equal(callees.includes(decoy.id), false);
    graph.close();
  });
}

for (const fixture of [
  {
    name: "TypeScript import alias",
    format: "typescript",
    callerPath: "caller.ts",
    targetPath: "codec.ts",
    callerText:
      'import { decode as parse } from "./codec";\nexport function run() { parse(); }\n',
    targetText: "export function decode() { return 1; }\n",
  },
  {
    name: "Python import alias",
    format: "python",
    callerPath: "caller.py",
    targetPath: "codec.py",
    callerText: "from .codec import decode as parse\ndef run():\n    parse()\n",
    targetText: "def decode():\n    return 1\n",
  },
  {
    name: "TypeScript namespace import",
    format: "typescript",
    callerPath: "namespace-caller.ts",
    targetPath: "codec.ts",
    callerText:
      'import * as utils from "./codec";\nexport function run() { utils.decode(); }\n',
    targetText: "export function decode() { return 1; }\n",
  },
]) {
  test(`${fixture.name} resolves calls to the exported symbol`, async () => {
    const callerFile = {
      ...codeFile(fixture.callerPath),
      id: `caller-${fixture.format}`,
      format: fixture.format,
      absolutePath: `/repo/${fixture.callerPath}`,
    };
    const targetFile = {
      ...codeFile(fixture.targetPath),
      id: `target-${fixture.format}`,
      format: fixture.format,
      absolutePath: `/repo/${fixture.targetPath}`,
    };
    const callerSource = {
      kind: "text",
      file: callerFile,
      text: fixture.callerText,
    };
    const targetSource = {
      kind: "text",
      file: targetFile,
      text: fixture.targetText,
    };
    const extractor = new CodeExtractor();
    const callerGraph = await extractFileGraph(
      callerSource,
      await extractor.extract(callerSource),
    );
    const targetGraph = await extractFileGraph(
      targetSource,
      await extractor.extract(targetSource),
    );
    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(
      callerFile.id,
      callerGraph.nodes,
      callerGraph.edges,
      callerGraph.refs,
    );
    graph.upsertFileGraph(
      targetFile.id,
      targetGraph.nodes,
      targetGraph.edges,
      targetGraph.refs,
    );
    await graph.resolvePending({ files: [callerFile, targetFile] });

    const caller = callerGraph.nodes.find((node) => node.name === "run");
    const target = targetGraph.nodes.find((node) => node.name === "decode");
    assert.ok(caller && target);
    assert.deepEqual(
      graph.callees(caller.id, 1, 10).map((item) => item.id),
      [target.id],
    );

    graph.deleteFileGraph(targetFile.id);
    graph.upsertFileGraph(
      targetFile.id,
      targetGraph.nodes,
      targetGraph.edges,
      targetGraph.refs,
    );
    await graph.resolvePending({ files: [callerFile, targetFile] });
    assert.deepEqual(
      graph.expandFileNeighbors([callerFile.id], 10).map((item) => item.id),
      [targetFile.id],
    );
    assert.deepEqual(
      graph.callees(caller.id, 1, 10).map((item) => item.id),
      [target.id],
    );
    graph.close();
  });
}

test("named import receiver calls resolve to the imported member", async () => {
  const callerFile = {
    ...codeFile("caller.ts"),
    id: "named-import-caller",
  };
  const targetFile = {
    ...codeFile("codec.ts"),
    id: "named-import-target",
  };
  const callerSource = {
    kind: "text",
    file: callerFile,
    text: `import { Demo } from "./codec";
export function run() { return Demo.helper(); }`,
  };
  const targetSource = {
    kind: "text",
    file: targetFile,
    text: `export class Demo { static helper() { return 1; } }`,
  };
  const extractor = new CodeExtractor();
  const callerInput = await extractFileGraph(
    callerSource,
    await extractor.extract(callerSource),
  );
  const targetInput = await extractFileGraph(
    targetSource,
    await extractor.extract(targetSource),
  );
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    callerFile.id,
    callerInput.nodes,
    callerInput.edges,
    callerInput.refs,
  );
  graph.upsertFileGraph(
    targetFile.id,
    targetInput.nodes,
    targetInput.edges,
    targetInput.refs,
  );
  await graph.resolvePending({ files: [callerFile, targetFile] });

  const run = callerInput.nodes.find((node) => node.name === "run");
  const demo = targetInput.nodes.find((node) => node.name === "Demo");
  const helper = targetInput.nodes.find((node) => node.name === "helper");
  assert.ok(run && demo && helper);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((item) => item.id),
    [helper.id],
  );
  assert.notEqual(helper.id, demo.id);
  graph.close();
});

test("receiver calls use the owning or explicitly named container", async () => {
  const file = codeFile("scoped-receivers.ts");
  const source = {
    kind: "text",
    file,
    text: `class First {
  helper() { return 1; }
  run() { return this.helper(); }
}
class Demo {
  static helper() { return 2; }
}
class Second {
  helper() { return 3; }
  run() { return Demo.helper(); }
}`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const nodesByName = (name) =>
    input.nodes.filter((node) => node.name === name);
  const helpers = nodesByName("helper");
  const runs = nodesByName("run");
  assert.equal(helpers.length, 3);
  assert.equal(runs.length, 2);

  const contains = input.edges.filter((edge) => edge.kind === "CONTAINS");
  const containerFor = (id) =>
    input.nodes.find(
      (node) => contains.find((edge) => edge.dst === id)?.src === node.id,
    )?.name;
  const callTargetFor = (id) =>
    input.edges.find((edge) => edge.kind === "CALLS" && edge.src === id)?.dst;
  const firstRun = runs.find((node) => containerFor(node.id) === "First");
  const secondRun = runs.find((node) => containerFor(node.id) === "Second");
  const firstHelper = helpers.find((node) => containerFor(node.id) === "First");
  const demoHelper = helpers.find((node) => containerFor(node.id) === "Demo");
  assert.ok(firstRun && secondRun && firstHelper && demoHelper);
  assert.equal(callTargetFor(firstRun.id), firstHelper.id);
  assert.equal(callTargetFor(secondRun.id), demoHelper.id);
});

test("owner receivers resolve through the inheritance chain", async () => {
  const file = codeFile("inherited-receivers.ts");
  const source = {
    kind: "text",
    file,
    text: `class Base {
  helper() { return 1; }
}
class ChildWithoutOverride extends Base {
  run() { return this.helper(); }
}
class ChildWithOverride extends Base {
  helper() { return super.helper(); }
  other() { return super.helper(); }
  own() { return this.helper(); }
}`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const contains = input.edges.filter((edge) => edge.kind === "CONTAINS");
  const containerFor = (id) =>
    input.nodes.find(
      (node) => contains.find((edge) => edge.dst === id)?.src === node.id,
    )?.name;
  const findMember = (container, name) =>
    input.nodes.find(
      (node) => node.name === name && containerFor(node.id) === container,
    );
  const baseHelper = findMember("Base", "helper");
  const inheritedRun = findMember("ChildWithoutOverride", "run");
  const overridingHelper = findMember("ChildWithOverride", "helper");
  const other = findMember("ChildWithOverride", "other");
  const own = findMember("ChildWithOverride", "own");
  assert.ok(baseHelper && inheritedRun && overridingHelper && other && own);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();
  for (const caller of [inheritedRun, overridingHelper, other]) {
    assert.deepEqual(
      graph.callees(caller.id, 1, 10).map((item) => item.id),
      [baseHelper.id],
    );
  }
  assert.deepEqual(
    graph.callees(own.id, 1, 10).map((item) => item.id),
    [overridingHelper.id],
  );
  assert.equal(
    graph
      .callees(overridingHelper.id, 1, 10)
      .some((item) => item.id === overridingHelper.id),
    false,
  );
  graph.close();
});

for (const fixture of [
  {
    name: "Python super()",
    format: "python",
    path: "super_call.py",
    base: "Base",
    child: "Child",
    caller: "helper",
    text: `class Base:
    def helper(self):
        return 1

class Child(Base):
    def helper(self):
        return super().helper()
`,
  },
  {
    name: "Java this with interface default method",
    format: "java",
    path: "InheritedCall.java",
    base: "Base",
    child: "Child",
    caller: "run",
    text: `interface Base {
  default int helper() { return 1; }
}
class Child implements Base {
  int run() { return this.helper(); }
}`,
  },
  {
    name: "JavaScript super",
    format: "javascript",
    path: "super-call.js",
    base: "Base",
    child: "Child",
    caller: "run",
    text: `class Base {
  helper() { return 1; }
}
class Child extends Base {
  run() { return super.helper(); }
}`,
  },
  {
    name: "C++ this pointer",
    format: "cpp",
    path: "inherited_call.cpp",
    base: "Base",
    child: "Child",
    caller: "run",
    text: `class Base {
 public:
  int helper() { return 1; }
};
class Child : public Base {
 public:
  int run() { return this->helper(); }
};`,
  },
]) {
  test(`${fixture.name} preserves receiver and resolves inherited method`, async () => {
    const file = {
      ...codeFile(fixture.path),
      format: fixture.format,
    };
    const source = { kind: "text", file, text: fixture.text };
    const input = await extractFileGraph(
      source,
      await new CodeExtractor().extract(source),
    );
    const contains = input.edges.filter((edge) => edge.kind === "CONTAINS");
    const containerFor = (id) =>
      input.nodes.find(
        (node) => contains.find((edge) => edge.dst === id)?.src === node.id,
      )?.name;
    const member = (container, name) =>
      input.nodes.find(
        (node) => node.name === name && containerFor(node.id) === container,
      );
    const target = member(fixture.base, "helper");
    const caller = member(fixture.child, fixture.caller);
    assert.ok(target && caller);

    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
    await graph.resolvePending();
    assert.deepEqual(
      graph.callees(caller.id, 1, 10).map((item) => item.id),
      [target.id],
    );
    graph.close();
  });
}

test("C++ destructor calls remain owned by the destructor symbol", async () => {
  const file = { ...codeFile("neug_db.cc"), format: "cpp" };
  const source = {
    kind: "text",
    file,
    text: `class NeugDB { public: ~NeugDB(); void Close(); };
NeugDB::~NeugDB() { Close(); }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const destructor = input.nodes.find((node) =>
    node.signature?.startsWith("NeugDB::~NeugDB"),
  );
  const close = input.nodes.find((node) => node.name === "Close");
  assert.ok(destructor && close);
  assert.equal(destructor.qualifiedName, "NeugDB::~NeugDB");
  assert.equal(close.qualifiedName, "NeugDB::Close");
  assert.ok(
    input.edges.some(
      (edge) =>
        edge.kind === "CALLS" &&
        edge.src === destructor.id &&
        edge.dst === close.id,
    ),
  );
});

test("C++ out-of-line methods do not use a same-named constructor as their container", async () => {
  const file = { ...codeFile("catalog.cc"), format: "cpp" };
  const source = {
    kind: "text",
    file,
    text: `Catalog::Catalog() { initialize(); }
void Catalog::initialize() {}
void Catalog::refresh() { initialize(); }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const constructor = input.nodes.find(
    (node) => node.qualifiedName === "Catalog::Catalog",
  );
  assert.ok(constructor);
  assert.equal(
    input.edges.some(
      (edge) => edge.kind === "CONTAINS" && edge.src === constructor.id,
    ),
    false,
  );
});

test("C++ out-of-line methods resolve field receivers from indexed headers", async () => {
  const root = mkdtempSync(join(tmpdir(), "zvec-cpp-field-call-"));
  try {
    const headerPath = join(root, "include", "service.h");
    const sourcePath = join(root, "src", "service.cc");
    mkdirSync(join(root, "include"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    const headerText = `class NeugDB { public: bool IsClosed() const; };
class Service { NeugDB& db_; public: void check(); };`;
    const sourceText = `void Service::check() { db_->IsClosed(); }`;
    writeFileSync(headerPath, headerText);
    writeFileSync(sourcePath, sourceText);
    const headerFile = {
      ...codeFile("include/service.h"),
      id: "header",
      absolutePath: headerPath,
      rootPath: root,
      sizeBytes: headerText.length,
      format: "cpp",
    };
    const sourceFile = {
      ...codeFile("src/service.cc"),
      id: "source",
      absolutePath: sourcePath,
      rootPath: root,
      sizeBytes: sourceText.length,
      format: "cpp",
    };
    const headerSource = { kind: "text", file: headerFile, text: headerText };
    const implementationSource = {
      kind: "text",
      file: sourceFile,
      text: sourceText,
    };
    const header = await extractFileGraph(
      headerSource,
      await new CodeExtractor().extract(headerSource),
    );
    const implementation = await extractFileGraph(
      implementationSource,
      await new CodeExtractor().extract(implementationSource),
    );
    assert.equal(
      header.nodes.some((node) => node.name === "db_"),
      false,
      "C++ fields must not expand the graph symbol set",
    );
    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(
      headerFile.id,
      header.nodes,
      header.edges,
      header.refs,
    );
    graph.upsertFileGraph(
      sourceFile.id,
      implementation.nodes,
      implementation.edges,
      implementation.refs,
    );
    await graph.resolvePending({ files: [headerFile, sourceFile] });
    const caller = implementation.nodes.find(
      (node) => node.qualifiedName === "Service::check",
    );
    const callee = header.nodes.find(
      (node) => node.qualifiedName === "NeugDB::IsClosed",
    );
    assert.ok(caller && callee);
    assert.deepEqual(
      graph.callees(caller.id, 1, 10).map((node) => node.id),
      [callee.id],
    );
    graph.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CONTAINS uses :: scope breadcrumbs", async () => {
  const file = codeFile("cls.ts");
  const source = {
    kind: "text",
    file,
    text: `
export class Foo {
  bar() {
    return 1;
  }
}
`,
  };
  const fragments = await new CodeExtractor().extract(source);
  const method = fragments.find(
    (f) => f.metadata?.kind === "code" && f.metadata.symbolName === "bar",
  );
  assert.ok(method);
  assert.equal(method.metadata.scope, "Foo");

  const graphInput = await extractFileGraph(source, fragments);
  const contains = graphInput.edges.filter((e) => e.kind === "CONTAINS");
  assert.equal(contains.length, 1);
});

test("Go interface dispatch exposes implementation candidates as a dynamic boundary", async () => {
  const file = { ...codeFile("dispatch.go"), format: "go" };
  const source = {
    kind: "text",
    file,
    text: `package p
type Runner interface { Run() }
type Alpha struct{}
func (Alpha) Run() {}
type Beta struct{}
func (Beta) Run() {}
func invoke[T Runner](value T) { value.Run() }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();

  const boundaries = graph.dynamicBoundaries([invoke.id], 10);
  assert.equal(
    boundaries.length,
    1,
    JSON.stringify({
      nodes: input.nodes,
      edges: input.edges,
      refs: input.refs,
      callees: graph.callees(invoke.id, 1, 10),
      stats: graph.stats(),
    }),
  );
  assert.equal(boundaries[0].reason, "polymorphic_dispatch");
  assert.deepEqual(boundaries[0].target.hints, {
    receiverType: "T",
    callArity: 0,
    candidateTypes: ["T", "Runner"],
    genericBounds: ["Runner"],
    dispatch: "interface",
  });
  const candidateNames = boundaries[0].candidates
    .map((id) => input.nodes.find((node) => node.id === id)?.name)
    .filter(Boolean);
  assert.deepEqual(candidateNames, ["Run", "Run"]);
  assert.equal(graph.stats().refCount, 0);
  assert.equal(graph.stats().pendingRefCount, 0);
  assert.equal(graph.stats().failedRefCount, 0);
  assert.equal(graph.stats().dynamicBoundaryCount, 1);
  assert.equal(boundaries[0].candidateDetails.length, 2);
  await graph.resolvePending();
  assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 1);
  graph.close();
});

test("Python abstract declarations are not runtime dispatch candidates", async () => {
  const file = { ...codeFile("dispatch.py"), format: "python" };
  const source = {
    kind: "text",
    file,
    text: `from abc import ABC
class Runner(ABC):
    def run(self): raise NotImplementedError
class Alpha(Runner):
    def run(self): return 1
class Beta(Runner):
    def run(self): return 2
def invoke(value: Runner):
    return value.run()
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();

  const boundaries = graph.dynamicBoundaries([invoke.id], 10);
  assert.equal(boundaries.length, 1);
  const candidateNames = boundaries[0].candidates.map((id) => {
    const candidate = input.nodes.find((node) => node.id === id);
    return candidate ? `${candidate.scope}::${candidate.name}` : id;
  });
  assert.deepEqual(candidateNames, ["Alpha::run", "Beta::run"]);
  assert.equal(candidateNames.includes("Runner::run"), false);
  graph.close();
});

test("Go concrete receiver type resolves a method call in its container", async () => {
  const file = { ...codeFile("receiver.go"), format: "go" };
  const source = {
    kind: "text",
    file,
    text: `package p
type Worker struct{}
func (worker Worker) helper() {}
func (worker Worker) run() { worker.helper() }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const run = input.nodes.find((node) => node.name === "run");
  const helper = input.nodes.find((node) => node.name === "helper");
  assert.ok(run && helper);
  assert.ok(
    input.edges.some(
      (edge) =>
        edge.kind === "CALLS" && edge.src === run.id && edge.dst === helper.id,
    ),
  );
});

test("Go field-chain receivers use the declaring struct field type", async () => {
  const file = { ...codeFile("field-chain.go"), format: "go" };
  const source = {
    kind: "text",
    file,
    text: `package flow
import "database/sql"
type InternalStore interface { Exec(string, ...any) (sql.Result, error) }
type Target struct { conn *sql.DB }
func (target *Target) Write() error {
  _, err := target.conn.Exec("insert")
  return err
}
type Store struct{}
func (store *Store) Put(key string) {}
type Repo struct { db *Store }
func (repo *Repo) Save() { repo.db.Put("key") }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const write = input.nodes.find((node) => node.name === "Write");
  const save = input.nodes.find((node) => node.name === "Save");
  const put = input.nodes.find(
    (node) => node.name === "Put" && node.qualifiedName === "Store::Put",
  );
  const decoyExec = input.nodes.find(
    (node) =>
      node.name === "Exec" && node.qualifiedName === "InternalStore::Exec",
  );
  assert.ok(write && save && put && decoyExec);
  const externalCall = input.refs.find(
    (ref) =>
      ref.type === "symbol" &&
      ref.owner === write.id &&
      ref.ref_kind === "call" &&
      ref.target.member === "Exec",
  );
  assert.equal(externalCall?.target.hints?.receiverType, "sql.DB");

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  assert.ok(
    graph.callees(save.id, 1, 10).some((candidate) => candidate.id === put.id),
    "the in-project Repo.db field must resolve to Store.Put",
  );
  assert.equal(
    graph
      .callees(write.id, 1, 10)
      .some((candidate) => candidate.id === decoyExec.id),
    false,
    "the external sql.DB field must not bind to a local same-name method",
  );
  graph.close();
});

test("Go chained factory calls use the declared return type", async () => {
  const file = { ...codeFile("factory-chain.go"), format: "go" };
  const source = {
    kind: "text",
    file,
    text: `package flow
type Decoy struct{}
func (*Decoy) Build() {}
type Product struct{}
func NewProduct() *Product { return &Product{} }
func WithProduct(value int) (*Product, error) { return &Product{}, nil }
func (*Product) Build() {}
func buildOne() { NewProduct().Build() }
func buildTwo() { WithProduct(1).Build() }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const productBuild = input.nodes.find(
    (node) => node.name === "Build" && node.qualifiedName === "Product::Build",
  );
  const decoyBuild = input.nodes.find(
    (node) => node.name === "Build" && node.qualifiedName === "Decoy::Build",
  );
  const buildOne = input.nodes.find((node) => node.name === "buildOne");
  const buildTwo = input.nodes.find((node) => node.name === "buildTwo");
  assert.ok(productBuild && decoyBuild && buildOne && buildTwo);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  for (const caller of [buildOne, buildTwo]) {
    const callees = graph.callees(caller.id, 1, 10).map((item) => item.id);
    assert.ok(callees.includes(productBuild.id));
    assert.equal(callees.includes(decoyBuild.id), false);
  }
  graph.close();
});

test("Go chained factory calls resolve methods promoted by embedded structs", async () => {
  const file = { ...codeFile("factory-embedded.go"), format: "go" };
  const source = {
    kind: "text",
    file,
    text: `package flow
type Base struct{}
func (*Base) Embedded() {}
type Decoy struct{}
func (*Decoy) Embedded() {}
type Widget struct { Base }
func NewWidget() *Widget { return &Widget{} }
func invoke() { NewWidget().Embedded() }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const baseMethod = input.nodes.find(
    (node) =>
      node.name === "Embedded" && node.qualifiedName === "Base::Embedded",
  );
  const decoyMethod = input.nodes.find(
    (node) =>
      node.name === "Embedded" && node.qualifiedName === "Decoy::Embedded",
  );
  assert.ok(invoke && baseMethod && decoyMethod);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  const callees = graph.callees(invoke.id, 1, 10).map((item) => item.id);
  assert.ok(callees.includes(baseMethod.id));
  assert.equal(callees.includes(decoyMethod.id), false);
  graph.close();
});

test("constructor and associated factory chains retain their produced owner type", async () => {
  const scenarios = [
    {
      format: "java",
      source:
        "class Alpha { void Finish() {} } class Beta { void Finish() {} } class InvokeOwner { void Invoke() { new Alpha().Finish(); } }",
      expected: "Alpha::Finish",
      decoy: "Beta::Finish",
    },
    {
      format: "rust",
      source:
        "struct Alpha; impl Alpha { fn new() -> Self { Alpha } fn Finish(&self) {} } struct Beta; impl Beta { fn new() -> Self { Beta } fn Finish(&self) {} } fn Invoke() { Alpha::new().Finish(); }",
      expected: "Alpha::Finish",
      decoy: "Beta::Finish",
    },
    {
      format: "python",
      source:
        "class Alpha:\n    def Finish(self): return 1\nclass Beta:\n    def Finish(self): return 2\ndef Invoke():\n    value = Alpha()\n    return value.Finish()\n",
      expected: "Alpha::Finish",
      decoy: "Beta::Finish",
    },
    {
      format: "python",
      source:
        "def endpoint(fn): return fn\nclass Alpha:\n    def Finish(self): return 1\nclass Beta:\n    def Finish(self): return 2\n@endpoint\ndef Invoke(value: Alpha):\n    return value.Finish()\n",
      expected: "Alpha::Finish",
      decoy: "Beta::Finish",
    },
  ];

  for (const scenario of scenarios) {
    const file = {
      ...codeFile(`factory-owner.${scenario.format}`),
      format: scenario.format,
    };
    const source = { kind: "text", file, text: scenario.source };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    const invoke = input.nodes.find((node) => node.name === "Invoke");
    const expected = input.nodes.find(
      (node) => node.qualifiedName === scenario.expected,
    );
    const decoy = input.nodes.find(
      (node) => node.qualifiedName === scenario.decoy,
    );
    assert.ok(invoke && expected && decoy, scenario.format);

    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
    await graph.resolvePending({ files: [file] });
    const callees = graph.callees(invoke.id, 1, 20).map((item) => item.id);
    assert.ok(callees.includes(expected.id), scenario.format);
    assert.equal(callees.includes(decoy.id), false, scenario.format);
    graph.close();
  }
});

test("factory assignment inference distinguishes Go NewType convention from arbitrary calls", async () => {
  const goFile = { ...codeFile("factory-convention.go"), format: "go" };
  const goSource = {
    kind: "text",
    file: goFile,
    text: `package main
import "example/chi"
func Invoke() {
  router := chi.NewRouter()
  router.Use()
}
`,
  };
  const goAnalysis = await new CodeExtractor().analyzeForIndexing(goSource);
  const goInput = await extractFileGraph(
    goSource,
    goAnalysis.fragments.map((item) => item.fragment),
    goAnalysis,
  );
  const useRef = goInput.refs.find(
    (ref) => ref.type === "symbol" && ref.target.member === "Use",
  );
  assert.equal(useRef?.target.hints?.receiverType, "Router");

  const tsFile = codeFile("factory-unknown.ts");
  const tsSource = {
    kind: "text",
    file: tsFile,
    text: `declare const sdk: any;
export function InvokeUnknown() {
  const value = sdk.Factory();
  value.Use();
}
`,
  };
  const tsAnalysis = await new CodeExtractor().analyzeForIndexing(tsSource);
  const tsInput = await extractFileGraph(
    tsSource,
    tsAnalysis.fragments.map((item) => item.fragment),
    tsAnalysis,
  );
  const unknownUse = tsInput.refs.find(
    (ref) => ref.type === "symbol" && ref.target.member === "Use",
  );
  assert.equal(unknownUse?.target.hints?.receiverType, undefined);
});

test("typed concrete receivers resolve methods inherited from their nearest base", async () => {
  const scenarios = [
    {
      format: "typescript",
      source:
        "class Base { Run() {} } class Child extends Base {} class Decoy { Run() {} } function Invoke(value: Child) { value.Run(); }",
    },
    {
      format: "java",
      source:
        "class Base { void Run() {} } class Child extends Base {} class Decoy { void Run() {} } class Use { void Invoke(Child value) { value.Run(); } }",
    },
    {
      format: "cpp",
      source:
        "class Base { public: void Run() {} }; class Child : public Base {}; class Decoy { public: void Run() {} }; void Invoke(Child& value) { value.Run(); }",
    },
    {
      format: "python",
      source:
        "class Base:\n    def Run(self): return 1\nclass Child(Base): pass\nclass Decoy:\n    def Run(self): return 2\ndef Invoke(value: Child):\n    return value.Run()\n",
    },
  ];

  for (const scenario of scenarios) {
    const file = {
      ...codeFile(`inherited-provider.${scenario.format}`),
      format: scenario.format,
    };
    const source = { kind: "text", file, text: scenario.source };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    const invoke = input.nodes.find((node) => node.name === "Invoke");
    const expected = input.nodes.find(
      (node) => node.qualifiedName === "Base::Run",
    );
    const decoy = input.nodes.find(
      (node) => node.qualifiedName === "Decoy::Run",
    );
    assert.ok(invoke && expected && decoy, scenario.format);

    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
    await graph.resolvePending({ files: [file] });
    const callees = graph.callees(invoke.id, 1, 20).map((item) => item.id);
    assert.ok(callees.includes(expected.id), scenario.format);
    assert.equal(callees.includes(decoy.id), false, scenario.format);
    graph.close();
  }
});

test("generic impl fragments share one logical owner with their type declaration", async () => {
  const file = { ...codeFile("generic-router.rs"), format: "rust" };
  const source = {
    kind: "text",
    file,
    text: `struct Router<S>(S);
impl<S: Default> Router<S> {
  fn new() -> Self { Router(S::default()) }
  fn route(self, path: &str, value: u8) -> Self { self }
}
struct PathRouter;
impl PathRouter { fn route(self, path: &str, value: u8) -> Self { self } }
fn Invoke() { Router::<u8>::new().route("/", 1); }
`,
  };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const invoke = input.nodes.find((node) => node.name === "Invoke");
  const routerRoute = input.nodes.find(
    (node) =>
      node.name === "route" && node.qualifiedName?.startsWith("Router<"),
  );
  const decoyRoute = input.nodes.find(
    (node) => node.qualifiedName === "PathRouter::route",
  );
  assert.ok(invoke && routerRoute && decoyRoute);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  const callees = graph.callees(invoke.id, 1, 20).map((item) => item.id);
  assert.ok(callees.includes(routerRoute.id));
  assert.equal(callees.includes(decoyRoute.id), false);
  graph.close();
});

test("cross-file factory chains use return types without binding same-name decoys", async () => {
  const scenarios = [
    {
      format: "typescript",
      files: [
        [
          "product.ts",
          "export class Product { Build() {} } export class Decoy { Build() {}; OnlyOther() {} } export function Create(): Product { return new Product(); }",
        ],
        [
          "main.ts",
          'import { Create } from "./product"; export function Invoke() { Create().Build(); Create().OnlyOther(); }',
        ],
      ],
    },
    {
      format: "python",
      files: [
        [
          "product.py",
          "class Product:\n    def Build(self): pass\nclass Decoy:\n    def Build(self): pass\n    def OnlyOther(self): pass\ndef Create() -> Product:\n    return Product()\n",
        ],
        [
          "main.py",
          "from .product import Create\ndef Invoke():\n    Create().Build()\n    Create().OnlyOther()\n",
        ],
      ],
    },
    {
      format: "java",
      files: [
        [
          "Product.java",
          "class Product { void Build() {} static Product Create() { return new Product(); } } class Decoy { void Build() {} void OnlyOther() {} }",
        ],
        [
          "Main.java",
          "class Main { void Invoke() { Product.Create().Build(); Product.Create().OnlyOther(); } }",
        ],
      ],
    },
    {
      format: "cpp",
      files: [
        [
          "product.h",
          "class Product { public: void Build(); }; class Decoy { public: void Build(); void OnlyOther(); }; Product Create();",
        ],
        [
          "main.cpp",
          '#include "product.h"\nvoid Invoke() { Create().Build(); Create().OnlyOther(); }',
        ],
      ],
    },
    {
      format: "go",
      files: [
        [
          "product.go",
          "package fixture\ntype Product struct{}\nfunc (*Product) Build() {}\ntype Decoy struct{}\nfunc (*Decoy) Build() {}\nfunc (*Decoy) OnlyOther() {}\nfunc Create() *Product { return &Product{} }\n",
        ],
        [
          "main.go",
          "package fixture\nfunc Invoke() { Create().Build(); Create().OnlyOther() }\n",
        ],
      ],
    },
    {
      format: "rust",
      files: [
        [
          "product.rs",
          "pub struct Product; impl Product { pub fn Build(&self) {} } pub struct Decoy; impl Decoy { pub fn Build(&self) {} pub fn OnlyOther(&self) {} } pub fn Create() -> Product { Product }",
        ],
        [
          "lib.rs",
          "mod product; fn Invoke() { product::Create().Build(); product::Create().OnlyOther(); }",
        ],
      ],
    },
  ];

  for (const scenario of scenarios) {
    const graph = new SqliteGraphStorage("", { inMemory: true });
    const files = scenario.files.map(([relativePath], index) => ({
      ...codeFile(relativePath),
      id: `${scenario.format}-${index}`,
      format: scenario.format,
    }));
    const nodes = [];
    for (let index = 0; index < files.length; index++) {
      const source = {
        kind: "text",
        file: files[index],
        text: scenario.files[index][1],
      };
      const analysis = await new CodeExtractor().analyzeForIndexing(source);
      const input = await extractFileGraph(
        source,
        analysis.fragments.map((item) => item.fragment),
        analysis,
      );
      nodes.push(...input.nodes);
      graph.upsertFileGraph(
        files[index].id,
        input.nodes,
        input.edges,
        input.refs,
      );
    }
    await graph.resolvePending({ files });

    const invoke = nodes.find((node) => node.name === "Invoke");
    const productBuild = nodes.find(
      (node) => node.qualifiedName === "Product::Build",
    );
    const decoyBuild = nodes.find(
      (node) => node.qualifiedName === "Decoy::Build",
    );
    const onlyOther = nodes.find(
      (node) => node.qualifiedName === "Decoy::OnlyOther",
    );
    assert.ok(
      invoke && productBuild && decoyBuild && onlyOther,
      scenario.format,
    );
    const callees = graph.callees(invoke.id, 1, 20).map((item) => item.id);
    assert.ok(callees.includes(productBuild.id), scenario.format);
    assert.equal(callees.includes(decoyBuild.id), false, scenario.format);
    assert.equal(callees.includes(onlyOther.id), false, scenario.format);
    graph.close();
  }
});

test("Java FQN imports disambiguate same-name classes across packages", async () => {
  const files = [
    {
      ...codeFile("src/main/java/com/alpha/Service.java"),
      id: "alpha-service",
      format: "java",
    },
    {
      ...codeFile("src/main/java/com/beta/Service.java"),
      id: "beta-service",
      format: "java",
    },
    {
      ...codeFile("src/main/java/app/Main.java"),
      id: "java-main",
      format: "java",
    },
  ];
  const texts = [
    "package com.alpha; public class Service { public static void help() {} }",
    "package com.beta; public class Service { public static void help() {} }",
    "package app; import com.alpha.Service; class Main { void invoke() { Service.help(); } }",
  ];
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const inputs = [];
  for (let index = 0; index < files.length; index++) {
    const source = { kind: "text", file: files[index], text: texts[index] };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    inputs.push(input);
    graph.upsertFileGraph(
      files[index].id,
      input.nodes,
      input.edges,
      input.refs,
    );
  }
  await graph.resolvePending({ files });

  const alphaHelp = inputs[0].nodes.find((node) => node.name === "help");
  const betaHelp = inputs[1].nodes.find((node) => node.name === "help");
  const invoke = inputs[2].nodes.find((node) => node.name === "invoke");
  assert.ok(alphaHelp && betaHelp && invoke);
  const callees = graph.callees(invoke.id, 1, 10).map((item) => item.id);
  assert.ok(callees.includes(alphaHelp.id));
  assert.equal(callees.includes(betaHelp.id), false);
  graph.close();
});

test("Python package child-module imports resolve qualified calls without a decoy", async () => {
  const files = [
    { ...codeFile("src/pkg/__init__.py"), id: "pkg-init", format: "python" },
    { ...codeFile("src/pkg/util.py"), id: "pkg-util", format: "python" },
    {
      ...codeFile("src/other/util.py"),
      id: "other-util",
      format: "python",
    },
    { ...codeFile("src/app/main.py"), id: "python-main", format: "python" },
  ];
  const texts = [
    "",
    "def help():\n    return 1\n",
    "def help():\n    return 2\n",
    "from pkg import util\ndef invoke():\n    return util.help()\n",
  ];
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const inputs = [];
  for (let index = 0; index < files.length; index++) {
    const source = { kind: "text", file: files[index], text: texts[index] };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    inputs.push(input);
    graph.upsertFileGraph(
      files[index].id,
      input.nodes,
      input.edges,
      input.refs,
    );
  }
  await graph.resolvePending({ files });

  const packageHelp = inputs[1].nodes.find((node) => node.name === "help");
  const decoyHelp = inputs[2].nodes.find((node) => node.name === "help");
  const invoke = inputs[3].nodes.find((node) => node.name === "invoke");
  assert.ok(packageHelp && decoyHelp && invoke);
  const callees = graph.callees(invoke.id, 1, 10).map((item) => item.id);
  assert.ok(callees.includes(packageHelp.id));
  assert.equal(callees.includes(decoyHelp.id), false);
  graph.close();
});

test("Rust AST arity excludes self and preserves generic parameter grouping", async () => {
  const file = { ...codeFile("arity.rs"), format: "rust" };
  const source = {
    kind: "text",
    file,
    text: `use std::collections::HashMap;
struct Value;
impl Value {
  fn run(&self, values: HashMap<String, i32>) {}
}
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const run = input.nodes.find((node) => node.name === "run");
  assert.ok(run);
  assert.equal(run.arity, 1);
});

test("Python AST arity excludes self and preserves generic parameter grouping", async () => {
  const file = { ...codeFile("arity.py"), format: "python" };
  const source = {
    kind: "text",
    file,
    text: `class Value:
  def run(self, values: dict[str, int]):
    pass
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const run = input.nodes.find((node) => node.name === "run");
  assert.ok(run);
  assert.equal(run.arity, 1);
});

test("Rust trait dispatch owns impl methods and exposes implementations", async () => {
  const file = { ...codeFile("dispatch.rs"), format: "rust" };
  const source = {
    kind: "text",
    file,
    text: `trait Runner { fn run(&self); }
struct Alpha;
impl Runner for Alpha { fn run(&self) {} }
fn invoke(value: &dyn Runner) { value.run(); }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const runMethods = input.nodes.filter((node) => node.name === "run");
  assert.ok(invoke);
  assert.equal(runMethods.length, 2);
  assert.deepEqual(
    runMethods.map((node) => node.arity),
    [0, 0],
  );
  const alphaContainers = input.nodes.filter(
    (node) => node.name === "Alpha" && node.kind === "class",
  );
  assert.equal(alphaContainers.length, 2);
  const implContainer = alphaContainers.find((node) =>
    node.signature?.startsWith("impl "),
  );
  assert.ok(implContainer);
  const implRun = runMethods.find((node) =>
    input.edges.some(
      (edge) =>
        edge.kind === "CONTAINS" &&
        edge.src === implContainer.id &&
        edge.dst === node.id,
    ),
  );
  assert.ok(
    implRun,
    "the impl block, not the same-name struct, must own its method",
  );

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.ok(boundary.candidates.includes(implRun.id));
  graph.close();
});

test("this.field receiver uses the owner field type, not a later local", async () => {
  const file = { ...codeFile("OwnerField.ts"), format: "typescript" };
  const source = {
    kind: "text",
    file,
    text: `interface Runner { run(): void; }
interface Other { run(): void; }
declare function makeOther(): Other;
class Use {
  value: Runner;
  invoke() {
    this.value.run();
    { const value: Other = makeOther(); value.run(); }
  }
}`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const calls = input.refs.filter(
    (ref) =>
      ref.type === "symbol" &&
      ref.owner === invoke.id &&
      ref.target.member === "run",
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].target.receiver?.name, "this.value");
  assert.equal(calls[0].target.hints?.receiverType, "Runner");
  assert.equal(calls[1].target.hints?.receiverType, "Other");
});

test("JavaScript constructor assignments provide owner receiver types", async () => {
  const file = { ...codeFile("constructed-field.js"), format: "javascript" };
  const source = {
    kind: "text",
    file,
    text: `class Use {
  constructor() { this.client = new Client(); }
  invoke() { this.client.send(); }
}`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const call = input.refs.find(
    (ref) =>
      ref.type === "symbol" &&
      ref.owner === invoke?.id &&
      ref.target.member === "send",
  );
  assert.equal(call?.target.receiver?.name, "this.client");
  assert.equal(call?.target.hints?.receiverType, "Client");
});

test("Python constructor assignments provide owner receiver types", async () => {
  const file = { ...codeFile("constructed_field.py"), format: "python" };
  const source = {
    kind: "text",
    file,
    text: `class Use:
    def __init__(self):
        self.client = Client()

    def invoke(self):
        self.client.send()
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const call = input.refs.find(
    (ref) =>
      ref.type === "symbol" &&
      ref.owner === invoke?.id &&
      ref.target.member === "send",
  );
  assert.equal(call?.target.receiver?.name, "self.client");
  assert.equal(call?.target.hints?.receiverType, "Client");
});

test("Java this.field calls retain the declared owner field type", async () => {
  const file = { ...codeFile("OwnerController.java"), format: "java" };
  const source = {
    kind: "text",
    file,
    text: `class OwnerController {
  private final OwnerRepository owners;
  void save(Owner owner) { this.owners.save(owner); }
}`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const save = input.nodes.find((node) => node.name === "save");
  assert.ok(save);
  const call = input.refs.find(
    (ref) =>
      ref.type === "symbol" &&
      ref.owner === save.id &&
      ref.target.member === "save",
  );
  assert.equal(call?.target.receiver?.name, "this.owners");
  assert.equal(call?.target.hints?.receiverType, "OwnerRepository");
});

test("Rust qualified constructors do not fall back to an unrelated local new", async () => {
  const file = { ...codeFile("connection.rs"), format: "rust" };
  const source = {
    kind: "text",
    file,
    text: `struct Connection;
impl Connection {
  fn new() -> Connection { Connection }
  fn parse() { let cursor = Cursor::new(); }
}`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const parse = input.nodes.find((node) => node.name === "parse");
  const localNew = input.nodes.find((node) => node.name === "new");
  assert.ok(parse && localNew);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  assert.equal(
    graph
      .callees(parse.id, 1, 10)
      .some((candidate) => candidate.id === localNew.id),
    false,
  );
  graph.close();
});

test("C++ indexed collection receivers retain their element type", async () => {
  const file = { ...codeFile("pipeline.cc"), format: "cpp" };
  const source = {
    kind: "text",
    file,
    text: `class IOperator { public: virtual void Eval() = 0; };
class Pipeline {
  std::vector<std::unique_ptr<IOperator>> operators_;
 public:
  void Execute() { operators_[0]->Eval(); }
};`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const execute = input.nodes.find((node) => node.name === "Execute");
  const operator = input.nodes.find((node) => node.name === "IOperator");
  const abstractEval = input.nodes.find((node) => node.name === "Eval");
  assert.ok(execute);
  assert.equal(operator?.kind, "abstract_class");
  assert.equal(abstractEval?.kind, "abstract_method");
  const call = input.refs.find(
    (ref) =>
      ref.type === "symbol" &&
      ref.owner === execute.id &&
      ref.target.member === "Eval",
  );
  assert.equal(call?.target.receiver?.name, "operators_[0]");
  assert.equal(call?.target.hints?.receiverType, "IOperator");
  assert.deepEqual(call?.target.hints?.candidateTypes, ["IOperator"]);
});

test("C++ standard-library receiver types are external unless shadowed locally", async () => {
  const builtinFile = { ...codeFile("builtin-vector.cc"), format: "cpp" };
  const builtinSource = {
    kind: "text",
    file: builtinFile,
    text: `#include <vector>
using item_vector = std::vector<int>;
void append(item_vector& values) { values.push_back(1); }`,
  };
  const builtinInput = await extractFileGraph(
    builtinSource,
    await new CodeExtractor().extract(builtinSource),
  );
  const append = builtinInput.nodes.find((node) => node.name === "append");
  assert.ok(append);
  const builtinGraph = new SqliteGraphStorage("", { inMemory: true });
  builtinGraph.upsertFileGraph(
    builtinFile.id,
    builtinInput.nodes,
    builtinInput.edges,
    builtinInput.refs,
  );
  await builtinGraph.resolvePending({ files: [builtinFile] });
  assert.equal(builtinGraph.dynamicBoundaries([append.id], 10).length, 0);
  assert.equal(builtinGraph.callees(append.id, 1, 10).length, 0);
  builtinGraph.close();

  const localFile = { ...codeFile("local-vector.cc"), format: "cpp" };
  const localSource = {
    kind: "text",
    file: localFile,
    text: `class vector { public: void push_back(int value) {} };
void append(vector& values) { values.push_back(1); }`,
  };
  const localInput = await extractFileGraph(
    localSource,
    await new CodeExtractor().extract(localSource),
  );
  const localAppend = localInput.nodes.find((node) => node.name === "append");
  const pushBack = localInput.nodes.find((node) => node.name === "push_back");
  assert.ok(localAppend && pushBack);
  const localGraph = new SqliteGraphStorage("", { inMemory: true });
  localGraph.upsertFileGraph(
    localFile.id,
    localInput.nodes,
    localInput.edges,
    localInput.refs,
  );
  await localGraph.resolvePending({ files: [localFile] });
  assert.deepEqual(
    localGraph.callees(localAppend.id, 1, 10).map((item) => item.id),
    [pushBack.id],
  );
  localGraph.close();

  const aliasFile = { ...codeFile("user-alias.cc"), format: "cpp" };
  const aliasSource = {
    kind: "text",
    file: aliasFile,
    text: `class Worker { public: void run() {} };
using WorkerAlias = Worker;
void invoke(WorkerAlias& worker) { worker.run(); }`,
  };
  const aliasInput = await extractFileGraph(
    aliasSource,
    await new CodeExtractor().extract(aliasSource),
  );
  const invoke = aliasInput.nodes.find((node) => node.name === "invoke");
  const run = aliasInput.nodes.find((node) => node.name === "run");
  assert.ok(invoke && run);
  const aliasGraph = new SqliteGraphStorage("", { inMemory: true });
  aliasGraph.upsertFileGraph(
    aliasFile.id,
    aliasInput.nodes,
    aliasInput.edges,
    aliasInput.refs,
  );
  await aliasGraph.resolvePending({ files: [aliasFile] });
  assert.deepEqual(
    aliasGraph.callees(invoke.id, 1, 10).map((item) => item.id),
    [run.id],
  );
  aliasGraph.close();
});

test("C++ qualified receiver types resolve through their visible leaf type", async () => {
  const file = { ...codeFile("qualified-receiver.cc"), format: "cpp" };
  const source = {
    kind: "text",
    file,
    text: `namespace physical {
class Plan { public: void execute() {} };
}
void run(physical::Plan& plan) { plan.execute(); }`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const run = input.nodes.find((node) => node.name === "run");
  const execute = input.nodes.find((node) => node.name === "execute");
  assert.ok(run && execute);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((item) => item.id),
    [execute.id],
  );
  graph.close();
});

test("a missing receiver type never falls back to an unrelated method", async () => {
  const file = { ...codeFile("missing-receiver.cc"), format: "cpp" };
  const source = {
    kind: "text",
    file,
    text: `class Unrelated { public: void run() {} };
void invoke(Missing& value) { value.run(); }`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const unrelated = input.nodes.find((node) => node.name === "run");
  assert.ok(invoke && unrelated);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  assert.equal(
    graph
      .callees(invoke.id, 1, 10)
      .some((candidate) => candidate.id === unrelated.id),
    false,
  );
  assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 1);
  graph.close();
});

test("C++ return statements are not inferred as receiver declarations", async () => {
  const file = { ...codeFile("return-expression.cc"), format: "cpp" };
  const source = {
    kind: "text",
    file,
    text: `int run() { return values.size(); }`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const run = input.nodes.find((node) => node.name === "run");
  assert.ok(run);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending({ files: [file] });
  const boundary = graph.dynamicBoundaries([run.id], 10)[0];
  assert.ok(boundary);
  assert.notEqual(boundary.target.hints?.receiverType, "return");
  graph.close();
});

test("Go structural dispatch requires the complete interface method set", async () => {
  const file = { ...codeFile("method-set.go"), format: "go" };
  const source = {
    kind: "text",
    file,
    text: `package p
type Runner interface { Run(); Stop() }
type Alpha struct{}
func (a Alpha) Run() {}
func (a Alpha) Stop() {}
type Unrelated struct{}
func (u Unrelated) Run() {}
func invoke[T Runner](value T) { value.Run() }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  const parentByChild = new Map(
    input.edges
      .filter((edge) => edge.kind === "CONTAINS")
      .map((edge) => [edge.dst, edge.src]),
  );
  const nameById = new Map(input.nodes.map((node) => [node.id, node.name]));
  const candidateContainers = boundary.candidates.map((id) =>
    nameById.get(parentByChild.get(id)),
  );
  assert.ok(candidateContainers.includes("Alpha"));
  assert.equal(candidateContainers.includes("Unrelated"), false);
  graph.close();
});

test("Go structural dispatch includes embedded interface method sets", async () => {
  const file = { ...codeFile("embedded-method-set.go"), format: "go" };
  const source = {
    kind: "text",
    file,
    text: `package p
type Base interface { Stop() }
type Runner interface { Base; Run() }
type Alpha struct{}
func (a Alpha) Run() {}
func (a Alpha) Stop() {}
type Unrelated struct{}
func (u Unrelated) Run() {}
func invoke[T Runner](value T) { value.Run() }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  const parentByChild = new Map(
    input.edges
      .filter((edge) => edge.kind === "CONTAINS")
      .map((edge) => [edge.dst, edge.src]),
  );
  const nameById = new Map(input.nodes.map((node) => [node.id, node.name]));
  const candidateContainers = boundary.candidates.map((id) =>
    nameById.get(parentByChild.get(id)),
  );
  assert.ok(candidateContainers.includes("Alpha"));
  assert.equal(candidateContainers.includes("Unrelated"), false);
  graph.close();
});

test("Go structural dispatch includes methods promoted from embedded providers", async () => {
  const file = { ...codeFile("promoted-method-set.go"), format: "go" };
  const source = {
    kind: "text",
    file,
    text: `package p
type Runner interface { Run(); Stop() }
type RunBase struct{}
func (RunBase) Run() {}
type Wrapper struct { RunBase }
func (Wrapper) Stop() {}
type Unrelated struct{}
func (Unrelated) Run() {}
func invoke[T Runner](value T) { value.Run() }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const runBase = input.nodes.find((node) => node.name === "RunBase");
  const promotedRun = input.nodes.find(
    (node) =>
      node.name === "Run" &&
      input.edges.some(
        (edge) =>
          edge.kind === "CONTAINS" &&
          edge.src === runBase?.id &&
          edge.dst === node.id,
      ),
  );
  assert.ok(invoke && runBase && promotedRun);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();

  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.ok(boundary.candidates.includes(promotedRun.id));
  assert.equal(boundary.candidates.length, 1);
  graph.close();
});

test("Rust wrapped trait objects retain the inner dynamic trait", async () => {
  const file = { ...codeFile("wrapped-dispatch.rs"), format: "rust" };
  const source = {
    kind: "text",
    file,
    text: `trait Runner { fn run(&self); }
struct Alpha;
impl Runner for Alpha { fn run(&self) {} }
fn invoke(value: Box<dyn Runner>) { value.run(); }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const call = input.refs.find(
    (ref) =>
      ref.type === "symbol" &&
      ref.owner === invoke.id &&
      ref.target.member === "run",
  );
  assert.equal(call?.target.hints?.receiverType, "Runner");
  assert.deepEqual(call?.target.hints?.candidateTypes, ["Runner"]);
  assert.equal(call?.target.hints?.dispatch, "trait");

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.ok(boundary.candidates.length > 0);
  graph.close();
});

test("Java interface receiver keeps virtual implementations as candidates", async () => {
  const file = { ...codeFile("Dispatch.java"), format: "java" };
  const source = {
    kind: "text",
    file,
    text: `interface Runner { void run(); }
class Alpha implements Runner { public void run() {} }
class Use { void invoke(Runner value) { value.run(); } }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();

  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.reason, "polymorphic_dispatch");
  assert.equal(boundary.target.hints?.receiverType, "Runner");
  assert.equal(boundary.target.hints?.dispatch, "virtual");
  assert.equal(boundary.candidates.length, 1);
  assert.ok(
    graph
      .impact(boundary.candidates[0], 1, 10)
      .some((item) => item.id === invoke.id),
    "impact must include virtual dispatchers that name the implementation as a candidate",
  );
  graph.close();
});

test("abstract interface targets remain dynamic without concrete implementations", async () => {
  const file = { ...codeFile("AbstractDispatch.java"), format: "java" };
  const source = {
    kind: "text",
    file,
    text: `interface Runner { void run(); }
class Use { void invoke(Runner value) { value.run(); } }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();

  assert.deepEqual(graph.callees(invoke.id, 1, 10), []);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.reason, "polymorphic_dispatch");
  assert.deepEqual(boundary.candidates, []);
  assert.equal(boundary.candidatesTruncated, false);
  graph.close();
});

test("Java RTA retains methods inherited by instantiated subclasses", async () => {
  const file = { ...codeFile("InheritedRta.java"), format: "java" };
  const source = {
    kind: "text",
    file,
    text: `interface Runner { void run(); }
class Base implements Runner { public void run() {} }
class Child extends Base {}
class Other implements Runner { public void run() {} }
class Use {
  void invoke(Runner value) { value.run(); }
  void create() { new Child(); new Other(); }
}
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const parentByChild = new Map(
    input.edges
      .filter((edge) => edge.kind === "CONTAINS")
      .map((edge) => [edge.dst, edge.src]),
  );
  const nameById = new Map(input.nodes.map((node) => [node.id, node.name]));
  const method = (containerName) =>
    input.nodes.find(
      (node) =>
        node.name === "run" &&
        nameById.get(parentByChild.get(node.id)) === containerName,
    );
  const baseRun = method("Base");
  const otherRun = method("Other");
  assert.ok(invoke && baseRun && otherRun);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();

  assert.deepEqual(graph.callees(invoke.id, 1, 10), []);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.deepEqual(
    new Set(boundary.candidates),
    new Set([baseRun.id, otherRun.id]),
  );
  graph.close();
});

test("Java abstract class methods remain dynamic targets", async () => {
  const file = { ...codeFile("AbstractClass.java"), format: "java" };
  const source = {
    kind: "text",
    file,
    text: `abstract class Runner { abstract void run(); }
class Use { void invoke(Runner value) { value.run(); } }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const runner = input.nodes.find((node) => node.name === "Runner");
  const abstractRun = input.nodes.find((node) => node.name === "run");
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(runner && abstractRun && invoke);
  assert.equal(runner.kind, "abstract_class");
  assert.equal(abstractRun.kind, "abstract_method");

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();

  assert.deepEqual(graph.callees(invoke.id, 1, 10), []);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.reason, "polymorphic_dispatch");
  assert.deepEqual(boundary.candidates, []);
  graph.close();
});

test("RTA narrows virtual candidates to instantiated implementations", async () => {
  const file = { ...codeFile("Rta.java"), format: "java" };
  const source = {
    kind: "text",
    file,
    text: `interface Runner { void run(); }
class Alpha implements Runner { public void run() {} }
class Beta implements Runner { public void run() {} }
class Use {
  void invoke(Runner value) { value.run(); }
  void create() { new Alpha(); }
}
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const create = input.nodes.find((node) => node.name === "create");
  const alphaType = input.nodes.find((node) => node.name === "Alpha");
  const alphaRun = input.nodes.find((node) => {
    if (node.name !== "run") return false;
    const parent = input.edges.find(
      (edge) => edge.kind === "CONTAINS" && edge.dst === node.id,
    )?.src;
    return (
      input.nodes.find((candidate) => candidate.id === parent)?.name === "Alpha"
    );
  });
  assert.ok(invoke && create && alphaType && alphaRun);
  assert.ok(input.edges.some((edge) => edge.kind === "INSTANTIATES"));

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();
  assert.equal(
    graph.edges([create.id, alphaType.id], ["INSTANTIATES"], 10).edges.length,
    1,
  );
  assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 0);
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [alphaRun.id],
  );
  const edge = graph.edges([invoke.id, alphaRun.id], ["CALLS"], 10).edges[0];
  assert.equal(edge?.provenance, "heuristic");
  assert.equal(edge?.evidence, "receiver_type_member");
  graph.close();
});

test("dynamic candidate visibility follows transitive re-export imports", async () => {
  const files = [
    { ...codeFile("api.ts"), id: "api" },
    { ...codeFile("impl.ts"), id: "impl" },
    { ...codeFile("facade.ts"), id: "facade" },
    { ...codeFile("consumer.ts"), id: "consumer" },
  ];
  const texts = [
    "export interface Runner { run(): void; }",
    'import { Runner } from "./api"; export class Worker implements Runner { run(): void {} }',
    'export { Runner } from "./api"; export { Worker } from "./impl";',
    'import { Runner } from "./facade"; export function invoke(value: Runner) { value.run(); }',
  ];
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const nodes = [];
  let workerRun;
  for (let index = 0; index < files.length; index++) {
    const source = { kind: "text", file: files[index], text: texts[index] };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    nodes.push(...input.nodes);
    if (source.file.id === "impl")
      workerRun = input.nodes.find((node) => node.name === "run");
    graph.upsertFileGraph(source.file.id, input.nodes, input.edges, input.refs);
  }
  await graph.resolvePending({ files });
  const invoke = nodes.find((node) => node.name === "invoke");
  assert.ok(invoke && workerRun);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.ok(
    boundary.candidates.includes(workerRun.id),
    JSON.stringify({ boundary, workerRun }),
  );
  graph.close();
});

test("transitive re-export changes invalidate preferred-file projections", async () => {
  const aFile = { ...codeFile("a.ts"), id: "a" };
  const bFile = { ...codeFile("b.ts"), id: "b" };
  const facadeFile = { ...codeFile("facade.ts"), id: "facade" };
  const consumerFile = { ...codeFile("consumer.ts"), id: "consumer" };
  const prepare = async (file, text) => {
    const source = { kind: "text", file, text };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    return extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
  };
  const a = await prepare(aFile, "export function target() {}");
  const initialB = await prepare(bFile, "export function unrelated() {}");
  const facade = await prepare(
    facadeFile,
    'export * from "./a"; export * from "./b";',
  );
  const consumer = await prepare(
    consumerFile,
    'import { target } from "./facade"; export function invoke() { target(); }',
  );
  const invoke = consumer.nodes.find((node) => node.name === "invoke");
  const aTarget = a.nodes.find((node) => node.name === "target");
  assert.ok(invoke && aTarget);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  for (const [file, input] of [
    [aFile, a],
    [bFile, initialB],
    [facadeFile, facade],
    [consumerFile, consumer],
  ])
    graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  const files = [aFile, bFile, facadeFile, consumerFile];
  await graph.resolvePending({ files });
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [aTarget.id],
  );

  const updatedB = await prepare(bFile, "export function target() {}");
  graph.upsertFileGraph(
    bFile.id,
    updatedB.nodes,
    updatedB.edges,
    updatedB.refs,
  );
  await graph.resolvePending({ files });

  assert.equal(
    graph.callees(invoke.id, 1, 10).length,
    0,
    "adding the same export behind a re-export must invalidate the stale target",
  );
  assert.ok(
    graph.stats().failedRefCount + graph.stats().pendingRefCount > 0,
    "the now-ambiguous source fact must remain available for later convergence",
  );
  graph.close();
});

test("changing the only maker from Alpha to Beta reprojects virtual dispatch", async () => {
  const typesFile = {
    ...codeFile("IncrementalTypes.java"),
    id: "types",
    format: "java",
  };
  const makerFile = { ...codeFile("Maker.java"), id: "maker", format: "java" };
  const prepare = async (file, text) => {
    const source = { kind: "text", file, text };
    return extractFileGraph(source, await new CodeExtractor().extract(source));
  };
  const types = await prepare(
    typesFile,
    `interface Runner { void run(); }
class Alpha implements Runner { public void run() {} }
class Beta implements Runner { public void run() {} }
class Use { void invoke(Runner value) { value.run(); } }`,
  );
  const invoke = types.nodes.find((node) => node.name === "invoke");
  const alphaRun = types.nodes.find((node) => {
    if (node.name !== "run") return false;
    const parent = types.edges.find(
      (edge) => edge.kind === "CONTAINS" && edge.dst === node.id,
    )?.src;
    return (
      types.nodes.find((candidate) => candidate.id === parent)?.name === "Alpha"
    );
  });
  const betaRun = types.nodes.find((node) => {
    if (node.name !== "run") return false;
    const parent = types.edges.find(
      (edge) => edge.kind === "CONTAINS" && edge.dst === node.id,
    )?.src;
    return (
      types.nodes.find((candidate) => candidate.id === parent)?.name === "Beta"
    );
  });
  assert.ok(invoke && alphaRun && betaRun);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(typesFile.id, types.nodes, types.edges, types.refs);
  await graph.resolvePending();
  assert.ok(graph.dynamicBoundaries([invoke.id], 10)[0]);

  const maker = await prepare(
    makerFile,
    "class Maker { void make() { new Alpha(); } }",
  );
  graph.upsertFileGraph(makerFile.id, maker.nodes, maker.edges, maker.refs);
  await graph.resolvePending();

  assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 0);
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [alphaRun.id],
  );

  const changedMaker = await prepare(
    makerFile,
    "class Maker { void make() { new Beta(); } }",
  );
  graph.upsertFileGraph(
    makerFile.id,
    changedMaker.nodes,
    changedMaker.edges,
    changedMaker.refs,
  );
  await graph.resolvePending();

  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [betaRun.id],
  );
  graph.close();
});

test("deleting the only maker removes the stale RTA projection", async () => {
  const typesFile = {
    ...codeFile("DeleteMakerTypes.java"),
    id: "delete-types",
    format: "java",
  };
  const makerFile = {
    ...codeFile("DeleteMaker.java"),
    id: "delete-maker",
    format: "java",
  };
  const prepare = async (file, text) => {
    const source = { kind: "text", file, text };
    return extractFileGraph(source, await new CodeExtractor().extract(source));
  };
  const types = await prepare(
    typesFile,
    `interface Runner { void run(); }
class Alpha implements Runner { public void run() {} }
class Beta implements Runner { public void run() {} }
class Use { void invoke(Runner value) { value.run(); } }`,
  );
  const invoke = types.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const maker = await prepare(
    makerFile,
    "class Maker { void make() { new Alpha(); } }",
  );
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(typesFile.id, types.nodes, types.edges, types.refs);
  graph.upsertFileGraph(makerFile.id, maker.nodes, maker.edges, maker.refs);
  await graph.resolvePending();
  assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 0);

  graph.deleteFileGraph(makerFile.id);
  await graph.resolvePending();

  assert.equal(graph.callees(invoke.id, 1, 10).length, 0);
  assert.equal(
    graph.dynamicBoundaries([invoke.id], 10)[0]?.reason,
    "polymorphic_dispatch",
  );
  graph.close();
});

test("removing one of multiple Alpha makers keeps the stable RTA projection", async () => {
  const typesFile = {
    ...codeFile("MultiMakerTypes.java"),
    id: "multi-types",
    format: "java",
  };
  const makerAFile = {
    ...codeFile("MakerA.java"),
    id: "maker-a",
    format: "java",
  };
  const makerBFile = {
    ...codeFile("MakerB.java"),
    id: "maker-b",
    format: "java",
  };
  const prepare = async (file, text) => {
    const source = { kind: "text", file, text };
    return extractFileGraph(source, await new CodeExtractor().extract(source));
  };
  const types = await prepare(
    typesFile,
    `interface Runner { void run(); }
class Alpha implements Runner { public void run() {} }
class Beta implements Runner { public void run() {} }
class Use { void invoke(Runner value) { value.run(); } }`,
  );
  const invoke = types.nodes.find((node) => node.name === "invoke");
  const alphaRun = types.nodes.find((node) => {
    if (node.name !== "run") return false;
    const parent = types.edges.find(
      (edge) => edge.kind === "CONTAINS" && edge.dst === node.id,
    )?.src;
    return (
      types.nodes.find((candidate) => candidate.id === parent)?.name === "Alpha"
    );
  });
  assert.ok(invoke && alphaRun);
  const makerA = await prepare(
    makerAFile,
    "class MakerA { void make() { new Alpha(); } }",
  );
  const makerB = await prepare(
    makerBFile,
    "class MakerB { void make() { new Alpha(); } }",
  );
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(typesFile.id, types.nodes, types.edges, types.refs);
  graph.upsertFileGraph(makerAFile.id, makerA.nodes, makerA.edges, makerA.refs);
  graph.upsertFileGraph(makerBFile.id, makerB.nodes, makerB.edges, makerB.refs);
  await graph.resolvePending();

  graph.deleteFileGraph(makerAFile.id);
  await graph.resolvePending();

  assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 0);
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [alphaRun.id],
  );
  graph.close();
});

test("Java RTA never promotes instantiated unrelated same-name methods", async () => {
  const file = { ...codeFile("NominalRta.java"), format: "java" };
  const source = {
    kind: "text",
    file,
    text: `interface Runner { void run(); void stop(); }
class Alpha implements Runner { public void run() {} public void stop() {} }
class Unrelated { public void run() {} }
class Use {
  void invoke(Runner value) { value.run(); }
  void make() { new Unrelated(); }
}
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const unrelatedRun = input.nodes.find((node) => {
    if (node.name !== "run") return false;
    const parent = input.edges.find(
      (edge) => edge.kind === "CONTAINS" && edge.dst === node.id,
    )?.src;
    return (
      input.nodes.find((candidate) => candidate.id === parent)?.name ===
      "Unrelated"
    );
  });
  assert.ok(invoke && unrelatedRun);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();

  assert.equal(
    graph
      .callees(invoke.id, 1, 10)
      .some((candidate) => candidate.id === unrelatedRun.id),
    false,
  );
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.candidates.includes(unrelatedRun.id), false);
  graph.close();
});

test("dynamic candidate selection filters overloads by call arity", async () => {
  const file = { ...codeFile("Overload.java"), format: "java" };
  const source = {
    kind: "text",
    file,
    text: `class Target {
  void run() {}
  void run(int value) {}
}
class Use { void invoke(Target value) { value.run(1); } }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const oneArg = input.nodes.find(
    (node) => node.name === "run" && node.arity === 1,
  );
  assert.ok(invoke && oneArg);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [oneArg.id],
  );
  graph.close();
});

test("resolved dispatch facts are recomputed when a later override is indexed", async () => {
  const workerFile = { ...codeFile("worker.ts"), id: "worker-file" };
  const callerFile = { ...codeFile("caller.ts"), id: "caller-file" };
  const specialFile = { ...codeFile("special.ts"), id: "special-file" };
  const prepare = async (file, text) => {
    const source = { kind: "text", file, text };
    return extractFileGraph(source, await new CodeExtractor().extract(source));
  };
  const worker = await prepare(workerFile, "export class Worker { help() {} }");
  const caller = await prepare(
    callerFile,
    'import { Worker } from "./worker"; export function invoke(value: Worker) { value.help(); }',
  );
  const invoke = caller.nodes.find((node) => node.name === "invoke");
  const workerHelp = worker.nodes.find((node) => node.name === "help");
  assert.ok(invoke && workerHelp);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(workerFile.id, worker.nodes, worker.edges, worker.refs);
  graph.upsertFileGraph(callerFile.id, caller.nodes, caller.edges, caller.refs);
  await graph.resolvePending({ files: [workerFile, callerFile] });
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [workerHelp.id],
  );

  const special = await prepare(
    specialFile,
    'import { Worker } from "./worker"; export class Special extends Worker { help() {} }',
  );
  graph.upsertFileGraph(
    specialFile.id,
    special.nodes,
    special.edges,
    special.refs,
  );
  await graph.resolvePending({ files: [workerFile, callerFile, specialFile] });

  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.reason, "polymorphic_dispatch");
  assert.equal(boundary.candidates.length, 2);
  assert.equal(graph.callees(invoke.id, 1, 10).length, 0);
  graph.close();
});

test("target file rebuild preserves structured dispatch facts", async () => {
  const workerFile = { ...codeFile("worker.ts"), id: "worker-file" };
  const otherFile = { ...codeFile("other.ts"), id: "other-file" };
  const callerFile = { ...codeFile("caller.ts"), id: "caller-file" };
  const prepare = async (file, text) => {
    const source = { kind: "text", file, text };
    return extractFileGraph(source, await new CodeExtractor().extract(source));
  };
  const worker = await prepare(workerFile, "export class Worker { help() {} }");
  const other = await prepare(otherFile, "export class Other { help() {} }");
  const caller = await prepare(
    callerFile,
    'import { Worker } from "./worker"; export function invoke(value: Worker) { value.help(); }',
  );
  const invoke = caller.nodes.find((node) => node.name === "invoke");
  const workerHelp = worker.nodes.find((node) => node.name === "help");
  assert.ok(invoke && workerHelp);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(workerFile.id, worker.nodes, worker.edges, worker.refs);
  graph.upsertFileGraph(otherFile.id, other.nodes, other.edges, other.refs);
  graph.upsertFileGraph(callerFile.id, caller.nodes, caller.edges, caller.refs);
  await graph.resolvePending({ files: [workerFile, otherFile, callerFile] });

  graph.upsertFileGraph(workerFile.id, worker.nodes, worker.edges, worker.refs);
  await graph.resolvePending({ files: [workerFile, otherFile, callerFile] });

  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [workerHelp.id],
  );
  const edge = graph.edges([invoke.id, workerHelp.id], ["CALLS"], 10).edges[0];
  assert.equal(edge?.provenance, "heuristic");
  assert.equal(edge?.confidence, 0.75);
  assert.equal(edge?.evidence, "receiver_type_member");
  graph.close();
});

test("an unbound qualified call never borrows a member from another imported file", async () => {
  const helperFile = {
    ...codeFile("src/helper.rs"),
    id: "helper-file",
    format: "rust",
  };
  const mainFile = {
    ...codeFile("src/main.rs"),
    id: "main-file",
    format: "rust",
  };
  const helperSource = {
    kind: "text",
    file: helperFile,
    text: "pub struct Helper; impl Helper { pub fn new() -> Helper { Helper } }",
  };
  const mainSource = {
    kind: "text",
    file: mainFile,
    text: "mod helper; use std::io::Cursor; fn parse() { Cursor::new(Vec::<u8>::new()); }",
  };
  const helper = await extractFileGraph(
    helperSource,
    await new CodeExtractor().extract(helperSource),
  );
  const main = await extractFileGraph(
    mainSource,
    await new CodeExtractor().extract(mainSource),
  );
  const parse = main.nodes.find((node) => node.name === "parse");
  const helperNew = helper.nodes.find((node) => node.name === "new");
  assert.ok(parse && helperNew);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(helperFile.id, helper.nodes, helper.edges, helper.refs);
  graph.upsertFileGraph(mainFile.id, main.nodes, main.edges, main.refs);
  await graph.resolvePending({ files: [helperFile, mainFile] });
  assert.equal(
    graph
      .edges([parse.id, helperNew.id], ["CALLS"], 10)
      .edges.some((edge) => edge.src === parse.id && edge.dst === helperNew.id),
    false,
  );
  graph.close();
});

test("an untyped qualified SDK call does not bind to an imported abstract method", async () => {
  const contractFile = {
    ...codeFile("client.py"),
    id: "contract-file",
    format: "python",
  };
  const implementationFile = {
    ...codeFile("azure.py"),
    id: "implementation-file",
    format: "python",
  };
  const prepare = async (file, text) => {
    const source = { kind: "text", file, text };
    return extractFileGraph(source, await new CodeExtractor().extract(source));
  };
  const contract = await prepare(
    contractFile,
    "class EmbedderClient:\n    async def create(self, value):\n        raise NotImplementedError()\n",
  );
  const implementation = await prepare(
    implementationFile,
    "from .client import EmbedderClient\nclass AzureEmbedder(EmbedderClient):\n    async def create(self, value):\n        return await self.azure_client.embeddings.create(input=value)\n",
  );
  const abstractCreate = contract.nodes.find((node) => node.name === "create");
  const concreteCreate = implementation.nodes.find(
    (node) => node.name === "create",
  );
  assert.ok(abstractCreate && concreteCreate);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    contractFile.id,
    contract.nodes,
    contract.edges,
    contract.refs,
  );
  graph.upsertFileGraph(
    implementationFile.id,
    implementation.nodes,
    implementation.edges,
    implementation.refs,
  );
  await graph.resolvePending({ files: [contractFile, implementationFile] });

  assert.equal(
    graph
      .edges([concreteCreate.id, abstractCreate.id], ["CALLS"], 10)
      .edges.some(
        (edge) =>
          edge.src === concreteCreate.id && edge.dst === abstractCreate.id,
      ),
    false,
  );
  assert.ok(
    graph
      .dynamicBoundaries([concreteCreate.id], 10)
      .some(
        (boundary) =>
          boundary.target.raw === "self.azure_client.embeddings.create" &&
          boundary.reason === "unknown_receiver_type",
      ),
  );
  graph.close();
});

test("a cross-file Python class construction resolves as a call target", async () => {
  const modelFile = {
    ...codeFile("graphiti.py"),
    id: "model-file",
    format: "python",
  };
  const bootstrapFile = {
    ...codeFile("server.py"),
    id: "bootstrap-file",
    format: "python",
  };
  const prepare = async (file, text) => {
    const source = { kind: "text", file, text };
    return extractFileGraph(source, await new CodeExtractor().extract(source));
  };
  const model = await prepare(
    modelFile,
    "class Graphiti:\n    def __init__(self, uri, user=None):\n        self.uri = uri\n",
  );
  const bootstrap = await prepare(
    bootstrapFile,
    "from .graphiti import Graphiti\ndef initialize():\n    return Graphiti('bolt://localhost', user='neo4j')\n",
  );
  const graphiti = model.nodes.find((node) => node.name === "Graphiti");
  const initialize = bootstrap.nodes.find((node) => node.name === "initialize");
  assert.ok(graphiti && initialize);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(modelFile.id, model.nodes, model.edges, model.refs);
  graph.upsertFileGraph(
    bootstrapFile.id,
    bootstrap.nodes,
    bootstrap.edges,
    bootstrap.refs,
  );
  await graph.resolvePending({ files: [modelFile, bootstrapFile] });

  assert.ok(
    graph
      .callees(initialize.id, 1, 10)
      .some((candidate) => candidate.id === graphiti.id),
  );
  graph.close();
});
