import assert from "node:assert/strict";
import test from "node:test";
import { NameIndex } from "../../dist/engine/graph/name-index.js";
import { resolveRef } from "../../dist/engine/graph/resolve.js";

test("cross-file C declaration resolves to its sole source definition", () => {
  const names = new NameIndex();
  names.load([
    functionEntry("declaration", "src/common.h"),
    functionEntry("definition", "src/timer.c"),
  ]);

  assert.equal(
    names.lookupWithEvidence("run_timers", "src/core.c")?.entry.id,
    "definition",
  );
});

test("cross-file platform implementations remain ambiguous", () => {
  const names = new NameIndex();
  names.load([
    functionEntry("declaration", "include/api.h"),
    functionEntry("unix", "src/unix/core.c"),
    functionEntry("windows", "src/win/core.c"),
  ]);

  assert.equal(names.lookupWithEvidence("run_timers", "src/consumer.c"), null);
});

test("preferred Rust type imports ignore same-file impl containers", () => {
  const names = new NameIndex();
  names.load([
    {
      id: "router",
      fileId: "routing",
      name: "Router",
      kind: "class",
      signature: "pub struct Router<S>",
    },
    {
      id: "router-impl",
      fileId: "routing",
      name: "Router",
      kind: "class",
      signature: "impl<S> Router<S>",
    },
  ]);
  assert.equal(
    names.lookupWithEvidence("Router", "consumer", ["routing"])?.entry.id,
    "router",
  );
  assert.equal(
    resolveRef(
      {
        id: "ref",
        src_file: "consumer",
        owner: "impl",
        ref_name: "Router",
        ref_kind: "return",
        line: 1,
        source_language: "rust",
      },
      names,
      ["barrel", "routing"],
      { importedName: "Router", fileId: "barrel", kind: "exact" },
    ).status,
    "resolved",
  );
  assert.equal(
    resolveRef(
      {
        id: "wildcard-ref",
        src_file: "consumer",
        owner: "impl",
        ref_name: "Router",
        ref_kind: "return",
        line: 1,
        source_language: "rust",
      },
      names,
      ["routing"],
      { importedName: "*", fileId: "routing", kind: "exact" },
    ).status,
    "resolved",
  );
});

test("qualified types resolve relative to their lexical namespace", () => {
  const names = new NameIndex();
  names.load([
    {
      id: "articles-command",
      fileId: "articles-create",
      name: "Command",
      qualifiedName: "App::Articles::Create::Command",
      containerId: "articles-create-container",
      kind: "class",
    },
    {
      id: "users-command",
      fileId: "users-create",
      name: "Command",
      qualifiedName: "App::Users::Create::Command",
      containerId: "users-create-container",
      kind: "class",
    },
  ]);

  const result = resolveRef(
    {
      id: "ref",
      src_file: "controller",
      owner: "create-action",
      ref_name: "Create.Command",
      ref_kind: "type",
      line: 1,
      source_language: "csharp",
    },
    names,
    [],
    undefined,
    "ArticlesController",
    "articles-controller",
    [],
    undefined,
    "App::Articles::ArticlesController::Create",
  );

  assert.equal(result.status, "resolved");
  assert.equal(result.dst, "articles-command");
});

function functionEntry(id, filePath) {
  return {
    id,
    fileId: `file-${id}`,
    filePath,
    name: "run_timers",
    qualifiedName: "run_timers",
    kind: "function",
    signature: "void run_timers(loop_t* loop)",
  };
}
