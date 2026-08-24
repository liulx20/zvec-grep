import { CodeExtractor } from "../../dist/engine/extraction/code/extractor.js";
import {
  SqliteGraphStorage,
  extractFileGraph,
  exploreGraph,
} from "../../dist/engine/graph/index.js";

const VARIANTS = ["Alpha", "Beta", "Gamma"];

const ADAPTERS = {
  c: cLikeAdapter({
    extension: "c",
    functionKeyword: "void ",
    typedUse(type, name) {
      return `typedef struct ${type} { int value; } ${type};\n${type} ${name}(${type} value) { return value; }`;
    },
    externalCall(local) {
      return `void ${local}() {}\nvoid run${local}() { printf("value"); }`;
    },
  }),
  javascript: cLikeAdapter({
    extension: "js",
    functionKeyword: "function ",
    classMethod(name, body) {
      return `${name}() { ${body} }`;
    },
    selfCall(name) {
      return `this.${name}()`;
    },
    inheritance(base, child) {
      return `class ${base} { run() {} }\nclass ${child} extends ${base} {}`;
    },
    typedUse(type, name) {
      return `class ${type} {}\nfunction ${name}() { return new ${type}(); }`;
    },
    typedExpected(type, name) {
      return { calls: [[name, type]] };
    },
    externalCall(local) {
      return `function ${local}() {}\nfunction run${local}() { console.${local}(); }`;
    },
  }),
  jsx: cLikeAdapter({
    extension: "jsx",
    functionKeyword: "function ",
    classMethod(name, body) {
      return `${name}() { ${body} }`;
    },
    selfCall(name) {
      return `this.${name}()`;
    },
    inheritance(base, child) {
      return `class ${base} { run() {} }\nclass ${child} extends ${base} {}`;
    },
    typedUse(type, name) {
      return `class ${type} {}\nfunction ${name}() { return new ${type}(); }`;
    },
    typedExpected(type, name) {
      return { calls: [[name, type]] };
    },
    externalCall(local) {
      return `function ${local}() {}\nfunction run${local}() { console.${local}(); }`;
    },
  }),
  typescript: cLikeAdapter({
    extension: "ts",
    functionKeyword: "function ",
    classMethod(name, body) {
      return `${name}() { ${body} }`;
    },
    selfCall(name) {
      return `this.${name}()`;
    },
    inheritance(base, child) {
      return `class ${base} { run() {} }\nclass ${child} extends ${base} {}`;
    },
    typedUse(type, name) {
      return `class ${type} {}\nfunction ${name}(value: ${type}): ${type} { return value; }`;
    },
    externalCall(local) {
      return `function ${local}() {}\nfunction run${local}() { console.${local}(); }`;
    },
  }),
  tsx: cLikeAdapter({
    extension: "tsx",
    functionKeyword: "function ",
    classMethod(name, body) {
      return `${name}() { ${body} }`;
    },
    selfCall(name) {
      return `this.${name}()`;
    },
    inheritance(base, child) {
      return `class ${base} { run() {} }\nclass ${child} extends ${base} {}`;
    },
    typedUse(type, name) {
      return `class ${type} {}\nfunction ${name}(value: ${type}): ${type} { return value; }`;
    },
    externalCall(local) {
      return `function ${local}() {}\nfunction run${local}() { console.${local}(); }`;
    },
  }),
  java: cLikeAdapter({
    extension: "java",
    functionKeyword: "static void ",
    wrapFunctions(source) {
      return `class Fixture { ${source} }`;
    },
    classMethod(name, body) {
      return `void ${name}() { ${body} }`;
    },
    selfCall(name) {
      return `this.${name}()`;
    },
    inheritance(base, child) {
      return `class ${base} { void run() {} }\nclass ${child} extends ${base} {}`;
    },
    typedUse(type, name) {
      return `class ${type} {}\nclass Use${type} { ${type} ${name}(${type} value) { return value; } }`;
    },
    externalCall(local) {
      return `class External${local} { void ${local}() {} void run() { System.out.${local}(); } }`;
    },
  }),
  cpp: cLikeAdapter({
    extension: "cpp",
    functionKeyword: "void ",
    classMethod(name, body) {
      return `void ${name}() { ${body} }`;
    },
    selfCall(name) {
      return `this->${name}()`;
    },
    inheritance(base, child) {
      return `class ${base} { public: void run() {} };\nclass ${child} : public ${base} {};`;
    },
    typedUse(type, name) {
      return `class ${type} {};\n${type} ${name}(${type} value) { return value; }`;
    },
    externalCall(local) {
      return `void ${local}() {}\nvoid run${local}() { std::${local}(); }`;
    },
  }),
  python: {
    extension: "py",
    declaration(a, b) {
      return `def ${a}():\n    return 1\n\ndef ${b}():\n    return 2\n`;
    },
    localCall(caller, callee, times = 1) {
      return `def ${callee}():\n    return True\n\ndef ${caller}():\n${`    ${callee}()\n`.repeat(times)}`;
    },
    chain(a, b, c) {
      return `def ${c}():\n    return True\n\ndef ${b}():\n    return ${c}()\n\ndef ${a}():\n    return ${b}()\n`;
    },
    recursive(name) {
      return `def ${name}(n):\n    return ${name}(n - 1) if n else 0\n`;
    },
    member(container, caller, callee) {
      return `class ${container}:\n    def ${callee}(self):\n        return True\n\n    def ${caller}(self):\n        return self.${callee}()\n`;
    },
    inheritance(base, child) {
      return `class ${base}:\n    def run(self):\n        return True\n\nclass ${child}(${base}):\n    pass\n`;
    },
    typedUse(type, name) {
      return `class ${type}:\n    pass\n\ndef ${name}(value: ${type}) -> ${type}:\n    return value\n`;
    },
    externalCall(local) {
      return `def ${local}():\n    return True\n\ndef run_${local}():\n    return os.${local}()\n`;
    },
    unresolved(caller, missing) {
      return `def ${caller}():\n    return ${missing}()\n`;
    },
  },
  go: {
    extension: "go",
    declaration(a, b) {
      return `package fixture\nfunc ${a}() {}\nfunc ${b}() {}\n`;
    },
    localCall(caller, callee, times = 1) {
      return `package fixture\nfunc ${callee}() {}\nfunc ${caller}() { ${`${callee}(); `.repeat(times)} }\n`;
    },
    chain(a, b, c) {
      return `package fixture\nfunc ${c}() {}\nfunc ${b}() { ${c}() }\nfunc ${a}() { ${b}() }\n`;
    },
    recursive(name) {
      return `package fixture\nfunc ${name}(n int) { if n > 0 { ${name}(n-1) } }\n`;
    },
    member(container, caller, callee) {
      return `package fixture\ntype ${container} struct{}\nfunc (d *${container}) ${callee}() {}\nfunc (d *${container}) ${caller}() { d.${callee}() }\n`;
    },
    inheritance(base, child) {
      return `package fixture\ntype ${base} interface { Run() }\ntype ${child} interface { ${base}; Stop() }\n`;
    },
    typedUse(type, name) {
      return `package fixture\ntype ${type} struct{}\nfunc ${name}(value ${type}) ${type} { return value }\n`;
    },
    externalCall(local) {
      return `package fixture\nfunc ${local}() {}\nfunc Run${local}() { fmt.${local}() }\n`;
    },
    unresolved(caller, missing) {
      return `package fixture\nfunc ${caller}() { ${missing}() }\n`;
    },
  },
  rust: {
    extension: "rs",
    declaration(a, b) {
      return `fn ${a}() {}\nfn ${b}() {}\n`;
    },
    localCall(caller, callee, times = 1) {
      return `fn ${callee}() {}\nfn ${caller}() { ${`${callee}(); `.repeat(times)} }\n`;
    },
    chain(a, b, c) {
      return `fn ${c}() {}\nfn ${b}() { ${c}(); }\nfn ${a}() { ${b}(); }\n`;
    },
    recursive(name) {
      return `fn ${name}(n: usize) { if n > 0 { ${name}(n - 1); } }\n`;
    },
    member(container, caller, callee) {
      return `struct ${container};\nimpl ${container} { fn ${callee}(&self) {} fn ${caller}(&self) { self.${callee}(); } }\n`;
    },
    inheritance(base, child) {
      return `trait ${base} { fn run(&self); }\ntrait ${child}: ${base} { fn stop(&self); }\n`;
    },
    typedUse(type, name) {
      return `struct ${type};\nfn ${name}(value: ${type}) -> ${type} { value }\n`;
    },
    externalCall(local) {
      return `fn ${local}() {}\nfn run_${local}() { std::mem::${local}(()); }\n`;
    },
    unresolved(caller, missing) {
      return `fn ${caller}() { ${missing}(); }\n`;
    },
  },
};

export function languageQualityCases() {
  return [
    ...Object.entries(ADAPTERS).flatMap(([language, adapter]) => [
      ...VARIANTS.flatMap((variant, index) =>
        scenarioCases(language, adapter, variant, index),
      ),
      ...languageSpecificCases(language),
      ...crossFileCases(language),
    ]),
    ...componentScriptCases(),
    ...adaptiveSiblingCases(),
  ];
}

function componentScriptCases() {
  return [
    {
      id: "vue-script-local-call",
      language: "vue",
      category: "component-script-call",
      path: "matrix/component-script.vue",
      source: `<template><main>fixture</main></template>
<script lang="ts">
function helperVue() { return 1; }
export function runVue() { return helperVue(); }
</script>`,
      expected: {
        nodes: ["helperVue", "runVue"],
        calls: [["runVue", "helperVue"]],
      },
    },
    {
      id: "svelte-script-local-call",
      language: "svelte",
      category: "component-script-call",
      path: "matrix/component-script.svelte",
      source: `<script lang="ts">
function helperSvelte() { return 1; }
export function runSvelte() { return helperSvelte(); }
</script>
<main>fixture</main>`,
      expected: {
        nodes: ["helperSvelte", "runSvelte"],
        calls: [["runSvelte", "helperSvelte"]],
      },
    },
    {
      id: "vue-script-cross-file-call",
      language: "vue",
      category: "component-script-cross-file-call",
      files: [
        {
          path: "matrix/vue/helper.vue",
          source: `<script setup lang="ts">
export function helperVueRemote() { return 1; }
</script>`,
        },
        {
          path: "matrix/vue/main.vue",
          source: `<script setup lang="ts">
import { helperVueRemote } from "./helper";
export function runVueRemote() { return helperVueRemote(); }
</script>`,
        },
      ],
      expected: { calls: [["runVueRemote", "helperVueRemote"]] },
    },
    {
      id: "svelte-script-cross-file-call",
      language: "svelte",
      category: "component-script-cross-file-call",
      files: [
        {
          path: "matrix/svelte/helper.svelte",
          source: `<script>
export function helperSvelteRemote() { return 1; }
</script>`,
        },
        {
          path: "matrix/svelte/main.svelte",
          source: `<script>
import { helperSvelteRemote } from "./helper";
export function runSvelteRemote() { return helperSvelteRemote(); }
</script>`,
        },
      ],
      expected: { calls: [["runSvelteRemote", "helperSvelteRemote"]] },
    },
    {
      id: "vue-template-component-usage",
      language: "vue",
      category: "template-component-usage",
      files: [
        {
          path: "matrix/vue/ChildWidget.vue",
          source: `<template><span>child</span></template>`,
        },
        {
          path: "matrix/vue/ParentWidget.vue",
          source: `<script setup lang="ts">
import ChildWidget from "./ChildWidget.vue";
</script>
<template><child-widget /></template>`,
        },
      ],
      expected: { refs: [["ParentWidget", "ChildWidget"]] },
    },
    {
      id: "svelte-template-component-and-call-usage",
      language: "svelte",
      category: "template-component-usage",
      files: [
        {
          path: "matrix/svelte/ChildPanel.svelte",
          source: `<p>child</p>`,
        },
        {
          path: "matrix/svelte/ParentPanel.svelte",
          source: `<script>
import ChildPanel from "./ChildPanel.svelte";
function labelForPanel() { return "panel"; }
</script>
<ChildPanel />
<p>{labelForPanel()}</p>`,
        },
      ],
      expected: {
        refs: [["ParentPanel", "ChildPanel"]],
        calls: [["ParentPanel", "labelForPanel"]],
      },
    },
  ];
}

/**
 * Exercise adaptive Explore rendering through real parsers rather than a
 * hand-built graph. These languages spell implementation relationships
 * differently, but all project them to INHERITS; the presentation policy must
 * therefore retain one representative body and skeletonize the other siblings
 * consistently.
 */
