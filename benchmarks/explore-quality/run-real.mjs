import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateQuality,
  extractResultFiles,
  median,
  noiseRatio,
  outputAssertionsForTool,
  recallRatio,
  visibleSymbolHits,
} from "./real-output.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const suiteArg = process.argv.find((argument) => argument.endsWith(".json"));
const suitePath = resolve(suiteArg ?? resolve(here, "real-cases.json"));
const suite = JSON.parse(readFileSync(suitePath, "utf8"));
const zvecCli = resolve(here, "../../dist/cli/index.js");
const benchmarkRoot = resolve(
  process.env.ZVEC_GRAPH_BENCH_ROOT ?? resolve(here, "../../.."),
);
const compareCodeGraph = process.argv.includes("--codegraph");
const operationFilter = optionValue("operation", "explore");
const repetitions = positiveIntegerOption(
  "repetitions",
  compareCodeGraph ? 3 : 1,
);
const warmups = positiveIntegerOption("warmups", compareCodeGraph ? 1 : 0, 0);
const suiteName =
  process.argv
    .find((argument) => argument.startsWith("--suite="))
    ?.slice("--suite=".length) ?? "holdout";
const caseFilters = process.argv
  .filter((argument) => argument.startsWith("--case="))
  .map((argument) => argument.slice("--case=".length));

const selectedRepositories = benchmarkRepositories(suite, suiteName);
const selectedCases = suite.cases.filter(
  (item) =>
    selectedRepositories.has(item.repository) &&
    (operationFilter === "all" ||
      (item.command ?? "explore") === operationFilter) &&
    (caseFilters.length === 0 ||
      caseFilters.some((filter) => item.id.includes(filter))),
);
if (selectedCases.length === 0)
  throw new Error(`suite ${suiteName} selected no benchmark cases`);

const results = [];
for (const [index, spec] of selectedCases.entries()) {
  const repository = suite.repositories[spec.repository];
  const repositoryPath = resolve(benchmarkRoot, repository.directory);
  verifyCommit(repositoryPath, repository.commit);
  const tools = compareCodeGraph
    ? index % 2 === 0
      ? ["zvec", "codegraph"]
      : ["codegraph", "zvec"]
    : ["zvec"];
  for (const tool of tools) results.push(runCase(tool, spec, repositoryPath));
}
printResults(results, suiteName, { operationFilter, repetitions, warmups });
if (results.some((result) => result.tool === "zvec" && !result.passed))
  process.exitCode = 1;

function runCase(tool, spec, cwd) {
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
  const samples = [];
  for (let index = -warmups; index < repetitions; index += 1) {
    const started = performance.now();
    const child = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      // Benchmark checked-out code rather than a stale daemon. Both arms pay
      // their CLI process startup cost; an unmeasured run warms filesystem
      // caches before repeated A/B samples.
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...(tool === "zvec" ? { ZVEC_GREP_MODE: "direct" } : {}),
      },
    });
    if (index >= 0) {
      samples.push({
        child,
        elapsedMs: performance.now() - started,
        output: `${child.stdout ?? ""}${child.stderr ?? ""}`,
      });
    }
  }
  const first = samples[0];
  const output = first.output;
  const unavailable = output.match(/^graph unavailable:.*$/m)?.[0];
  if (tool === "zvec" && unavailable)
    throw new Error(
      `${spec.id}: ${unavailable}. Rebuild the benchmark repository index with the current CLI.`,
    );
  const files = extractResultFiles(tool, operation, output);
  const expectedSymbols = spec.expectedSymbols ?? [];
  const foundSymbols = visibleSymbolHits(expectedSymbols, output);
  const missingSymbols = expectedSymbols.filter(
    (symbol) => !foundSymbols.includes(symbol),
  );
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
    (spec.requiredFilePatterns ?? []).length;
  const requiredMissing = missing.length + missingFilePatterns.length;
  const optionalTotal = spec.optional.length;
  const fileSignatures = samples.map((sample) =>
    [...extractResultFiles(tool, operation, sample.output)].sort().join("\0"),
  );
  const stable = new Set(fileSignatures).size === 1;
  const elapsedSamples = samples.map((sample) => sample.elapsedMs);
  return {
    tool,
    operation,
    id: spec.id,
    elapsedMs: Math.round(median(elapsedSamples)),
    elapsedP95Ms: Math.round(percentile(elapsedSamples, 0.95)),
    elapsedSamples,
    chars: Math.round(median(samples.map((sample) => sample.output.length))),
    files: [...files],
    requiredHits: requiredTotal - requiredMissing,
    requiredTotal,
    optionalHits: optionalFound.length,
    optionalTotal,
    symbolHits: foundSymbols.length,
    symbolTotal: expectedSymbols.length,
    symbolRecall: recallRatio(foundSymbols.length, expectedSymbols.length),
    missingSymbols,
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
    stable,
    executionError: first.child.error?.message,
    passed:
      !first.child.error &&
      first.child.status === 0 &&
      stable &&
      missing.length === 0 &&
      missingOutput.length === 0 &&
      presentForbiddenOutput.length === 0 &&
      missingFilePatterns.length === 0 &&
      cardinalityFailures.length === 0 &&
      forbidden.length === 0,
  };
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * quantile)];
}

