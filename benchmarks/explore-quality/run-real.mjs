import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateQuality,
  extractResultFiles,
  noiseRatio,
  outputAssertionsForTool,
  recallRatio,
} from "./real-output.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const suiteArg = process.argv.find((argument) => argument.endsWith(".json"));
const suitePath = resolve(suiteArg ?? resolve(here, "real-cases.json"));
const suite = JSON.parse(readFileSync(suitePath, "utf8"));
const zvecCli = resolve(here, "../../dist/cli/index.js");
const compareCodeGraph = process.argv.includes("--codegraph");
const caseFilters = process.argv
  .filter((argument) => argument.startsWith("--case="))
  .map((argument) => argument.slice("--case=".length));

const results = [];
for (const spec of suite.cases.filter(
  (item) =>
    caseFilters.length === 0 ||
    caseFilters.some((filter) => item.id.includes(filter)),
)) {
  const repository = suite.repositories[spec.repository];
  verifyCommit(repository.path, repository.commit);
  results.push(runCase("zvec", spec, repository.path));
  if (compareCodeGraph)
    results.push(runCase("codegraph", spec, repository.path));
}
printResults(results);
if (results.some((result) => result.tool === "zvec" && !result.passed))
  process.exitCode = 1;

function runCase(tool, spec, cwd) {
  const started = performance.now();
  const operation = spec.command ?? "explore";
  const operationArgs = [operation, spec.query];
  if (operation === "explore")
    operationArgs.push("--max-files", String(spec.maxFiles ?? 8));
  // Pinned benchmark repositories are immutable and already indexed. Measure
  // retrieval latency rather than adding a full workspace freshness scan to
  // every zvec Query case; freshness behavior is covered by CLI E2E tests.
  if (tool === "zvec" && operation === "query")
    operationArgs.push("--refresh", "off");
  const [command, args] =
    tool === "zvec"
      ? [process.execPath, [zvecCli, ...operationArgs]]
      : ["codegraph", operationArgs];
  const child = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    // Benchmark the checked-out implementation, not a potentially stale
    // long-lived daemon binary left behind by an earlier build.
    env: {
      ...process.env,
      NO_COLOR: "1",
      ...(tool === "zvec" ? { ZVEC_GREP_MODE: "direct" } : {}),
    },
  });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  const files = extractResultFiles(tool, operation, output);
  const requiredAny = spec.requiredAny ?? [];
  // Output prose is presentation-specific. Shared file expectations remain
  // comparable across tools, while relationship/text assertions must opt in
  // per tool instead of grading CodeGraph against zvec's CLI syntax.
  const outputAssertions = outputAssertionsForTool(spec, tool);
  const requiredOutput = outputAssertions.required;
  const forbiddenOutput = outputAssertions.forbidden;
  const missing = spec.required.filter((path) => !files.has(path));
  const missingGroups = requiredAny.filter(
    (paths) => !paths.some((path) => files.has(path)),
  );
  missing.push(
    ...missingGroups.map((paths) => `one of (${paths.join(" | ")})`),
  );
  const forbidden = spec.forbidden.filter((path) => files.has(path));
  const optionalFound = spec.optional.filter((path) => files.has(path));
  const missingOptional = spec.optional.filter((path) => !files.has(path));
  const missingOutput = requiredOutput.filter((text) => !output.includes(text));
  const presentForbiddenOutput = forbiddenOutput.filter((text) =>
    output.includes(text),
  );
  const missingFilePatterns = (spec.requiredFilePatterns ?? []).filter(
    (pattern) => ![...files].some((path) => new RegExp(pattern).test(path)),
  );
  const cardinalityFailures = [];
  if (spec.minFiles !== undefined && files.size < spec.minFiles)
    cardinalityFailures.push(`files ${files.size} < ${spec.minFiles}`);
  if (spec.maxFiles !== undefined && files.size > spec.maxFiles)
    cardinalityFailures.push(`files ${files.size} > ${spec.maxFiles}`);
  const requiredTotal =
    spec.required.length +
    requiredAny.length +
    requiredOutput.length +
    (spec.requiredFilePatterns ?? []).length;
  const requiredMissing =
    missing.length + missingOutput.length + missingFilePatterns.length;
  const optionalTotal = spec.optional.length;
  return {
    tool,
    id: spec.id,
    elapsedMs: Math.round(performance.now() - started),
    chars: output.length,
    files: [...files],
    requiredHits: requiredTotal - requiredMissing,
    requiredTotal,
    optionalHits: optionalFound.length,
    optionalTotal,
    missingOptional,
    requiredRecall: recallRatio(requiredTotal - requiredMissing, requiredTotal),
    optionalRecall: recallRatio(optionalFound.length, optionalTotal),
    noiseRate: noiseRatio(forbidden.length, files.size),
    missing,
    missingOutput,
    forbiddenOutput: presentForbiddenOutput,
    missingFilePatterns,
    cardinalityFailures,
    forbidden,
    executionError: child.error?.message,
    passed:
      !child.error &&
      child.status === 0 &&
      missing.length === 0 &&
      missingOutput.length === 0 &&
      presentForbiddenOutput.length === 0 &&
      missingFilePatterns.length === 0 &&
      cardinalityFailures.length === 0 &&
      forbidden.length === 0,
  };
}

function verifyCommit(path, expected) {
  const child = spawnSync("git", ["-C", path, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  });
  const actual = child.stdout?.trim();
  if (!actual)
    throw child.error ?? new Error(`cannot inspect repository ${path}`);
  if (!actual.startsWith(expected))
    throw new Error(`repository ${path} is ${actual}; expected ${expected}`);
}

function printResults(items) {
  console.log("Real-repository graph query quality benchmark");
  for (const item of items) {
    console.log(
      `${item.tool.padEnd(9)} ${item.id.padEnd(14)} required=${percent(item.requiredRecall)} optional=${percent(item.optionalRecall)} noise=${percent(item.noiseRate)} files=${item.files.length} chars=${item.chars} time=${item.elapsedMs}ms${item.passed ? "" : " FAIL"}`,
    );
    if (item.missing.length)
      console.log(`  missing: ${item.missing.join(", ")}`);
    if (item.missingOptional.length)
      console.log(`  optional missing: ${item.missingOptional.join(", ")}`);
    if (item.missingOutput.length)
      console.log(`  missing output: ${item.missingOutput.join(", ")}`);
    if (item.forbiddenOutput.length)
      console.log(`  forbidden output: ${item.forbiddenOutput.join(", ")}`);
    if (item.missingFilePatterns.length)
      console.log(
        `  missing file patterns: ${item.missingFilePatterns.join(", ")}`,
      );
    if (item.cardinalityFailures.length)
      console.log(`  cardinality: ${item.cardinalityFailures.join(", ")}`);
    if (item.executionError)
      console.log(`  execution error: ${item.executionError}`);
    if (item.forbidden.length)
      console.log(`  forbidden: ${item.forbidden.join(", ")}`);
  }
  for (const [tool, group] of Map.groupBy(items, (item) => item.tool)) {
    const quality = aggregateQuality(group);
    console.log(
      `${tool.padEnd(9)} overall required=${percent(quality.requiredRecall)} optional=${percent(quality.optionalRecall)} noise=${percent(quality.noiseRate)} pass=${group.filter((item) => item.passed).length}/${group.length}`,
    );
  }
}
function percent(value) {
  if (value === null) return "n/a";
  return `${Math.round(value * 100)}%`;
}