function adaptiveSiblingCases() {
  const variants = {
    javascript: {
      extension: "js",
      base: "export class RunnerFamilyJs { run() {} }",
      implementation(name, marker) {
        return `import { RunnerFamilyJs } from "./runner"; export class ${name} extends RunnerFamilyJs { run() { return "${marker}"; } }`;
      },
    },
    jsx: {
      extension: "jsx",
      base: "export class RunnerFamilyJsx { run() {} }",
      implementation(name, marker) {
        return `import { RunnerFamilyJsx } from "./runner"; export class ${name} extends RunnerFamilyJsx { run() { return "${marker}"; } render() { return <div />; } }`;
      },
    },
    typescript: {
      extension: "ts",
      base: "export interface RunnerFamilyTs { run(): string }",
      implementation(name, marker) {
        return `import { RunnerFamilyTs } from "./runner"; export class ${name} implements RunnerFamilyTs { run(): string { return "${marker}"; } }`;
      },
    },
    tsx: {
      extension: "tsx",
      base: "export interface RunnerFamilyTsx { run(): string }",
      implementation(name, marker) {
        return `import { RunnerFamilyTsx } from "./runner"; export class ${name} implements RunnerFamilyTsx { run(): string { return "${marker}"; } render() { return <div />; } }`;
      },
    },
    python: {
      extension: "py",
      base: "class RunnerFamilyPy:\n    def run(self):\n        raise NotImplementedError\n",
      implementation(name, marker) {
        return `from runner import RunnerFamilyPy\nclass ${name}(RunnerFamilyPy):\n    def run(self):\n        return "${marker}"\n`;
      },
    },
    java: {
      extension: "java",
      base: "interface RunnerFamilyJava { String run(); }",
      implementation(name, marker) {
        return `class ${name} implements RunnerFamilyJava { public String run() { return "${marker}"; } }`;
      },
    },
    cpp: {
      extension: "h",
      base: "class RunnerFamilyCpp { public: virtual const char* run() = 0; };",
      implementation(name, marker) {
        return `#include "runner.h"\nclass ${name} : public RunnerFamilyCpp { public: const char* run() override { return "${marker}"; } };`;
      },
    },
    rust: {
      extension: "rs",
      base: "pub trait RunnerFamilyRust { fn run(&self) -> &'static str; }",
      implementation(name, marker) {
        return `use crate::runner::RunnerFamilyRust;\npub struct ${name};\nimpl RunnerFamilyRust for ${name} { fn run(&self) -> &'static str { "${marker}" } }`;
      },
    },
  };
  return Object.entries(variants).map(([language, variant]) => {
    const suffix = language[0].toUpperCase() + language.slice(1);
    const baseName = `RunnerFamily${language === "cpp" ? "Cpp" : suffix === "Javascript" ? "Js" : suffix === "Typescript" ? "Ts" : suffix === "Python" ? "Py" : suffix}`;
    const implementations = ["Alpha", "Beta", "Gamma"].map(
      (prefix) => `${prefix}Family${suffix}`,
    );
    const markers = implementations.map((name) => `${name.toUpperCase()}_BODY`);
    return {
      id: `${language}-adaptive-sibling-family`,
      language,
      category: "adaptive-sibling-family",
      files: [
        { path: `runner.${variant.extension}`, source: variant.base },
        ...implementations.map((name, index) => ({
          path: `${name.toLowerCase()}.${variant.extension}`,
          source: variant.implementation(name, markers[index]),
        })),
      ],
      expected: {
        inherits: implementations.map((name) => [name, baseName]),
        exploreRoot: baseName,
        exploreSiblingBodies: markers,
      },
    };
  });
}

export async function runLanguageQualityMatrix() {
  const reports = [];
  for (const spec of languageQualityCases()) reports.push(await runCase(spec));
  return {
    summary: summarize(reports),
    capabilities: summarizeCapabilities(reports),
    languages: Object.fromEntries(
      Object.entries(Object.groupBy(reports, (item) => item.language)).map(
        ([language, items]) => [language, summarize(items)],
      ),
    ),
    cases: reports,
  };
}

function scenarioCases(language, adapter, variant, index) {
  const suffix = `${variant}${index + 1}`;
  const names = {
    first: `first${suffix}`,
    second: `second${suffix}`,
    third: `third${suffix}`,
    container: `Container${suffix}`,
    base: `Base${suffix}`,
    child: `Child${suffix}`,
    model: `Model${suffix}`,
    missing: `missing${suffix}`,
  };
  return [
    spec("declarations", adapter.declaration(names.first, names.second), {
      nodes: [names.first, names.second],
    }),
    spec("local-call", adapter.localCall(names.first, names.second), {
      calls: [[names.first, names.second]],
    }),
    spec("duplicate-call", adapter.localCall(names.first, names.second, 2), {
      calls: [[names.first, names.second]],
      callOccurrences: 2,
    }),
    spec("call-chain", adapter.chain(names.first, names.second, names.third), {
      calls: [
        [names.first, names.second],
        [names.second, names.third],
      ],
    }),
    spec("recursion", adapter.recursive(names.first), {
      calls: [[names.first, names.first]],
    }),
    adapter.member
      ? spec(
          "member-call",
          adapter.member(names.container, names.first, names.second),
          {
            nodes: [names.container, names.first, names.second],
            calls: [[names.first, names.second]],
            contains: [[names.container, names.first]],
          },
        )
      : null,
    adapter.inheritance
      ? spec("inheritance", adapter.inheritance(names.base, names.child), {
          nodes: [names.base, names.child],
          inherits: [[names.child, names.base]],
        })
      : null,
    spec(
      "type-reference",
      adapter.typedUse(names.model, names.first),
      adapter.typedExpected?.(names.model, names.first) ?? {
        nodes: [names.model, names.first],
        referenceTarget: names.model,
      },
    ),
    spec("qualified-external", adapter.externalCall(names.second), {
      forbiddenCalls: [[`run${names.second}`, names.second]],
      forbiddenCallsLoose: [[`run_${names.second}`, names.second]],
    }),
    spec("unresolved", adapter.unresolved(names.first, names.missing), {
      unresolved: names.missing,
    }),
  ]
    .filter(Boolean)
    .map((item) => ({
      ...item,
      id: `${language}-${item.category}-${variant.toLowerCase()}`,
      language,
      path: `matrix/${item.category}-${variant.toLowerCase()}.${adapter.extension}`,
    }));
}

