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
    { receiverType: "A", callArity: 0, candidateTypes: ["A"] },
  ],
  [
    "cpp",
    "static.cpp",
    "struct Base { static void helper(); }; void run(){ Base::helper(); }",
    "Base::helper",
    "qualified",
    "Base",
  ],
  [
    "rust",
    "static.rs",
    "struct Base; impl Base { fn helper() {} } fn run(){ Base::helper(); }",
    "Base::helper",
    "qualified",
    "Base",
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
      ...(fixture[6] ? { hints: fixture[6] } : {}),
    });
  });
}

test("nested entity parameters do not overwrite outer receiver types", async () => {
  const calls = await collectFunctionCallSites(
    source(
      "java",
      "Nested.java",
      `class Use {
        void invoke(Runner value) {
          Object nested = new Object() { void nested(Other value) {} };
          value.run();
        }
      }`,
    ),
  );
  const invoke = calls.find((owner) =>
    owner.sites.some((site) => site.name === "value.run"),
  );
  const site = invoke?.sites.find((item) => item.name === "value.run");
  assert.ok(site);
  assert.equal(site.target.hints?.receiverType, "Runner");
});

test("module values own calls made by their initializer", async () => {
  const calls = await collectFunctionCallSites(
    source(
      "typescript",
      "factory.ts",
      "export const client = createClient(new Runtime());",
    ),
  );
  const owner = calls.find((candidate) => candidate.name === "client");
  assert.equal(owner?.symbolType, "value");
  assert.deepEqual(
    owner?.sites.map((site) => site.name),
    ["createClient", "Runtime"],
  );
});

test("unindexed local callbacks contribute calls to their indexed owner", async () => {
  const calls = await collectFunctionCallSites(
    source(
      "typescript",
      "callback.ts",
      `function ReviewButton() {
        const { submit } = useForm();
        const handleClick = () => submit();
        return button(handleClick);
      }`,
    ),
  );
  const owner = calls.find((candidate) => candidate.name === "ReviewButton");
  assert.deepEqual(
    owner?.sites.map((site) => site.name),
    ["useForm", "submit", "button"],
  );
  assert.equal(
    owner?.sites.find((site) => site.name === "submit")?.target.hints
      ?.lexicallyBound,
    true,
  );
});

test("unindexed callback parameters remain lexically bound", async () => {
  const calls = await collectFunctionCallSites(
    source(
      "typescript",
      "thunk.ts",
      `export const save = createThunk("save", async ({ value }, { dispatch }) => {
        return dispatch(commit(value));
      });`,
    ),
  );
  const dispatch = calls
    .find((candidate) => candidate.name === "save")
    ?.sites.find((site) => site.name === "dispatch");
  assert.equal(dispatch?.target.hints?.lexicallyBound, true);
});

test("receiver type hints follow block scope and call position", async () => {
  const calls = await collectFunctionCallSites(
    source(
      "typescript",
      "Scopes.ts",
      `function invoke() {
        {
          const value: Runner = makeRunner();
          value.run();
        }
        {
          const value: Other = makeOther();
          value.run();
        }
      }`,
    ),
  );
  const runSites = calls
    .flatMap((owner) => owner.sites)
    .filter((site) => site.name === "value.run");
  assert.equal(runSites.length, 2);
  assert.deepEqual(
    runSites.map((site) => site.target.hints?.receiverType),
    ["Runner", "Other"],
  );
});

test("TypeScript private fields infer their constructed receiver type", async () => {
  const calls = await collectFunctionCallSites(
    source(
      "typescript",
      "PrivateField.ts",
      `class Use {
        #declared: Runner;
        #constructed;
        constructor() { this.#constructed = new Runner(); }
        invoke() { this.#declared.run(); this.#constructed.run(); }
      }`,
    ),
  );
  const sites = calls
    .flatMap((owner) => owner.sites)
    .filter((item) => item.target.member === "run");
  assert.deepEqual(
    sites.map((site) => site.target.hints?.receiverType),
    ["Runner", "Runner"],
  );
});

for (const fixture of [
  {
    name: "local variable type",
    text: "function invoke() { const value: Runner = make(); value.run(); }",
    raw: "value.run",
  },
  {
    name: "field type",
    text: "class Use { value: Runner; invoke() { this.value.run(); } }",
    raw: "this.value.run",
  },
]) {
  test(`TypeScript ${fixture.name} feeds receiver type hints`, async () => {
    const calls = await collectFunctionCallSites(
      source("typescript", "facts.ts", fixture.text),
    );
    const site = calls
      .flatMap((owner) => owner.sites)
      .find((item) => item.name === fixture.raw);
    assert.ok(site);
    assert.equal(site.target.hints?.receiverType, "Runner");
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

for (const fixture of [
  {
    name: "Go interface constraint",
    format: "go",
    path: "generic.go",
    text: "package p\nfunc invoke[T Runner](value T) { value.Run() }",
    raw: "value.Run",
    hints: {
      receiverType: "T",
      callArity: 0,
      candidateTypes: ["T", "Runner"],
      genericBounds: ["Runner"],
      dispatch: "interface",
    },
  },
  {
    name: "Rust trait bound",
    format: "rust",
    path: "generic.rs",
    text: "fn invoke<T: Runner>(value: T) { value.run(); }",
    raw: "value.run",
    hints: {
      receiverType: "T",
      callArity: 0,
      candidateTypes: ["T", "Runner"],
      genericBounds: ["Runner"],
      dispatch: "trait",
    },
  },
  {
    name: "C++ constrained template",
    format: "cpp",
    path: "generic.cpp",
    text: "template<Runner T> void invoke(T value) { value.run(); }",
    raw: "value.run",
    hints: {
      receiverType: "T",
      callArity: 0,
      candidateTypes: ["T", "Runner"],
      genericBounds: ["Runner"],
      dispatch: "virtual",
    },
  },
  {
    name: "Java interface parameter",
    format: "java",
    path: "Generic.java",
    text: "class Generic { void invoke(Runner value) { value.run(); } }",
    raw: "value.run",
    hints: {
      receiverType: "Runner",
      callArity: 0,
      candidateTypes: ["Runner"],
      dispatch: "virtual",
    },
  },
]) {
  test(`${fixture.name} adds semantic resolution hints`, async () => {
    const calls = await collectFunctionCallSites(
      source(fixture.format, fixture.path, fixture.text),
    );
    const site = calls
      .flatMap((owner) => owner.sites)
      .find((item) => item.name === fixture.raw);
    assert.ok(site);
    assert.deepEqual(site.target.hints, fixture.hints);
  });
}
