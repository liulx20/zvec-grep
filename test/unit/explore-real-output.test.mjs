import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateQuality,
  extractResultFiles,
  noiseRatio,
  outputAssertionsForTool,
  recallRatio,
} from "../../benchmarks/explore-quality/real-output.mjs";

test("real benchmark parses CodeGraph graph-command file locations", () => {
  const impact = `Impact of changing "editorRefreshScreen" — 2 affected symbols:

kilo.c
  function    editorRefreshScreen:882
  function    main:1291
`;
  const callees = `Callees of "CleanPath" (1):

method      Handler
  middleware/compress.go:207
`;

  assert.deepEqual(
    [...extractResultFiles("codegraph", "impact", impact)],
    ["kilo.c"],
  );
  assert.deepEqual(
    [...extractResultFiles("codegraph", "callees", callees)],
    ["middleware/compress.go"],
  );
});

test("real benchmark parses indexed query result files", () => {
  const output = `query groups (1):
#1 matchedBy=fts+vector src/worker.ts:10-20
#2 matchedBy=graph score=0.1234 src/service.ts:42
relationships:
- Worker --CALLS--> Service
`;
  assert.deepEqual(
    [...extractResultFiles("zvec", "query", output)],
    ["src/worker.ts", "src/service.ts"],
  );
});

test("an empty result has zero noise rather than perfect noise", () => {
  assert.equal(noiseRatio(0, 0), 0);
});

test("an absent optional benchmark dimension is not reported as perfect", () => {
  assert.equal(recallRatio(0, 0), null);
  assert.equal(recallRatio(1, 2), 0.5);
});

test("real comparison uses presentation assertions scoped to each tool", () => {
  const spec = {
    requiredOutput: ["a -CALLS-> b"],
    forbiddenOutput: ["zvec noise"],
    codegraphRequiredOutput: ["Flow"],
    codegraphForbiddenOutput: ["codegraph noise"],
  };
  assert.deepEqual(outputAssertionsForTool(spec, "zvec"), {
    required: ["a -CALLS-> b"],
    forbidden: ["zvec noise"],
  });
  assert.deepEqual(outputAssertionsForTool(spec, "codegraph"), {
    required: ["Flow"],
    forbidden: ["codegraph noise"],
  });
});

test("real benchmark aggregates labelled assertions instead of case averages", () => {
  const quality = aggregateQuality([
    {
      requiredHits: 10,
      requiredTotal: 10,
      optionalHits: 0,
      optionalTotal: 0,
      forbidden: [],
      files: ["a.ts"],
    },
    {
      requiredHits: 1,
      requiredTotal: 1,
      optionalHits: 1,
      optionalTotal: 3,
      forbidden: ["noise.ts"],
      files: ["b.ts", "noise.ts"],
    },
  ]);
  assert.equal(quality.requiredRecall, 1);
  assert.equal(quality.optionalRecall, 1 / 3);
  assert.equal(quality.noiseRate, 1 / 3);
});

test("real benchmark parses every rendered zvec file role", () => {
  const output =
    `src/controller.ts (central, score=1.2000)\nsource:\n\n` +
    `src/model.ts (change-surface, score=0.0100)\nsource:\n\n` +
    `src/helper.ts (related, score=0.1000)\nsource:\n`;
  assert.deepEqual(
    [...extractResultFiles("zvec", "explore", output)],
    ["src/controller.ts", "src/model.ts", "src/helper.ts"],
  );
});