function languageSpecificCases(language) {
  const definitions = {
    c: [
      [
        "static-call",
        "static void help_c(void) {} void run_c(void) { help_c(); }",
        { calls: [["run_c", "help_c"]] },
      ],
      [
        "inline-call",
        "inline void help_inline_c(void) {} void run_inline_c(void) { help_inline_c(); }",
        { calls: [["run_inline_c", "help_inline_c"]] },
      ],
      [
        "variadic-call",
        'void log_c(const char *format, ...); void run_log_c(void) { log_c("x", 1); }',
        { calls: [["run_log_c", "log_c"]] },
      ],
      [
        "struct-pointer-type",
        "struct ModelC { int value; }; void use_model_c(struct ModelC *value) {}",
        { referenceTarget: "ModelC" },
      ],
      [
        "const-struct-type",
        "typedef struct ItemC { int value; } ItemC; void read_item_c(const ItemC *value) {}",
        { referenceTarget: "ItemC" },
      ],
      [
        "struct-return-type",
        "typedef struct ResultC { int value; } ResultC; ResultC make_result_c(void) { ResultC value = {0}; return value; }",
        { referenceTarget: "ResultC" },
      ],
      [
        "enum-type",
        "enum StateC { STATE_C_READY }; enum StateC state_c(enum StateC value) { return value; }",
        { referenceTarget: "StateC" },
      ],
      [
        "typedef-parameter",
        "typedef unsigned long SizeC; SizeC size_c(SizeC value) { return value; }",
        { referenceTarget: "SizeC" },
      ],
      [
        "mutual-call",
        "void second_c(void); void first_c(void) { second_c(); } void second_c(void) { first_c(); }",
        {
          calls: [
            ["first_c", "second_c"],
            ["second_c", "first_c"],
          ],
        },
      ],
      [
        "callback-call",
        "void run_callback_c(void (*callback_c)(void)) { callback_c(); }",
        { unresolved: "callback_c" },
      ],
      [
        "nested-call",
        "int inner_c(void) { return 1; } int outer_c(void) { return inner_c(); }",
        { calls: [["outer_c", "inner_c"]] },
      ],
      [
        "module-value-ref",
        "static const int MAX_RETRIES_C = 3; int retry_c(void) { return MAX_RETRIES_C; } int shadow_retry_c(int MAX_RETRIES_C) { return MAX_RETRIES_C; }",
        {
          refs: [["retry_c", "MAX_RETRIES_C"]],
          forbiddenRefs: [["shadow_retry_c", "MAX_RETRIES_C"]],
        },
      ],
      [
        "function-value-ref",
        "void target_ref_c(void) {} void consume_ref_c(void (*cb)(void)) {} void wire_ref_c(void) { consume_ref_c(target_ref_c); }",
        { refs: [["wire_ref_c", "target_ref_c"]] },
      ],
      [
        "function-pointer-array",
        "typedef int op_c(int); static int nop_c(int value) { return value; } static int halt_c(int value) { return -value; } static op_c *ops_c[] = { nop_c, halt_c }; int step_c(int index, int value) { return ops_c[index](value); }",
        {
          dynamicBoundary: {
            owner: "step_c",
            member: "<dynamic>",
            candidates: ["nop_c", "halt_c"],
            reason: "polymorphic_dispatch",
          },
        },
      ],
    ],
    javascript: [
      [
        "computed-dispatch",
        "function routeComputedJs(table, key, value) { table[key](value); }",
        {
          dynamicBoundary: {
            owner: "routeComputedJs",
            form: "computed_member",
          },
        },
      ],
      [
        "assigned-method",
        "const appJs = {}; function helperAssignedJs() {} appJs.listenJs = function listenJs() { helperAssignedJs(); };",
        {
          calls: [["listenJs", "helperAssignedJs"]],
          forbiddenRefs: [["listenJs", "listenJs"]],
        },
      ],
      [
        "async-call",
        "async function loadJs() {} async function runJs() { await loadJs(); }",
        { calls: [["runJs", "loadJs"]] },
      ],
      [
        "static-receiver",
        "class UtilJs { static helpJs() {} } function runStaticJs() { UtilJs.helpJs(); }",
        { calls: [["runStaticJs", "helpJs"]] },
      ],
      [
        "generator-call",
        "function* valuesJs() {} function runGeneratorJs() { return valuesJs(); }",
        { calls: [["runGeneratorJs", "valuesJs"]] },
      ],
      [
        "callback-call",
        "function invokeJs(callbackJs) { callbackJs(); }",
        { unresolved: "callbackJs" },
      ],
      [
        "parameter-shadow",
        "function targetJs() {} function invokeShadowJs(targetJs) { targetJs(); }",
        { forbiddenCalls: [["invokeShadowJs", "targetJs"]] },
      ],
      [
        "module-value-ref",
        "const CONFIG_JS = { rows: 10 }; function readConfigJs() { return CONFIG_JS.rows; } function shadowConfigJs(CONFIG_JS) { return CONFIG_JS.rows; }",
        {
          refs: [["readConfigJs", "CONFIG_JS"]],
          forbiddenRefs: [["shadowConfigJs", "CONFIG_JS"]],
        },
      ],
      [
        "new-expression",
        "class ItemJs {} function makeJs() { return new ItemJs(); }",
        { calls: [["makeJs", "ItemJs"]] },
      ],
      [
        "constructed-owner-field",
        "class ClientFieldJs { sendFieldJs() {} } class UseFieldJs { constructor() { this.client = new ClientFieldJs(); } invokeFieldJs() { this.client.sendFieldJs(); } }",
        { calls: [["invokeFieldJs", "sendFieldJs"]] },
      ],
      [
        "untyped-factory-assignment",
        "class ProductDynamicJs { buildDynamicJs() {} } class UnrelatedDynamicJs { buildDynamicJs() {} } function makeDynamicJs() { return new ProductDynamicJs(); } function runDynamicJs() { const product = makeDynamicJs(); product.buildDynamicJs(); }",
        { calls: [["runDynamicJs", "buildDynamicJs"]] },
      ],
      [
        "conflicting-untyped-factory",
        "class AlphaFactoryJs { buildConflictJs() {} } class BetaFactoryJs { buildConflictJs() {} } function chooseFactoryJs(flag) { if (flag) return new AlphaFactoryJs(); return new BetaFactoryJs(); } function runConflictJs(flag) { const product = chooseFactoryJs(flag); product.buildConflictJs(); }",
        {
          dynamicBoundary: {
            owner: "runConflictJs",
            member: "buildConflictJs",
            reason: "unknown_receiver_type",
          },
          forbiddenCalls: [["runConflictJs", "buildConflictJs"]],
        },
      ],
      [
        "async-factory-is-not-a-direct-instance",
        "class AsyncProductJs { buildAsyncJs() {} } class AsyncDecoyJs { buildAsyncJs() {} } export async function makeAsyncJs() { return new AsyncProductJs(); } function runAsyncJs() { const product = makeAsyncJs(); product.buildAsyncJs(); }",
        {
          dynamicBoundary: {
            owner: "runAsyncJs",
            member: "buildAsyncJs",
            reason: "unknown_receiver_type",
          },
          forbiddenCalls: [["runAsyncJs", "buildAsyncJs"]],
        },
      ],
      [
        "nested-async-does-not-mark-outer-factory-async",
        "class NestedAsyncProductJs { buildNestedAsyncJs() {} } class NestedAsyncDecoyJs { buildNestedAsyncJs() {} } function makeNestedAsyncJs() { async function helperNestedAsyncJs() { return 1; } return new NestedAsyncProductJs(); } function runNestedAsyncJs() { const product = makeNestedAsyncJs(); product.buildNestedAsyncJs(); }",
        { calls: [["runNestedAsyncJs", "buildNestedAsyncJs"]] },
      ],
      [
        "function-value-ref",
        "function targetRefJs() {} function consumeRefJs(cb) {} function wireRefJs() { consumeRefJs(targetRefJs); }",
        { refs: [["wireRefJs", "targetRefJs"]] },
      ],
    ],
    jsx: [
      [
        "computed-dispatch",
        "function routeComputedJsx(table, value) { table['save'](value); }",
        {
          dynamicBoundary: {
            owner: "routeComputedJsx",
            form: "computed_member",
            key: "save",
          },
        },
      ],
      [
        "assigned-method",
        "const appJsx = {}; function helperAssignedJsx() {} appJsx.listenJsx = function listenJsx() { helperAssignedJsx(); };",
        {
          calls: [["listenJsx", "helperAssignedJsx"]],
          forbiddenRefs: [["listenJsx", "listenJsx"]],
        },
      ],
      [
        "async-call",
        "async function loadJsx() {} async function runJsx() { await loadJsx(); }",
        { calls: [["runJsx", "loadJsx"]] },
      ],
      [
        "component-call",
        "function CardJsx() { return <div />; } function AppJsx() { return CardJsx(); }",
        { calls: [["AppJsx", "CardJsx"]] },
      ],
      [
        "component-reference",
        "function CardRefJsx() { return <div />; } function AppRefJsx() { return <CardRefJsx />; }",
        { referenceTarget: "CardRefJsx" },
      ],
      [
        "component-prop-reference",
        "function ProfilePropJsx() { return <div />; } function RoutePropJsx({ component }) { return component; } function AppPropJsx() { return <RoutePropJsx component={ProfilePropJsx} />; }",
        { referenceTarget: "ProfilePropJsx" },
      ],
      [
        "callback-call",
        "function invokeJsx(callbackJsx) { callbackJsx(); }",
        { unresolved: "callbackJsx" },
      ],
      [
        "parameter-shadow",
        "function targetJsx() {} function invokeShadowJsx(targetJsx) { targetJsx(); }",
        { forbiddenCalls: [["invokeShadowJsx", "targetJsx"]] },
      ],
      [
        "module-value-ref",
        "const THEME_JSX = { color: 'red' }; function LabelJsx() { return <span style={{ color: THEME_JSX.color }} />; }",
        { refs: [["LabelJsx", "THEME_JSX"]] },
      ],
      [
        "class-component",
        "class BaseJsx {} class PageJsx extends BaseJsx { render() { return <main />; } }",
        { inherits: [["PageJsx", "BaseJsx"]] },
      ],
      [
        "function-value-ref",
        "function targetRefJsx() { return <div/>; } function consumeRefJsx(cb) {} function wireRefJsx() { consumeRefJsx(targetRefJsx); }",
        { refs: [["wireRefJsx", "targetRefJsx"]] },
      ],
    ],
    typescript: [
      [
        "union-typed-receiver",
        "class AlphaUnionTs { runUnionTs() {} } class BetaUnionTs { runUnionTs() {} } function invokeUnionTs(value: AlphaUnionTs | BetaUnionTs) { value.runUnionTs(); }",
        {
          dynamicBoundary: {
            owner: "invokeUnionTs",
            member: "runUnionTs",
            candidate: "runUnionTs",
            reason: "polymorphic_dispatch",
          },
          forbiddenCalls: [["invokeUnionTs", "runUnionTs"]],
        },
      ],
      [
        "union-typed-local",
        "class AlphaLocalTs { saveLocalTs() {} } class BetaLocalTs { saveLocalTs() {} } declare function chooseLocalTs(): AlphaLocalTs | BetaLocalTs; function invokeLocalTs() { const value: AlphaLocalTs | BetaLocalTs = chooseLocalTs(); value.saveLocalTs(); }",
        {
          dynamicBoundary: {
            owner: "invokeLocalTs",
            member: "saveLocalTs",
            candidate: "saveLocalTs",
            reason: "polymorphic_dispatch",
          },
          forbiddenCalls: [["invokeLocalTs", "saveLocalTs"]],
        },
      ],
      [
        "cyclic-type-alias-stays-unresolved",
        "type CycleAliasATs = CycleAliasBTs; type CycleAliasBTs = CycleAliasATs; class AliasDecoyTs { runCycleAliasTs() {} } function invokeCycleAliasTs(value: CycleAliasATs) { value.runCycleAliasTs(); }",
        {
          dynamicBoundary: {
            owner: "invokeCycleAliasTs",
            member: "runCycleAliasTs",
            reason: "unknown_receiver_type",
          },
          forbiddenCalls: [["invokeCycleAliasTs", "runCycleAliasTs"]],
        },
      ],
      [
        "nullable-typed-receiver",
        "class ClientNullableTs { sendNullableTs() {} } function invokeNullableTs(value: ClientNullableTs | null) { value.sendNullableTs(); }",
        { calls: [["invokeNullableTs", "sendNullableTs"]] },
      ],
      [
        "typed-factory-assignment",
        "class ProductAssignedTs { buildAssignedTs() {} } function makeAssignedTs(): ProductAssignedTs { return new ProductAssignedTs(); } function runAssignedTs() { const product = makeAssignedTs(); product.buildAssignedTs(); }",
        { calls: [["runAssignedTs", "buildAssignedTs"]] },
      ],
      [
        "inferred-factory-assignment",
        "class ProductFactoryTs { buildFactoryTs() {} } class UnrelatedFactoryTs { buildFactoryTs() {} } function makeFactoryTs() { return new ProductFactoryTs(); } function runFactoryTs() { const product = makeFactoryTs(); product.buildFactoryTs(); }",
        { calls: [["runFactoryTs", "buildFactoryTs"]] },
      ],
      [
        "conflicting-untyped-factory",
        "class AlphaFactoryTs { buildConflictTs() {} } class BetaFactoryTs { buildConflictTs() {} } function chooseFactoryTs(flag: boolean) { if (flag) return new AlphaFactoryTs(); return new BetaFactoryTs(); } function runConflictTs(flag: boolean) { const product = chooseFactoryTs(flag); product.buildConflictTs(); }",
        {
          dynamicBoundary: {
            owner: "runConflictTs",
            member: "buildConflictTs",
            reason: "unknown_receiver_type",
          },
          forbiddenCalls: [["runConflictTs", "buildConflictTs"]],
        },
      ],
      [
        "async-owner-factory-is-not-a-direct-instance",
        "class AsyncProductMethodTs { buildAsyncMethodTs() {} } class AsyncMethodDecoyTs { buildAsyncMethodTs() {} } class AsyncFactoryTs { async makeAsyncMethodTs(): Promise<AsyncProductMethodTs> { return new AsyncProductMethodTs(); } runAsyncMethodTs() { const product = this.makeAsyncMethodTs(); product.buildAsyncMethodTs(); } }",
        {
          dynamicBoundary: {
            owner: "runAsyncMethodTs",
            member: "buildAsyncMethodTs",
            reason: "unknown_receiver_type",
          },
          forbiddenCalls: [["runAsyncMethodTs", "buildAsyncMethodTs"]],
        },
      ],
      [
        "owner-factory-chain",
        "class OwnerChainProductTs { buildOwnerChainTs() {} } class OwnerChainTs { makeOwnerChainTs(): OwnerChainProductTs { return new OwnerChainProductTs(); } runOwnerChainTs() { this.makeOwnerChainTs().buildOwnerChainTs(); } }",
        { calls: [["runOwnerChainTs", "buildOwnerChainTs"]] },
      ],
      [
        "async-owner-factory-chain-does-not-use-bare-decoy",
        "class AsyncChainProductTs { buildAsyncChainTs() {} } class AsyncChainDecoyTs { buildAsyncChainTs() {} } function makeAsyncChainTs(): AsyncChainDecoyTs { return new AsyncChainDecoyTs(); } class AsyncChainOwnerTs { async makeAsyncChainTs(): Promise<AsyncChainProductTs> { return new AsyncChainProductTs(); } runAsyncChainTs() { this.makeAsyncChainTs().buildAsyncChainTs(); } }",
        {
          dynamicBoundary: {
            owner: "runAsyncChainTs",
            member: "buildAsyncChainTs",
            reason: "unknown_receiver_type",
          },
          forbiddenCalls: [["runAsyncChainTs", "buildAsyncChainTs"]],
        },
      ],
      [
        "computed-dispatch",
        "function routeComputedTs(table: Record<string, (value: unknown) => void>, key: string, value: unknown) { table[key](value); }",
        {
          dynamicBoundary: {
            owner: "routeComputedTs",
            form: "computed_member",
          },
        },
      ],
      [
        "assigned-method",
        "const appTs: Record<string, unknown> = {}; function helperAssignedTs() {} appTs.listenTs = function listenTs() { helperAssignedTs(); };",
        {
          calls: [["listenTs", "helperAssignedTs"]],
          forbiddenRefs: [["listenTs", "listenTs"]],
        },
      ],
      [
        "interface-extends",
        "interface ParentTs { run(): void } interface ChildTs extends ParentTs { stop(): void }",
        { inherits: [["ChildTs", "ParentTs"]] },
      ],
      [
        "class-implements",
        "interface RunnerTs { run(): void } class WorkerTs implements RunnerTs { run() {} }",
        { inherits: [["WorkerTs", "RunnerTs"]] },
      ],
      [
        "async-call",
        "async function loadTs() {} async function runTs() { await loadTs(); }",
        { calls: [["runTs", "loadTs"]] },
      ],
      [
        "generic-type",
        "class PayloadTs {} function mapTs<T extends PayloadTs>(value: T): PayloadTs { return value; }",
        { referenceTarget: "PayloadTs" },
      ],
      [
        "static-receiver",
        "class UtilTs { static helpTs() {} } function runStaticTs() { UtilTs.helpTs(); }",
        { calls: [["runStaticTs", "helpTs"]] },
      ],
      [
        "parameter-shadow",
        "function targetTs() {} function invokeShadowTs(targetTs: () => void) { targetTs(); }",
        { forbiddenCalls: [["invokeShadowTs", "targetTs"]] },
      ],
      [
        "module-value-ref",
        "const CONFIG_TS = { rows: 10 }; function readConfigTs() { return CONFIG_TS.rows; } function shadowConfigTs(CONFIG_TS: { rows: number }) { return CONFIG_TS.rows; }",
        {
          refs: [["readConfigTs", "CONFIG_TS"]],
          forbiddenRefs: [["shadowConfigTs", "CONFIG_TS"]],
        },
      ],
      [
        "function-value-ref",
        "function targetRefTs(): void {} function consumeRefTs(cb: () => void): void {} function wireRefTs(): void { consumeRefTs(targetRefTs); }",
        { refs: [["wireRefTs", "targetRefTs"]] },
      ],
      [
        "exported-object-factory-actions",
        "interface StoreTs { resetTs(): void } export const useStoreTs = create<StoreTs>((set, get) => ({ fetchTs: () => resetTs(), resetTs: () => set({}) }));",
        {
          contains: [
            ["useStoreTs", "fetchTs"],
            ["useStoreTs", "resetTs"],
          ],
          calls: [["fetchTs", "resetTs"]],
        },
      ],
    ],
    tsx: [
      [
        "computed-dispatch",
        "function routeComputedTsx(table: Record<string, (value: unknown) => void>, value: unknown) { table['save'](value); return <div/>; }",
        {
          dynamicBoundary: {
            owner: "routeComputedTsx",
            form: "computed_member",
            key: "save",
          },
        },
      ],
      [
        "assigned-method",
        "const appTsx: Record<string, unknown> = {}; function helperAssignedTsx() {} appTsx.listenTsx = function listenTsx() { helperAssignedTsx(); };",
        {
          calls: [["listenTsx", "helperAssignedTsx"]],
          forbiddenRefs: [["listenTsx", "listenTsx"]],
        },
      ],
      [
        "async-call",
        "async function loadTsx() {} async function runTsx() { await loadTsx(); }",
        { calls: [["runTsx", "loadTsx"]] },
      ],
      [
        "component-call",
        "function CardTsx(): JSX.Element { return <div />; } function AppTsx() { return CardTsx(); }",
        { calls: [["AppTsx", "CardTsx"]] },
      ],
      [
        "component-reference",
        "function CardRefTsx() { return <div />; } function AppRefTsx() { return <CardRefTsx />; }",
        { referenceTarget: "CardRefTsx" },
      ],
      [
        "component-prop-reference",
        "function ProfilePropTsx() { return <div />; } function RoutePropTsx(props: { component: unknown }) { return props.component; } function AppPropTsx() { return <RoutePropTsx component={ProfilePropTsx} />; }",
        { referenceTarget: "ProfilePropTsx" },
      ],
      [
        "generic-component",
        "type PropsTsx<T> = { value: T }; function ViewTsx<T>(props: PropsTsx<T>) { return <div />; }",
        { referenceTarget: "PropsTsx" },
      ],
      [
        "interface-extends",
        "interface ParentTsx { run(): void } interface ChildTsx extends ParentTsx { stop(): void }",
        { inherits: [["ChildTsx", "ParentTsx"]] },
      ],
      [
        "parameter-shadow",
        "function targetTsx() { return <div />; } function invokeShadowTsx(targetTsx: () => void) { targetTsx(); return <div />; }",
        { forbiddenCalls: [["invokeShadowTsx", "targetTsx"]] },
      ],
      [
        "module-value-ref",
        "const THEME_TSX = { color: 'red' }; function LabelTsx() { return <span style={{ color: THEME_TSX.color }} />; }",
        { refs: [["LabelTsx", "THEME_TSX"]] },
      ],
      [
        "function-value-ref",
        "function targetRefTsx() { return <div/>; } function consumeRefTsx(cb: () => unknown) {} function wireRefTsx() { consumeRefTsx(targetRefTsx); }",
        { refs: [["wireRefTsx", "targetRefTsx"]] },
      ],
      [
        "hoc-wrapped-component-body",
        "declare function forwardRefTsx<T>(render: T): T; function useThingTsx() { return 1; } export const WidgetTsx = forwardRefTsx((props: unknown, ref: unknown) => { const value = useThingTsx(); return <div>{value}</div>; });",
        { calls: [["WidgetTsx", "useThingTsx"]] },
      ],
    ],
    python: [
      [
        "abstract-base-dispatch",
        "from abc import ABC, abstractmethod\nclass RunnerAbstractPy(ABC):\n    @abstractmethod\n    def run_abstract_py(self): ...\nclass AlphaAbstractPy(RunnerAbstractPy):\n    def run_abstract_py(self): return 1\nclass BetaAbstractPy(RunnerAbstractPy):\n    def run_abstract_py(self): return 2\ndef invoke_abstract_py(value: RunnerAbstractPy):\n    return value.run_abstract_py()\n",
        {
          dynamicBoundary: {
            owner: "invoke_abstract_py",
            member: "run_abstract_py",
            candidateScopes: ["AlphaAbstractPy", "BetaAbstractPy"],
            forbiddenCandidateScopes: ["RunnerAbstractPy"],
            reason: "polymorphic_dispatch",
          },
          forbiddenCalls: [["invoke_abstract_py", "run_abstract_py"]],
        },
      ],
      [
        "implicit-abstract-stub-dispatch",
        "from abc import ABC\nclass RunnerStubPy(ABC):\n    def run_stub_py(self):\n        raise NotImplementedError\nclass AlphaStubPy(RunnerStubPy):\n    def run_stub_py(self): return 1\nclass BetaStubPy(RunnerStubPy):\n    def run_stub_py(self): return 2\ndef invoke_stub_py(value: RunnerStubPy):\n    return value.run_stub_py()\n",
        {
          dynamicBoundary: {
            owner: "invoke_stub_py",
            member: "run_stub_py",
            candidateScopes: ["AlphaStubPy", "BetaStubPy"],
            forbiddenCandidateScopes: ["RunnerStubPy"],
            reason: "polymorphic_dispatch",
          },
          forbiddenCalls: [["invoke_stub_py", "run_stub_py"]],
        },
      ],
      [
        "union-typed-receiver",
        "class AlphaUnionPy:\n    def run_union_py(self): return 1\nclass BetaUnionPy:\n    def run_union_py(self): return 2\ndef invoke_union_py(value: AlphaUnionPy | BetaUnionPy):\n    return value.run_union_py()\n",
        {
          dynamicBoundary: {
            owner: "invoke_union_py",
            member: "run_union_py",
            candidate: "run_union_py",
            reason: "polymorphic_dispatch",
          },
          forbiddenCalls: [["invoke_union_py", "run_union_py"]],
        },
      ],
      [
        "union-typed-local",
        "class AlphaLocalPy:\n    def save_local_py(self): return 1\nclass BetaLocalPy:\n    def save_local_py(self): return 2\ndef choose_local_py(): return AlphaLocalPy()\ndef invoke_local_py():\n    value: AlphaLocalPy | BetaLocalPy = choose_local_py()\n    return value.save_local_py()\n",
        {
          dynamicBoundary: {
            owner: "invoke_local_py",
            member: "save_local_py",
            candidate: "save_local_py",
            reason: "polymorphic_dispatch",
          },
          forbiddenCalls: [["invoke_local_py", "save_local_py"]],
        },
      ],
      [
        "optional-typed-receiver",
        "from typing import Optional\nclass ClientOptionalPy:\n    def send_optional_py(self): return 1\ndef invoke_optional_py(value: Optional[ClientOptionalPy]):\n    return value.send_optional_py() if value else None\n",
        { calls: [["invoke_optional_py", "send_optional_py"]] },
      ],
      [
        "constructed-owner-field",
        "class ClientFieldPy:\n    def send_field_py(self): return 1\nclass UseFieldPy:\n    def __init__(self):\n        self.client = ClientFieldPy()\n    def invoke_field_py(self):\n        return self.client.send_field_py()\n",
        { calls: [["invoke_field_py", "send_field_py"]] },
      ],
      [
        "flexible-arity-method",
        "class ExecutorFlexiblePy:\n    def execute_flexible_py(self, query, **kwargs): return query\ndef invoke_flexible_py(executor: ExecutorFlexiblePy):\n    return executor.execute_flexible_py('MATCH')\n",
        { calls: [["invoke_flexible_py", "execute_flexible_py"]] },
      ],
      [
        "conflicting-constructor-field-types",
        "class AlphaFieldPy:\n    def send_field_py(self): return 1\nclass BetaFieldPy:\n    def send_field_py(self): return 2\nclass ServiceFieldPy:\n    def __init__(self, alpha: AlphaFieldPy, beta: BetaFieldPy, flag):\n        if flag: self.client = alpha\n        else: self.client = beta\n    def invoke_field_py(self):\n        return self.client.send_field_py()\n",
        {
          dynamicBoundary: {
            owner: "invoke_field_py",
            member: "send_field_py",
            reason: "unknown_receiver_type",
          },
          forbiddenCalls: [["invoke_field_py", "send_field_py"]],
        },
      ],
      [
        "typed-factory-assignment",
        "class ProductAssignedPy:\n    def build_assigned_py(self): return 1\ndef make_assigned_py() -> ProductAssignedPy:\n    return ProductAssignedPy()\ndef run_assigned_py():\n    product = make_assigned_py()\n    return product.build_assigned_py()\n",
        { calls: [["run_assigned_py", "build_assigned_py"]] },
      ],
      [
        "inferred-factory-assignment",
        "class ProductFactoryPy:\n    def build_factory_py(self): return 1\nclass UnrelatedFactoryPy:\n    def build_factory_py(self): return 2\ndef make_factory_py():\n    return ProductFactoryPy()\ndef run_factory_py():\n    product = make_factory_py()\n    return product.build_factory_py()\n",
        { calls: [["run_factory_py", "build_factory_py"]] },
      ],
      [
        "conflicting-untyped-factory",
        "class AlphaFactoryPy:\n    def build_conflict_py(self): return 1\nclass BetaFactoryPy:\n    def build_conflict_py(self): return 2\ndef choose_factory_py(flag):\n    if flag: return AlphaFactoryPy()\n    return BetaFactoryPy()\ndef run_conflict_py(flag):\n    product = choose_factory_py(flag)\n    return product.build_conflict_py()\n",
        {
          dynamicBoundary: {
            owner: "run_conflict_py",
            member: "build_conflict_py",
            reason: "unknown_receiver_type",
          },
          forbiddenCalls: [["run_conflict_py", "build_conflict_py"]],
        },
      ],
      [
        "async-factory-is-not-a-direct-instance",
        "class AsyncProductPy:\n    def build_async_py(self): return 1\nclass AsyncDecoyPy:\n    def build_async_py(self): return 2\nasync def make_async_py() -> AsyncProductPy:\n    return AsyncProductPy()\ndef run_async_py():\n    product = make_async_py()\n    return product.build_async_py()\n",
        {
          dynamicBoundary: {
            owner: "run_async_py",
            member: "build_async_py",
            reason: "unknown_receiver_type",
          },
          forbiddenCalls: [["run_async_py", "build_async_py"]],
        },
      ],
      [
        "constructor-assignment-with-decoy",
        "class ClientConstructedPy:\n    def send_constructed_py(self): return 1\nclass DecoyConstructedPy:\n    def send_constructed_py(self): return 2\ndef run_constructed_py():\n    client = ClientConstructedPy()\n    return client.send_constructed_py()\n",
        { calls: [["run_constructed_py", "send_constructed_py"]] },
      ],
      [
        "decorated-function-typed-receiver",
        "def endpoint_py(fn): return fn\nclass ClientDecoratedPy:\n    def send_decorated_py(self): return 1\nclass DecoyDecoratedPy:\n    def send_decorated_py(self): return 2\n@endpoint_py\ndef run_decorated_py(client: ClientDecoratedPy):\n    return client.send_decorated_py()\n",
        { calls: [["run_decorated_py", "send_decorated_py"]] },
      ],
      [
        "getattr-dispatch",
        "def route_getattr_py(target, name, value):\n    return getattr(target, name)(value)\n",
        {
          dynamicBoundary: { owner: "route_getattr_py", form: "getattr" },
        },
      ],
      [
        "multiple-inheritance",
        "class LeftPy: pass\nclass RightPy: pass\nclass ChildPy(LeftPy, RightPy): pass\n",
        {
          inherits: [
            ["ChildPy", "LeftPy"],
            ["ChildPy", "RightPy"],
          ],
        },
      ],
      [
        "async-call",
        "async def load_py(): return 1\nasync def run_py(): return await load_py()\n",
        { calls: [["run_py", "load_py"]] },
      ],
      [
        "classmethod-receiver",
        "class FactoryPy:\n    @classmethod\n    def make_py(cls): return cls.build_py()\n    @classmethod\n    def build_py(cls): return cls()\n",
        { calls: [["make_py", "build_py"]] },
      ],
      [
        "super-receiver",
        "class BasePy:\n    def help_py(self): return 1\nclass ChildPy(BasePy):\n    def run_py(self): return super().help_py()\n",
        { calls: [["run_py", "help_py"]] },
      ],
      [
        "decorator-ref",
        "def traced_py(fn): return fn\n@traced_py\ndef run_py(): return 1\n",
        { referenceTarget: "traced_py" },
      ],
      [
        "parameter-shadow",
        "def target_py(): return 1\ndef invoke_shadow_py(target_py): return target_py()\n",
        { forbiddenCalls: [["invoke_shadow_py", "target_py"]] },
      ],
      [
        "module-value-ref",
        "HAS_SSL_PY = True\ndef uses_ssl_py(): return HAS_SSL_PY\ndef shadows_ssl_py(HAS_SSL_PY): return HAS_SSL_PY\n",
        {
          refs: [["uses_ssl_py", "HAS_SSL_PY"]],
          forbiddenRefs: [["shadows_ssl_py", "HAS_SSL_PY"]],
        },
      ],
      [
        "conditional-module-value",
        "try:\n    CONDITIONAL_PY = True\nexcept ImportError:\n    CONDITIONAL_PY = False\ndef reads_conditional_py(): return CONDITIONAL_PY\n",
        { refs: [["reads_conditional_py", "CONDITIONAL_PY"]] },
      ],
      [
        "function-value-ref",
        "def target_ref_py(): pass\ndef consume_ref_py(cb): pass\ndef wire_ref_py(): consume_ref_py(target_ref_py)\n",
        { refs: [["wire_ref_py", "target_ref_py"]] },
      ],
      [
        "assigned-getattr-dispatch",
        'def route_assigned_py(target, kind, value):\n    handler = getattr(target, "handle_" + kind)\n    return handler(value)\n',
        {
          dynamicBoundary: {
            owner: "route_assigned_py",
            form: "getattr",
            key: "handle_",
          },
        },
      ],
    ],
    java: [
      [
        "interface-implements",
        "interface RunnerJava { void run(); } class WorkerJava implements RunnerJava { public void run() {} }",
        { inherits: [["WorkerJava", "RunnerJava"]] },
      ],
      [
        "interface-extends",
        "interface ParentJava { void run(); } interface ChildJava extends ParentJava { void stop(); }",
        { inherits: [["ChildJava", "ParentJava"]] },
      ],
      [
        "static-receiver",
        "class UtilJava { static void helpJava() {} } class RunJava { void runJava() { UtilJava.helpJava(); } }",
        { calls: [["runJava", "helpJava"]] },
      ],
      [
        "chained-constructor-receiver",
        "class BuilderChainJava { void finishChainJava() {} } class DecoyChainJava { void finishChainJava() {} } class RunChainJava { void runChainJava() { new BuilderChainJava().finishChainJava(); } }",
        { calls: [["runChainJava", "finishChainJava"]] },
      ],
      [
        "super-receiver",
        "class BaseJava { void helpJava() {} } class ChildJava extends BaseJava { void runJava() { super.helpJava(); } }",
        { calls: [["runJava", "helpJava"]] },
      ],
      [
        "annotation-ref",
        "@interface MarkerJava {} class UseJava { @MarkerJava void runJava() {} }",
        { referenceTarget: "MarkerJava" },
      ],
      [
        "class-constant-ref",
        "class LimitsJava { static final int TIMEOUT_JAVA = 30; int readsJava() { return TIMEOUT_JAVA; } int shadowsJava() { int TIMEOUT_JAVA = 5; return TIMEOUT_JAVA; } }",
        {
          refs: [["readsJava", "TIMEOUT_JAVA"]],
          forbiddenRefs: [["shadowsJava", "TIMEOUT_JAVA"]],
        },
      ],
      [
        "function-value-ref",
        "class CallbackJava { static void targetRefJava() {} static void consumeRefJava(Runnable cb) {} void wireRefJava() { consumeRefJava(CallbackJava::targetRefJava); } }",
        { refs: [["wireRefJava", "targetRefJava"]] },
      ],
      [
        "reflection-dispatch",
        'class ReflectJava { void routeJava(Object target) throws Exception { target.getClass().getMethod("saveJava").invoke(target); } }',
        {
          dynamicBoundary: {
            owner: "routeJava",
            form: "reflection",
            key: "saveJava",
          },
        },
      ],
    ],
    cpp: [
      [
        "virtual-inheritance",
        "class BaseCpp { public: virtual void run() = 0; }; class ChildCpp : public BaseCpp { public: void run() override {} };",
        { inherits: [["ChildCpp", "BaseCpp"]] },
      ],
      [
        "pointer-receiver",
        "class WorkerCpp { public: void helpCpp() {} void runCpp() { this->helpCpp(); } };",
        { calls: [["runCpp", "helpCpp"]] },
      ],
      [
        "static-receiver",
        "class UtilCpp { public: static void helpCpp() {} }; void runCpp() { UtilCpp::helpCpp(); }",
        { calls: [["runCpp", "helpCpp"]] },
      ],
      [
        "template-type",
        "class PayloadCpp {}; PayloadCpp mapCpp(PayloadCpp value) { return value; }",
        { referenceTarget: "PayloadCpp" },
      ],
      [
        "constructor",
        "class ItemCpp {}; void makeCpp() { ItemCpp value; }",
        { referenceTarget: "ItemCpp" },
      ],
      [
        "template-call",
        "template<class T> void helperTemplateCpp() {} void runTemplateCpp() { helperTemplateCpp<int>(); }",
        { calls: [["runTemplateCpp", "helperTemplateCpp"]] },
      ],
      [
        "module-value-ref",
        "constexpr int MAX_RETRIES_CPP = 3; int retry_cpp() { return MAX_RETRIES_CPP; } int shadow_retry_cpp(int MAX_RETRIES_CPP) { return MAX_RETRIES_CPP; }",
        {
          refs: [["retry_cpp", "MAX_RETRIES_CPP"]],
          forbiddenRefs: [["shadow_retry_cpp", "MAX_RETRIES_CPP"]],
        },
      ],
      [
        "function-value-ref",
        "void target_ref_cpp() {} void consume_ref_cpp(void (*cb)()) {} void wire_ref_cpp() { consume_ref_cpp(&target_ref_cpp); }",
        { refs: [["wire_ref_cpp", "target_ref_cpp"]] },
      ],
      [
        "function-pointer-array",
        "using op_cpp = int(int); int nop_cpp(int value) { return value; } int halt_cpp(int value) { return -value; } op_cpp *ops_cpp[] = { nop_cpp, halt_cpp }; int step_cpp(int index, int value) { return ops_cpp[index](value); }",
        {
          dynamicBoundary: {
            owner: "step_cpp",
            member: "<dynamic>",
            candidates: ["nop_cpp", "halt_cpp"],
            reason: "polymorphic_dispatch",
          },
        },
      ],
    ],
    go: [
      [
        "interface-embedding",
        "package fixture\ntype ParentGo interface { Run() }\ntype ChildGo interface { ParentGo; Stop() }\n",
        { inherits: [["ChildGo", "ParentGo"]] },
      ],
      [
        "pointer-method",
        "package fixture\ntype WorkerGo struct{}\nfunc (w *WorkerGo) helpGo() {}\nfunc (w *WorkerGo) runGo() { w.helpGo() }\n",
        { calls: [["runGo", "helpGo"]] },
      ],
      [
        "field-chain-call",
        "package fixture\ntype StoreFieldGo struct{}\nfunc (*StoreFieldGo) PutFieldGo() {}\ntype RepoFieldGo struct { db *StoreFieldGo }\nfunc (repo *RepoFieldGo) SaveFieldGo() { repo.db.PutFieldGo() }\n",
        { calls: [["SaveFieldGo", "PutFieldGo"]] },
      ],
      [
        "factory-chain-call",
        "package fixture\ntype ProductFactoryGo struct{}\nfunc NewProductFactoryGo() *ProductFactoryGo { return &ProductFactoryGo{} }\nfunc (*ProductFactoryGo) BuildFactoryGo() {}\nfunc RunFactoryGo() { NewProductFactoryGo().BuildFactoryGo() }\n",
        { calls: [["RunFactoryGo", "BuildFactoryGo"]] },
      ],
      [
        "defer-call",
        "package fixture\nfunc closeGo() {}\nfunc runGo() { defer closeGo() }\n",
        { calls: [["runGo", "closeGo"]] },
      ],
      [
        "goroutine-call",
        "package fixture\nfunc serveGo() {}\nfunc runGo() { go serveGo() }\n",
        { calls: [["runGo", "serveGo"]] },
      ],
      [
        "generic-type",
        "package fixture\ntype PayloadGo struct{}\nfunc mapGo[T ~[]PayloadGo](value T) T { return value }\n",
        { referenceTarget: "PayloadGo" },
      ],
      [
        "parameter-shadow",
        "package fixture\nfunc targetGo() {}\nfunc invokeShadowGo(targetGo func()) { targetGo() }\n",
        { forbiddenCalls: [["invokeShadowGo", "targetGo"]] },
      ],
      [
        "package-value-ref",
        "package fixture\nconst MaxRetriesGo = 3\nfunc retryGo() int { return MaxRetriesGo }\nfunc shadowRetryGo(MaxRetriesGo int) int { return MaxRetriesGo }\n",
        {
          refs: [["retryGo", "MaxRetriesGo"]],
          forbiddenRefs: [["shadowRetryGo", "MaxRetriesGo"]],
        },
      ],
      [
        "function-value-ref",
        "package fixture\nfunc targetRefGo() {}\nfunc consumeRefGo(cb func()) {}\nfunc wireRefGo() { consumeRefGo(targetRefGo) }\n",
        { refs: [["wireRefGo", "targetRefGo"]] },
      ],
    ],
    rust: [
      [
        "trait-impl",
        "trait RunnerRust { fn run(&self); } struct WorkerRust; impl RunnerRust for WorkerRust { fn run(&self) {} }",
        { inherits: [["WorkerRust", "RunnerRust"]] },
      ],
      [
        "supertrait",
        "trait ParentRust { fn run(&self); } trait ChildRust: ParentRust { fn stop(&self); }",
        { inherits: [["ChildRust", "ParentRust"]] },
      ],
      [
        "self-receiver",
        "struct WorkerRust; impl WorkerRust { fn help_rust(&self) {} fn run_rust(&self) { self.help_rust(); } }",
        { calls: [["run_rust", "help_rust"]] },
      ],
      [
        "associated-call",
        "struct UtilRust; impl UtilRust { fn help_rust() {} } fn run_rust() { UtilRust::help_rust(); }",
        { calls: [["run_rust", "help_rust"]] },
      ],
      [
        "self-return-factory-chain",
        "struct ProductSelfRust; impl ProductSelfRust { fn make() -> Self { ProductSelfRust } fn build_self_rust(&self) {} } fn run_self_rust() { ProductSelfRust::make().build_self_rust(); }",
        { calls: [["run_self_rust", "build_self_rust"]] },
      ],
      [
        "qualified-self-return-factory-chain",
        "struct AlphaChainRust; impl AlphaChainRust { fn new() -> Self { AlphaChainRust } fn finish_chain_rust(&self) {} } struct BetaChainRust; impl BetaChainRust { fn new() -> Self { BetaChainRust } fn finish_chain_rust(&self) {} } fn run_chain_rust() { AlphaChainRust::new().finish_chain_rust(); }",
        { calls: [["run_chain_rust", "finish_chain_rust"]] },
      ],
      [
        "async-call",
        "async fn load_rust() {} async fn run_rust() { load_rust().await; }",
        { calls: [["run_rust", "load_rust"]] },
      ],
      [
        "parameter-shadow",
        "fn target_rust() {} fn invoke_shadow_rust(target_rust: fn()) { target_rust(); }",
        { forbiddenCalls: [["invoke_shadow_rust", "target_rust"]] },
      ],
      [
        "module-value-ref",
        "const MAX_RETRIES_RUST: u32 = 3; fn retry_rust() -> u32 { MAX_RETRIES_RUST } fn shadow_retry_rust(MAX_RETRIES_RUST: u32) -> u32 { MAX_RETRIES_RUST }",
        {
          refs: [["retry_rust", "MAX_RETRIES_RUST"]],
          forbiddenRefs: [["shadow_retry_rust", "MAX_RETRIES_RUST"]],
        },
      ],
      [
        "function-value-ref",
        "fn target_ref_rust() {} fn consume_ref_rust(cb: fn()) {} fn wire_ref_rust() { consume_ref_rust(target_ref_rust); }",
        { refs: [["wire_ref_rust", "target_ref_rust"]] },
      ],
      [
        "turbofish-call",
        "fn helper_turbofish_rust<T>() {} fn run_turbofish_rust() { helper_turbofish_rust::<u32>(); }",
        { calls: [["run_turbofish_rust", "helper_turbofish_rust"]] },
      ],
    ],
  };
  const cases = definitions[language].map(([category, source, expected]) => ({
    id: `${language}-${category}`,
    language,
    category,
    source,
    expected,
    path: `matrix/${category}.${ADAPTERS[language].extension}`,
  }));
  const helper = `helperCrlf${language.replace(/[^A-Za-z]/g, "")}`;
  const run = `runCrlf${language.replace(/[^A-Za-z]/g, "")}`;
  const source = ADAPTERS[language]
    .localCall(run, helper)
    .replace(/(?<!\r)\n/g, "\r\n");
  return [
    ...cases,
    {
      id: `${language}-crlf-call`,
      language,
      category: "crlf-call",
      source,
      expected: { calls: [[run, helper]] },
      path: `matrix/crlf-call.${ADAPTERS[language].extension}`,
    },
  ];
}

