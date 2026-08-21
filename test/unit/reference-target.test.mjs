import assert from "node:assert/strict";
import test from "node:test";
import {
  collectFunctionCallSites,
  collectTypeInheritanceSites,
} from "../../dist/engine/extraction/index.js";

function source(format, relativePath, text) {
  return {
    kind: "text",
    text,
    file: {
      id: `${format}-file`,
      collectionId: "collection",
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

for (const fixture of [
  [
    "typescript",
    "a.ts",
    "class A { run(){ this.helper(); } }",
    "this.helper",
    "owner",
    "this",
  ],
  [
    "python",
    "a.py",
    "class A:\n def run(self):\n  super().helper()\n",
    "super().helper",
    "super",
    "super",
  ],
  [
    "java",
    "A.java",
    "class A { void run(){ this.helper(); } }",
    "this.helper",
    "owner",
    "this",
  ],
  [
    "cpp",
    "a.cpp",
    "class A { int run(){ return this->helper(); } };",
    "this->helper",
    "owner",
    "this",
  ],
  [
    "rust",
    "a.rs",
    "impl A { fn run(&self){ self.helper(); } }",
    "self.helper",
    "owner",
    "self",
  ],
  [
    "go",
    "a.go",
    "package p\nfunc (a A) run(){ a.helper() }",
    "a.helper",
    "qualified",
    "a",
  ],
]) {
  test(`${fixture[0]} call target IR`, async () => {
    const calls = await collectFunctionCallSites(
      source(fixture[0], fixture[1], fixture[2]),
    );
    const site = calls
      .flatMap((owner) => owner.sites)
      .find((item) => item.name === fixture[3]);
    assert.ok(site);
    assert.deepEqual(site.target, {
      raw: fixture[3],
      member: "helper",
      receiver: { kind: fixture[4], name: fixture[5] },
    });
  });
}

test("inheritance target IR is structured", async () => {
  const sites = await collectTypeInheritanceSites(
    source("typescript", "types.ts", "class Child extends ns.Base {}"),
  );
  assert.deepEqual(sites[0].sites[0].target, {
    raw: "ns.Base",
    member: "Base",
    receiver: { kind: "qualified", name: "ns" },
  });
});