function benchmarkRepositories(suite, name) {
  const known = Object.keys(suite.suites ?? {});
  if (name === "all") return new Set(Object.keys(suite.repositories));
  const repositories = suite.suites?.[name];
  if (!repositories)
    throw new Error(
      `unknown suite ${name}; expected ${[...known, "all"].join(", ")}`,
    );
  const tuning = new Set(suite.suites.tuning ?? []);
  const holdout = new Set(suite.suites.holdout ?? []);
  const overlap = [...tuning].filter((repository) => holdout.has(repository));
  if (overlap.length > 0)
    throw new Error(`tuning/holdout overlap: ${overlap.join(", ")}`);
  return new Set(repositories);
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

function printResults(items, suiteName, settings) {
  console.log(
    `Real-repository retrieval smoke (${suiteName}; operation=${settings.operationFilter}; samples=${settings.repetitions}; warmups=${settings.warmups})`,
  );
  for (const item of items) {
    console.log(
      `${item.tool.padEnd(9)} ${item.id.padEnd(14)} files=${percent(item.requiredRecall)} symbols=${percent(item.symbolRecall)} optional=${percent(item.optionalRecall)} noise=${percent(item.noiseRate)} count=${item.files.length} chars=${item.chars} time=${item.elapsedMs}/${item.elapsedP95Ms}ms${item.passed ? "" : " FAIL"}`,
    );
    if (item.missing.length)
      console.log(`  missing: ${item.missing.join(", ")}`);
    if (item.missingOptional.length)
      console.log(`  optional missing: ${item.missingOptional.join(", ")}`);
    if (item.missingSymbols.length)
      console.log(`  symbols missing: ${item.missingSymbols.join(", ")}`);
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
    if (!item.stable) console.log("  nondeterministic file set across samples");
    if (item.forbidden.length)
      console.log(`  forbidden: ${item.forbidden.join(", ")}`);
  }
  for (const [tool, group] of Map.groupBy(items, (item) => item.tool)) {
    const quality = aggregateQuality(group);
    console.log(
      `${tool.padEnd(9)} overall files=${percent(quality.requiredRecall)} symbols=${percent(quality.symbolRecall)} optional=${percent(quality.optionalRecall)} noise=${percent(quality.noiseRate)} chars=${Math.round(quality.averageChars)} median=${Math.round(quality.medianLatencyMs ?? 0)}ms pass=${group.filter((item) => item.passed).length}/${group.length}`,
    );
  }
}

function optionValue(name, fallback) {
  return (
    process.argv
      .find((argument) => argument.startsWith(`--${name}=`))
      ?.slice(name.length + 3) ?? fallback
  );
}

function positiveIntegerOption(name, fallback, minimum = 1) {
  const raw = optionValue(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`--${name} must be an integer >= ${minimum}; got ${raw}`);
  return value;
}

function percent(value) {
  if (value === null) return "n/a";
  return `${Math.round(value * 100)}%`;
}