function spec(category, source, expected) {
  return { category, source, expected };
}

function crossFileCases(language) {
  const definitions = {
    c: [
      [
        "header-call",
        [
          ["lib.h", "void help_c(void);"],
          ["lib.c", '#include "lib.h"\nvoid help_c(void) {}'],
          ["main.c", '#include "lib.h"\nvoid run_c(void) { help_c(); }'],
        ],
        { calls: [["run_c", "help_c"]] },
      ],
      [
        "cross-file-call",
        [
          ["helper.c", "void work_c(void) {}"],
          ["main.c", "void work_c(void); void run_work_c(void) { work_c(); }"],
        ],
        { calls: [["run_work_c", "work_c"]] },
      ],
      [
        "cross-file-type",
        [
          ["model.h", "typedef struct ModelC { int value; } ModelC;"],
          [
            "use.c",
            '#include "model.h"\nModelC use_c(ModelC value) { return value; }',
          ],
        ],
        { referenceTarget: "ModelC" },
      ],
      [
        "nested-header-call",
        [
          ["detail/helper.h", "void nested_help_c(void);"],
          [
            "main.c",
            '#include "detail/helper.h"\nvoid nested_run_c(void) { nested_help_c(); }',
          ],
        ],
        { calls: [["nested_run_c", "nested_help_c"]] },
      ],
      [
        "multiple-header-call",
        [
          ["first.h", "void first_header_c(void);"],
          ["second.h", "void second_header_c(void);"],
          [
            "main.c",
            '#include "first.h"\n#include "second.h"\nvoid headers_c(void) { first_header_c(); second_header_c(); }',
          ],
        ],
        {
          calls: [
            ["headers_c", "first_header_c"],
            ["headers_c", "second_header_c"],
          ],
        },
      ],
      [
        "cross-header-function-pointer",
        [
          ["ops.h", "struct ops_c { int (*handler)(int); };"],
          [
            "register.c",
            '#include "ops.h"\nstatic int handle_c(int value) { return value; }\nvoid register_c(struct ops_c *ops) { ops->handler = handle_c; }',
          ],
          [
            "dispatch.c",
            '#include "ops.h"\nint dispatch_c(struct ops_c *ops, int value) { return ops->handler(value); }',
          ],
        ],
        {
          dynamicBoundary: {
            owner: "dispatch_c",
            member: "handler",
            candidate: "handle_c",
            reason: "polymorphic_dispatch",
          },
        },
      ],
    ],
    javascript: javascriptCrossFileDefinitions("js", "Js"),
    jsx: javascriptCrossFileDefinitions("jsx", "Jsx"),
    typescript: [
      [
        "nodenext-emitted-extension-import",
        [
          ["service.ts", "export function executeNodeNextTs() {}"],
          [
            "main.ts",
            'import { executeNodeNextTs } from "./service.js"; export function runNodeNextTs() { executeNodeNextTs(); }',
          ],
        ],
        { calls: [["runNodeNextTs", "executeNodeNextTs"]] },
      ],
      [
        "cross-file-factory-chain",
        [
          [
            "product.ts",
            "export class ProductTs { buildTs() {} } export function newProductTs(value: number): ProductTs { return new ProductTs(); }",
          ],
          [
            "main.ts",
            'import { newProductTs } from "./product"; export function runFactoryTs() { newProductTs(1).buildTs(); }',
          ],
        ],
        { calls: [["runFactoryTs", "buildTs"]] },
      ],
      [
        "import-call",
        [
          ["lib.ts", "export function helpTs() {}"],
          [
            "main.ts",
            'import { helpTs } from "./lib"; export function runTs() { helpTs(); }',
          ],
        ],
        { calls: [["runTs", "helpTs"]] },
      ],
      [
        "alias-import",
        [
          ["codec.ts", "export function decodeTs() {}"],
          [
            "main.ts",
            'import { decodeTs as parseTs } from "./codec"; export function runTs() { parseTs(); }',
          ],
        ],
        { calls: [["runTs", "decodeTs"]] },
      ],
      [
        "namespace-import",
        [
          ["util.ts", "export function formatTs() {}"],
          [
            "main.ts",
            'import * as util from "./util"; export function runTs() { util.formatTs(); }',
          ],
        ],
        { calls: [["runTs", "formatTs"]] },
      ],
      [
        "cross-file-inheritance",
        [
          ["base.ts", "export class BaseTs { helpTs() {} }"],
          [
            "child.ts",
            'import { BaseTs } from "./base"; export class ChildTs extends BaseTs { runTs() { this.helpTs(); } }',
          ],
        ],
        { inherits: [["ChildTs", "BaseTs"]], calls: [["runTs", "helpTs"]] },
      ],
      [
        "cross-file-type",
        [
          ["model.ts", "export interface ModelTs {}"],
          [
            "use.ts",
            'import type { ModelTs } from "./model"; export function useTs(value: ModelTs): ModelTs { return value; }',
          ],
        ],
        { referenceTarget: "ModelTs" },
      ],
      [
        "cross-file-typed-receiver",
        [
          ["client.ts", "export class ClientTypedTs { executeTypedTs() {} }"],
          [
            "use.ts",
            'import { ClientTypedTs } from "./client"; export function invokeTypedTs(client: ClientTypedTs) { client.executeTypedTs(); }',
          ],
        ],
        { calls: [["invokeTypedTs", "executeTypedTs"]] },
      ],
    ],
    tsx: [
      ...javascriptCrossFileDefinitions("tsx", "Tsx"),
      [
        "hoc-component-reference",
        [
          [
            "button.tsx",
            "declare function forwardRefTsx<T>(render: T): T; export const ButtonTsx = forwardRefTsx((props: unknown, ref: unknown) => <button />);",
          ],
          [
            "page.tsx",
            'import { ButtonTsx } from "./button"; export function PageTsx() { return <ButtonTsx />; }',
          ],
        ],
        { refs: [["PageTsx", "ButtonTsx"]] },
      ],
    ],
    python: [
      [
        "cross-file-factory-chain",
        [
          [
            "product.py",
            "class ProductPy:\n    def build_py(self): return 1\ndef new_product_py(value: int) -> 'ProductPy':\n    return ProductPy()\n",
          ],
          [
            "main.py",
            "from .product import new_product_py\ndef run_factory_py():\n    return new_product_py(1).build_py()\n",
          ],
        ],
        { calls: [["run_factory_py", "build_py"]] },
      ],
      [
        "package-child-module",
        [
          ["pkg/__init__.py", ""],
          ["pkg/util.py", "def help_package_py():\n    return 1\n"],
          [
            "main.py",
            "from pkg import util\ndef run_package_py():\n    return util.help_package_py()\n",
          ],
        ],
        { calls: [["run_package_py", "help_package_py"]] },
      ],
      [
        "import-call",
        [
          ["lib.py", "def help_py():\n    return 1\n"],
          [
            "main.py",
            "from .lib import help_py\ndef run_py():\n    return help_py()\n",
          ],
        ],
        { calls: [["run_py", "help_py"]] },
      ],
      [
        "alias-import",
        [
          ["codec.py", "def decode_py():\n    return 1\n"],
          [
            "main.py",
            "from .codec import decode_py as parse_py\ndef run_py():\n    return parse_py()\n",
          ],
        ],
        { calls: [["run_py", "decode_py"]] },
      ],
      [
        "module-import",
        [
          ["util.py", "def format_py():\n    return 1\n"],
          [
            "main.py",
            "from . import util\ndef run_py():\n    return util.format_py()\n",
          ],
        ],
        { calls: [["run_py", "format_py"]] },
      ],
      [
        "cross-file-inheritance",
        [
          ["base.py", "class BasePy:\n    def help_py(self): return 1\n"],
          [
            "child.py",
            "from .base import BasePy\nclass ChildPy(BasePy):\n    def run_py(self): return self.help_py()\n",
          ],
        ],
        { inherits: [["ChildPy", "BasePy"]], calls: [["run_py", "help_py"]] },
      ],
      [
        "cross-file-type",
        [
          ["model.py", "class ModelPy: pass\n"],
          [
            "use.py",
            "from .model import ModelPy\ndef use_py(value: ModelPy) -> ModelPy:\n    return value\n",
          ],
        ],
        { referenceTarget: "ModelPy" },
      ],
      [
        "cross-file-typed-receiver",
        [
          [
            "query_executor.py",
            "class QueryExecutorPy:\n    def execute_query_py(self): return 1\n",
          ],
          [
            "operations.py",
            "from .query_executor import QueryExecutorPy\ndef save_typed_py(executor: QueryExecutorPy):\n    return executor.execute_query_py()\n",
          ],
        ],
        { calls: [["save_typed_py", "execute_query_py"]] },
      ],
      [
        "annotated-type-alias-receiver",
        [
          [
            "service.py",
            "class ServiceAliasPy:\n    def execute_alias_py(self): return 1\n",
          ],
          [
            "aliases.py",
            "from typing import Annotated\nfrom .service import ServiceAliasPy\nServiceDepPy = Annotated[ServiceAliasPy, 'dependency']\n",
          ],
          [
            "use.py",
            "from .aliases import ServiceDepPy\ndef invoke_alias_py(service: ServiceDepPy):\n    return service.execute_alias_py()\n",
          ],
        ],
        { calls: [["invoke_alias_py", "execute_alias_py"]] },
      ],
      [
        "visible-type-alias-wins-over-same-name",
        [
          [
            "alpha.py",
            "class AlphaAliasPy:\n    def execute_scoped_alias_py(self): return 1\n",
          ],
          ["beta.py", "class BetaAliasPy: pass\n"],
          [
            "a_alias.py",
            "from typing import Annotated\nfrom .alpha import AlphaAliasPy\nSharedDepPy = Annotated[AlphaAliasPy, 'a']\n",
          ],
          [
            "b_alias.py",
            "from typing import Annotated\nfrom .beta import BetaAliasPy\nSharedDepPy = Annotated[BetaAliasPy, 'b']\n",
          ],
          [
            "use.py",
            "from .a_alias import SharedDepPy\ndef invoke_scoped_alias_py(service: SharedDepPy):\n    return service.execute_scoped_alias_py()\n",
          ],
        ],
        { calls: [["invoke_scoped_alias_py", "execute_scoped_alias_py"]] },
      ],
      [
        "constructor-injected-field",
        [
          [
            "driver.py",
            "class DriverInjectedPy:\n    def execute_injected_py(self): return 1\n",
          ],
          [
            "service.py",
            "from .driver import DriverInjectedPy\nclass ServiceInjectedPy:\n    def __init__(self, driver: DriverInjectedPy):\n        self.driver = driver\n    def run_injected_py(self):\n        return self.driver.execute_injected_py()\n",
          ],
        ],
        { calls: [["run_injected_py", "execute_injected_py"]] },
      ],
      [
        "cross-file-class-construction",
        [
          [
            "graphiti.py",
            "class GraphitiPy:\n    def __init__(self, uri): self.uri = uri\n",
          ],
          [
            "server.py",
            "from .graphiti import GraphitiPy\ndef initialize_py():\n    return GraphitiPy('bolt://localhost')\n",
          ],
        ],
        { calls: [["initialize_py", "GraphitiPy"]] },
      ],
      [
        "untyped-qualified-sdk-call",
        [
          [
            "contract.py",
            "class ContractPy:\n    def send_sdk_py(self, value): raise NotImplementedError()\n",
          ],
          [
            "client.py",
            "from .contract import ContractPy\nclass ClientPy(ContractPy):\n    def invoke_sdk_py(self, value):\n        return self.remote.transport.send_sdk_py(value)\n",
          ],
        ],
        { forbiddenCalls: [["invoke_sdk_py", "send_sdk_py"]] },
      ],
    ],
    java: [
      [
        "package-wildcard-import",
        [
          [
            "pkg/HelperWildcardJava.java",
            "package pkg; public class HelperWildcardJava { public static void executeWildcardJava() {} }",
          ],
          [
            "pkg/DecoyWildcardJava.java",
            "package pkg; public class DecoyWildcardJava { public static void unrelatedWildcardJava() {} }",
          ],
          [
            "app/MainWildcardJava.java",
            "package app; import pkg.*; class MainWildcardJava { void runWildcardJava() { HelperWildcardJava.executeWildcardJava(); } }",
          ],
        ],
        { calls: [["runWildcardJava", "executeWildcardJava"]] },
      ],
      [
        "cross-file-factory-chain",
        [
          [
            "ProductJava.java",
            "class ProductJava { void buildJava() {} static ProductJava createJava(int value) { return new ProductJava(); } }",
          ],
          [
            "MainJava.java",
            "class MainJava { void runFactoryJava() { ProductJava.createJava(1).buildJava(); } }",
          ],
        ],
        { calls: [["runFactoryJava", "buildJava"]] },
      ],
      [
        "fqn-import-call",
        [
          [
            "com/alpha/ServiceJava.java",
            "package com.alpha; public class ServiceJava { public static void helpFqnJava() {} }",
          ],
          [
            "app/MainJava.java",
            "package app; import com.alpha.ServiceJava; class MainJava { void runFqnJava() { ServiceJava.helpFqnJava(); } }",
          ],
        ],
        { calls: [["runFqnJava", "helpFqnJava"]] },
      ],
      [
        "cross-file-call",
        [
          ["LibJava.java", "class LibJava { static void helpJava() {} }"],
          [
            "MainJava.java",
            "class MainJava { void runJava() { LibJava.helpJava(); } }",
          ],
        ],
        { calls: [["runJava", "helpJava"]] },
      ],
      [
        "package-call",
        [
          [
            "HelperJava.java",
            "package fixture; class HelperJava { static void workJava() {} }",
          ],
          [
            "UseJava.java",
            "package fixture; class UseJava { void runJava() { HelperJava.workJava(); } }",
          ],
        ],
        { calls: [["runJava", "workJava"]] },
      ],
      [
        "cross-file-inheritance",
        [
          ["BaseJava.java", "class BaseJava { void helpJava() {} }"],
          [
            "ChildJava.java",
            "class ChildJava extends BaseJava { void runJava() { this.helpJava(); } }",
          ],
        ],
        {
          inherits: [["ChildJava", "BaseJava"]],
          calls: [["runJava", "helpJava"]],
        },
      ],
      [
        "cross-file-interface",
        [
          ["RunnerJava.java", "interface RunnerJava { void run(); }"],
          [
            "WorkerJava.java",
            "class WorkerJava implements RunnerJava { public void run() {} }",
          ],
        ],
        { inherits: [["WorkerJava", "RunnerJava"]] },
      ],
      [
        "cross-file-type",
        [
          ["ModelJava.java", "class ModelJava {}"],
          [
            "UseJava.java",
            "class UseJava { ModelJava useJava(ModelJava value) { return value; } }",
          ],
        ],
        { referenceTarget: "ModelJava" },
      ],
    ],
    cpp: [
      [
        "cross-file-factory-chain",
        [
          [
            "product.h",
            "#include <memory>\nclass ProductFactoryCpp { public: void build_factory_cpp(); }; std::unique_ptr<ProductFactoryCpp> new_product_factory_cpp(int value);",
          ],
          [
            "main.cpp",
            '#include "product.h"\nvoid run_factory_cpp() { new_product_factory_cpp(1)->build_factory_cpp(); }',
          ],
        ],
        { calls: [["run_factory_cpp", "build_factory_cpp"]] },
      ],
      [
        "header-call",
        [
          ["lib.h", "void help_cpp();"],
          ["lib.cpp", '#include "lib.h"\nvoid help_cpp() {}'],
          ["main.cpp", '#include "lib.h"\nvoid run_cpp() { help_cpp(); }'],
        ],
        { calls: [["run_cpp", "help_cpp"]] },
      ],
      [
        "qualified-call",
        [
          ["util.h", "class UtilCpp { public: static void help_cpp(); };"],
          ["util.cpp", '#include "util.h"\nvoid UtilCpp::help_cpp() {}'],
          [
            "main.cpp",
            '#include "util.h"\nvoid run_cpp() { UtilCpp::help_cpp(); }',
          ],
        ],
        { calls: [["run_cpp", "help_cpp"]] },
      ],
      [
        "cross-file-inheritance",
        [
          ["base.h", "class BaseCpp { public: void help_cpp(); };"],
          [
            "child.h",
            '#include "base.h"\nclass ChildCpp : public BaseCpp { public: void run_cpp(); };',
          ],
          [
            "child.cpp",
            '#include "child.h"\nvoid ChildCpp::run_cpp() { this->help_cpp(); }',
          ],
        ],
        {
          inherits: [["ChildCpp", "BaseCpp"]],
          calls: [["run_cpp", "help_cpp"]],
        },
      ],
      [
        "header-definition",
        [
          ["model.h", "class ModelCpp {};"],
          [
            "use.cpp",
            '#include "model.h"\nModelCpp use_cpp(ModelCpp value) { return value; }',
          ],
        ],
        { referenceTarget: "ModelCpp" },
      ],
      [
        "namespace-call",
        [
          ["util.h", "namespace util_cpp { void help(); }"],
          ["util.cpp", '#include "util.h"\nvoid util_cpp::help() {}'],
          [
            "main.cpp",
            '#include "util.h"\nvoid run_cpp() { util_cpp::help(); }',
          ],
        ],
        { calls: [["run_cpp", "help"]] },
      ],
    ],
    go: [
      [
        "cross-file-factory-chain",
        [
          [
            "product.go",
            "package fixture\ntype ProductFactoryGo struct{}\nfunc NewProductFactoryGo() *ProductFactoryGo { return &ProductFactoryGo{} }\nfunc (*ProductFactoryGo) BuildFactoryGo() {}\n",
          ],
          [
            "main.go",
            "package fixture\nfunc RunFactoryGo() { NewProductFactoryGo().BuildFactoryGo() }\n",
          ],
        ],
        { calls: [["RunFactoryGo", "BuildFactoryGo"]] },
      ],
      [
        "package-call",
        [
          ["lib.go", "package fixture\nfunc helpGo() {}\n"],
          ["main.go", "package fixture\nfunc runGo() { helpGo() }\n"],
        ],
        { calls: [["runGo", "helpGo"]] },
      ],
      [
        "receiver-call",
        [
          [
            "worker.go",
            "package fixture\ntype WorkerGo struct{}\nfunc (w WorkerGo) helpGo() {}\n",
          ],
          [
            "main.go",
            "package fixture\nfunc runGo(w WorkerGo) { w.helpGo() }\n",
          ],
        ],
        { calls: [["runGo", "helpGo"]] },
      ],
      [
        "interface-implementation",
        [
          ["runner.go", "package fixture\ntype RunnerGo interface { Run() }\n"],
          [
            "worker.go",
            "package fixture\ntype WorkerGo struct{}\nfunc (WorkerGo) Run() {}\n",
          ],
        ],
        { nodes: ["RunnerGo", "WorkerGo", "Run"] },
      ],
      [
        "embedded-interface",
        [
          ["base.go", "package fixture\ntype BaseGo interface { Stop() }\n"],
          [
            "runner.go",
            "package fixture\ntype RunnerGo interface { BaseGo; Run() }\n",
          ],
        ],
        { inherits: [["RunnerGo", "BaseGo"]] },
      ],
      [
        "cross-file-type",
        [
          ["model.go", "package fixture\ntype ModelGo struct{}\n"],
          [
            "use.go",
            "package fixture\nfunc useGo(value ModelGo) ModelGo { return value }\n",
          ],
        ],
        { referenceTarget: "ModelGo" },
      ],
    ],
    rust: [
      [
        "cross-file-factory-chain",
        [
          [
            "product.rs",
            "pub struct ProductRust; impl ProductRust { pub fn build_rust(&self) {} } pub fn new_product_rust(value: i32) -> Box<ProductRust> { Box::new(ProductRust) }\n",
          ],
          [
            "lib.rs",
            "mod product; fn run_factory_rust() { product::new_product_rust(1).build_rust(); }\n",
          ],
        ],
        { calls: [["run_factory_rust", "build_rust"]] },
      ],
      [
        "module-call",
        [
          ["lib.rs", "mod helper;\nfn run_rust() { helper::help_rust(); }\n"],
          ["helper.rs", "pub fn help_rust() {}\n"],
        ],
        { calls: [["run_rust", "help_rust"]] },
      ],
      [
        "use-alias",
        [
          [
            "lib.rs",
            "mod codec;\nuse codec::decode_rust as parse_rust;\nfn run_rust() { parse_rust(); }\n",
          ],
          ["codec.rs", "pub fn decode_rust() {}\n"],
        ],
        { calls: [["run_rust", "decode_rust"]] },
      ],
      [
        "cross-file-trait",
        [
          ["runner.rs", "pub trait RunnerRust { fn run(&self); }\n"],
          [
            "worker.rs",
            "use crate::runner::RunnerRust;\nstruct WorkerRust;\nimpl RunnerRust for WorkerRust { fn run(&self) {} }\n",
          ],
        ],
        { inherits: [["WorkerRust", "RunnerRust"]] },
      ],
      [
        "cross-file-associated",
        [
          [
            "util.rs",
            "pub struct UtilRust;\nimpl UtilRust { pub fn help_rust() {} }\n",
          ],
          [
            "main.rs",
            "mod util;\nfn run_rust() { util::UtilRust::help_rust(); }\n",
          ],
        ],
        { calls: [["run_rust", "help_rust"]] },
      ],
      [
        "cross-file-type",
        [
          ["model.rs", "pub struct ModelRust;\n"],
          [
            "use_model.rs",
            "use crate::model::ModelRust;\nfn use_rust(value: ModelRust) -> ModelRust { value }\n",
          ],
        ],
        { referenceTarget: "ModelRust" },
      ],
      [
        "inline-module-super-import",
        [
          [
            "lib.rs",
            "fn helper_rust() {}\nmod tests { use super::helper_rust; fn check_rust() { helper_rust(); } }\n",
          ],
        ],
        {
          calls: [["check_rust", "helper_rust"]],
          failedRefCount: 0,
        },
      ],
    ],
  };
  return definitions[language].map(([category, files, expected]) => ({
    id: `${language}-${category}`,
    language,
    category,
    files: files.map(([path, source]) => ({
      path: `matrix/${language}/${path}`,
      source,
    })),
    expected,
  }));
}

function javascriptCrossFileDefinitions(extension, suffix) {
  const help = `help${suffix}`;
  const run = `run${suffix}`;
  const decode = `decode${suffix}`;
  const parse = `parse${suffix}`;
  const format = `format${suffix}`;
  const base = `Base${suffix}`;
  const child = `Child${suffix}`;
  const model = `Model${suffix}`;
  return [
    [
      "import-call",
      [
        [`lib.${extension}`, `export function ${help}() {}`],
        [
          `main.${extension}`,
          `import { ${help} } from "./lib"; export function ${run}() { ${help}(); }`,
        ],
      ],
      { calls: [[run, help]] },
    ],
    [
      "alias-import",
      [
        [`codec.${extension}`, `export function ${decode}() {}`],
        [
          `main.${extension}`,
          `import { ${decode} as ${parse} } from "./codec"; export function ${run}() { ${parse}(); }`,
        ],
      ],
      { calls: [[run, decode]] },
    ],
    [
      "namespace-import",
      [
        [`util.${extension}`, `export function ${format}() {}`],
        [
          `main.${extension}`,
          `import * as util from "./util"; export function ${run}() { util.${format}(); }`,
        ],
      ],
      { calls: [[run, format]] },
    ],
    [
      "cross-file-inheritance",
      [
        [`base.${extension}`, `export class ${base} { ${help}() {} }`],
        [
          `child.${extension}`,
          `import { ${base} } from "./base"; export class ${child} extends ${base} { ${run}() { this.${help}(); } }`,
        ],
      ],
      { inherits: [[child, base]], calls: [[run, help]] },
    ],
    [
      "cross-file-type",
      [
        [`model.${extension}`, `export class ${model} {}`],
        [
          `use.${extension}`,
          `import { ${model} } from "./model"; export function use${suffix}(value) { return new ${model}(); }`,
        ],
      ],
      { calls: [[`use${suffix}`, model]] },
    ],
  ];
}

async function runCase(spec) {
  try {
    const sources = (
      spec.files ?? [{ path: spec.path, source: spec.source }]
    ).map(({ path, source }, index) => ({
      kind: "text",
      file: {
        id: `${spec.id}:${index}`,
        collectionId: "quality-matrix",
        absolutePath: `/fixture/${path}`,
        relativePath: path,
        rootPath: "/fixture",
        sizeBytes: source.length,
        lastModifiedTime: 1,
        kind: "code",
        format: spec.language,
      },
      text: source,
    }));
    const analyses = [];
    for (const source of sources) {
      const prepared = await new CodeExtractor().analyzeForIndexing(source);
      const fragments = prepared.fragments.map((item) => item.fragment);
      analyses.push({
        source,
        fragments,
        input: await extractFileGraph(source, fragments, prepared),
      });
    }
    const input = {
      nodes: analyses.flatMap(({ input }) => input.nodes),
      edges: analyses.flatMap(({ input }) => input.edges),
      refs: analyses.flatMap(({ input }) => input.refs),
    };
    const graph = new SqliteGraphStorage("", { inMemory: true });
    try {
      for (const analysis of analyses) {
        graph.upsertFileGraph(
          analysis.source.file.id,
          analysis.input.nodes,
          analysis.input.edges,
          analysis.input.refs,
        );
      }
      await graph.resolvePending({ files: sources.map(({ file }) => file) });
      const failures = verify(spec.expected, input, graph);
      verifyExplore(spec, analyses, input, graph, failures);
      verifyImpact(spec.expected, input, graph, failures);
      return {
        id: spec.id,
        language: spec.language,
        category: spec.category,
        multiFile: sources.length > 1,
        capabilities: caseCapabilities(spec.expected, sources.length > 1),
        failures,
      };
    } finally {
      graph.close();
    }
  } catch (error) {
    return {
      id: spec.id,
      language: spec.language,
      category: spec.category,
      multiFile: (spec.files?.length ?? 1) > 1,
      capabilities: caseCapabilities(
        spec.expected,
        (spec.files?.length ?? 1) > 1,
      ),
      failures: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function verifyExplore(spec, analyses, input, graph, failures) {
  const rootName =
    spec.expected.exploreRoot ??
    spec.expected.calls?.[0]?.[0] ??
    spec.expected.inherits?.[0]?.[0] ??
    spec.expected.contains?.[0]?.[0] ??
    spec.expected.nodes?.[0] ??
    spec.expected.referenceTarget ??
    input.nodes[0]?.name;
  if (!rootName) return;
  const entities = analyses.flatMap(({ source, fragments }) =>
    fragments.map((entity) => ({ file: source.file, entity })),
  );
  const byId = new Map(entities.map((entity) => [entity.entity.id, entity]));
  const storage = {
    findSymbolsByName(name, limit) {
      return entities
        .filter(
          (entity) => symbolName(entity).toLowerCase() === name.toLowerCase(),
        )
        .slice(0, limit);
    },
    findSymbolsByQuery(query, limit) {
      const normalized = query.toLowerCase();
      return entities
        .filter((entity) =>
          `${symbolName(entity)} ${entity.entity.content.text}`
            .toLowerCase()
            .includes(normalized),
        )
        .slice(0, limit);
    },
    getEntity(id) {
      return byId.get(id) ?? null;
    },
    readFileText(file) {
      return analyses.find(({ source }) => source.file.id === file.id)?.source
        .text;
    },
  };
  Object.assign(graph, storage);
  const result = exploreGraph(graph, {
    query: rootName,
    searchLimit: 8,
    traversalDepth: 2,
    maxNodes: 48,
    maxFiles: spec.expected.exploreSiblingBodies ? 4 : 3,
    maxChars: spec.expected.exploreSiblingBodies ? 12_000 : 4_000,
  });
  const rootIds = new Set(result.roots.map((root) => root.id));
  const expectedIds = new Set(
    input.nodes.filter((node) => node.name === rootName).map((node) => node.id),
  );
  if (![...expectedIds].some((id) => rootIds.has(id)))
    failures.push(`Explore missed root ${rootName}`);
  const expectedRootFileIds = new Set(
    entities
      .filter((entity) => expectedIds.has(entity.entity.id))
      .map((entity) => entity.file.id),
  );
  if (
    expectedRootFileIds.size > 0 &&
    !result.files.some((item) => expectedRootFileIds.has(item.file.id))
  )
    failures.push(`Explore missed source file for ${rootName}`);
  if (spec.expected.exploreSiblingBodies) {
    const output = result.files.map((file) => file.text).join("\n");
    const retainedBodies = spec.expected.exploreSiblingBodies.filter((marker) =>
      output.includes(marker),
    );
    const skeletons = result.files.filter((file) =>
      file.text.includes("implementation body elided (polymorphic sibling)"),
    );
    if (retainedBodies.length !== 1)
      failures.push(
        `Explore retained ${retainedBodies.length} sibling bodies; expected one exemplar`,
      );
    if (skeletons.length !== spec.expected.exploreSiblingBodies.length - 1)
      failures.push(
        `Explore rendered ${skeletons.length} sibling skeletons; expected ${spec.expected.exploreSiblingBodies.length - 1}`,
      );
  }
}

function verifyImpact(expected, input, graph, failures) {
  const pair =
    expected.calls?.[0] ?? expected.refs?.[0] ?? expected.inherits?.[0];
  if (!pair) return;
  const [dependentName, targetName] = pair;
  // Impact intentionally excludes the focal symbol itself.
  if (dependentName === targetName) return;
  const dependentIds = new Set(
    input.nodes
      .filter((node) => node.name === dependentName)
      .map((node) => node.id),
  );
  const targets = input.nodes.filter((node) => node.name === targetName);
  if (targets.length === 0) return;
  const impacted = new Set(
    targets.flatMap((target) =>
      graph.impact(target.id, 1, 100).map((item) => item.id),
    ),
  );
  if (![...dependentIds].some((id) => impacted.has(id)))
    failures.push(`impact(${targetName}) missed ${dependentName}`);
}

function verify(expected, input, graph) {
  const failures = [];
  const byName = Map.groupBy(input.nodes, (node) => node.name);
  for (const name of expected.nodes ?? []) {
    if (!byName.has(name)) failures.push(`missing node ${name}`);
  }
  verifyPairs("CALLS", expected.calls, input, graph, failures);
  verifyPairs("REFS", expected.refs, input, graph, failures);
  verifyPairs("CONTAINS", expected.contains, input, graph, failures);
  verifyPairs("INHERITS", expected.inherits, input, graph, failures);
  for (const [src, dst] of [
    ...(expected.forbiddenCalls ?? []),
    ...(expected.forbiddenCallsLoose ?? []),
  ]) {
    if (
      hasPair("CALLS", src, dst, input) ||
      hasStoredPair("CALLS", src, dst, input, graph)
    )
      failures.push(`unexpected CALLS ${src}->${dst}`);
  }
  for (const [src, dst] of expected.forbiddenRefs ?? []) {
    if (
      hasPair("REFS", src, dst, input) ||
      hasStoredPair("REFS", src, dst, input, graph)
    )
      failures.push(`unexpected REFS ${src}->${dst}`);
  }
  if (expected.callOccurrences !== undefined) {
    const count = input.edges.filter((edge) => edge.kind === "CALLS").length;
    if (count !== expected.callOccurrences)
      failures.push(
        `CALLS occurrences ${count} != ${expected.callOccurrences}`,
      );
  }
  if (
    expected.failedRefCount !== undefined &&
    graph.stats().failedRefCount !== expected.failedRefCount
  )
    failures.push(
      `failed refs ${graph.stats().failedRefCount} != ${expected.failedRefCount}`,
    );
  if (expected.referenceTarget) {
    const targetIds = new Set(
      byName.get(expected.referenceTarget)?.map((node) => node.id),
    );
    const resolved = input.edges.some(
      (edge) => edge.kind === "REFS" && targetIds.has(edge.dst),
    );
    const stored = [...byName.keys()].some((ownerName) =>
      hasStoredPair("REFS", ownerName, expected.referenceTarget, input, graph),
    );
    if (!resolved && !stored)
      failures.push(`missing type reference ${expected.referenceTarget}`);
  }
  if (expected.unresolved) {
    const stats = graph.stats();
    const pending = input.refs.some(
      (ref) => ref.ref_name === expected.unresolved,
    );
    const ownerIds = input.refs
      .filter((ref) => ref.ref_name === expected.unresolved)
      .map((ref) => ref.owner);
    const dynamic = graph
      .dynamicBoundaries(ownerIds, 100)
      .some((boundary) => boundary.target.raw === expected.unresolved);
    if (!pending || (stats.refCount < 1 && !dynamic))
      failures.push(`missing unresolved reference ${expected.unresolved}`);
  }
  if (expected.dynamicBoundary) {
    const ownerIds = input.nodes
      .filter((node) => node.name === expected.dynamicBoundary.owner)
      .map((node) => node.id);
    const expectedCandidateNames = [
      ...(expected.dynamicBoundary.candidates ?? []),
      ...(expected.dynamicBoundary.candidate
        ? [expected.dynamicBoundary.candidate]
        : []),
    ];
    const candidateIds = new Set(
      input.nodes
        .filter((node) => expectedCandidateNames.includes(node.name))
        .map((node) => node.id),
    );
    const expectedCandidateScopes = new Set(
      expected.dynamicBoundary.candidateScopes ?? [],
    );
    const forbiddenCandidateScopes = new Set(
      expected.dynamicBoundary.forbiddenCandidateScopes ?? [],
    );
    const matched = graph.dynamicBoundaries(ownerIds, 100).some((boundary) => {
      const candidateScopes = new Set(
        boundary.candidates
          .map((id) => input.nodes.find((node) => node.id === id)?.scope)
          .filter(Boolean),
      );
      return (
        boundary.reason ===
          (expected.dynamicBoundary.reason ?? "runtime_dispatch") &&
        (expected.dynamicBoundary.form === undefined ||
          boundary.target.hints?.dynamicDispatch?.form ===
            expected.dynamicBoundary.form) &&
        (expected.dynamicBoundary.key === undefined ||
          boundary.target.hints?.dynamicDispatch?.key ===
            expected.dynamicBoundary.key) &&
        (expected.dynamicBoundary.member === undefined ||
          boundary.target.member === expected.dynamicBoundary.member) &&
        (expectedCandidateNames.length === 0 ||
          [...candidateIds].every((id) => boundary.candidates.includes(id))) &&
        [...expectedCandidateScopes].every((scope) =>
          candidateScopes.has(scope),
        ) &&
        [...forbiddenCandidateScopes].every(
          (scope) => !candidateScopes.has(scope),
        )
      );
    });
    if (!matched) {
      const observed = graph
        .dynamicBoundaries(ownerIds, 100)
        .map((boundary) => ({
          reason: boundary.reason,
          member: boundary.target.member,
          form: boundary.target.hints?.dynamicDispatch?.form,
          candidates: boundary.candidates.map((id) => {
            const node = input.nodes.find((candidate) => candidate.id === id);
            return node
              ? `${node.scope ? `${node.scope}::` : ""}${node.name}`
              : id;
          }),
        }));
      failures.push(
        `missing ${expected.dynamicBoundary.form ?? expected.dynamicBoundary.member ?? "dynamic"} boundary for ${expected.dynamicBoundary.owner}; observed=${JSON.stringify(observed)}`,
      );
    }
  }
  return failures;
}

function verifyPairs(kind, pairs = [], input, graph, failures) {
  for (const [src, dst] of pairs) {
    if (
      !hasPair(kind, src, dst, input) &&
      !hasStoredPair(kind, src, dst, input, graph)
    )
      failures.push(`missing ${kind} ${src}->${dst}`);
  }
}

function hasStoredPair(kind, src, dst, input, graph) {
  const srcIds = new Set(
    input.nodes.filter((node) => node.name === src).map((node) => node.id),
  );
  const dstIds = new Set(
    input.nodes.filter((node) => node.name === dst).map((node) => node.id),
  );
  return graph
    .outgoingEdges([...srcIds], [kind], 100)
    .some((edge) => dstIds.has(edge.dst));
}

function hasPair(kind, src, dst, input) {
  const idsByName = (name) =>
    new Set(
      input.nodes.filter((node) => node.name === name).map((node) => node.id),
    );
  const srcIds = idsByName(src);
  const dstIds = idsByName(dst);
  return input.edges.some(
    (edge) =>
      edge.kind === kind && srcIds.has(edge.src) && dstIds.has(edge.dst),
  );
}

function summarize(reports) {
  return {
    cases: reports.length,
    passed: reports.filter((item) => item.failures.length === 0).length,
    failed: reports.filter((item) => item.failures.length > 0).length,
  };
}

function caseCapabilities(expected, multiFile) {
  return {
    deterministic:
      (expected.calls?.length ?? 0) > 0 ||
      (expected.refs?.length ?? 0) > 0 ||
      (expected.contains?.length ?? 0) > 0 ||
      (expected.inherits?.length ?? 0) > 0 ||
      expected.referenceTarget !== undefined,
    dynamic:
      expected.dynamicBoundary !== undefined ||
      expected.unresolved !== undefined,
    negative:
      (expected.forbiddenCalls?.length ?? 0) > 0 ||
      (expected.forbiddenCallsLoose?.length ?? 0) > 0 ||
      (expected.forbiddenRefs?.length ?? 0) > 0,
    multiFile,
  };
}

function summarizeCapabilities(reports) {
  return Object.fromEntries(
    ["deterministic", "dynamic", "negative", "multiFile"].map((capability) => {
      const matching = reports.filter(
        (report) => report.capabilities[capability],
      );
      return [capability, summarize(matching)];
    }),
  );
}

function symbolName(entity) {
  return entity.entity.metadata?.kind === "code"
    ? (entity.entity.metadata.symbolName ?? "")
    : "";
}

function cLikeAdapter(options) {
  const wrap = options.wrapFunctions ?? ((source) => source);
  return {
    extension: options.extension,
    declaration(a, b) {
      return wrap(
        `${options.functionKeyword}${a}() {}\n${options.functionKeyword}${b}() {}`,
      );
    },
    localCall(caller, callee, times = 1) {
      return wrap(
        `${options.functionKeyword}${callee}() {}\n${options.functionKeyword}${caller}() { ${`${callee}(); `.repeat(times)} }`,
      );
    },
    chain(a, b, c) {
      return wrap(
        `${options.functionKeyword}${c}() {}\n${options.functionKeyword}${b}() { ${c}(); }\n${options.functionKeyword}${a}() { ${b}(); }`,
      );
    },
    recursive(name) {
      return wrap(`${options.functionKeyword}${name}() { ${name}(); }`);
    },
    ...(options.classMethod && options.selfCall
      ? {
          member(container, caller, callee) {
            return `class ${container} { ${options.classMethod(callee, "")} ${options.classMethod(caller, `${options.selfCall(callee)};`)} }`;
          },
        }
      : {}),
    inheritance: options.inheritance,
    typedUse: options.typedUse,
    typedExpected: options.typedExpected,
    externalCall: options.externalCall,
    unresolved(caller, missing) {
      return wrap(`${options.functionKeyword}${caller}() { ${missing}(); }`);
    },
  };
}
