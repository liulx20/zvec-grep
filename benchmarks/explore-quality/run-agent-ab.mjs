#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  createWriteStream,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { median, summarizeAgentTrace } from "./agent-trace.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const options = parseOptions(process.argv.slice(2));
const repository = resolve(required(options, "repo"));
const caseName = options.case ?? "case";
const truth = options.truth
  ? JSON.parse(readFileSync(resolve(options.truth), "utf8"))[caseName]
  : undefined;
const question = options.question ?? truth?.question;
if (!question)
  throw new Error("--question=... or matching --truth=... is required");
const repetitions = positiveInteger(options.repetitions ?? "3");
const outputDir = resolve(
  options.output ?? resolve(tmpdir(), "zvec-explore-agent-ab"),
);
const model = options.model ?? process.env.CODEX_MODEL;
if (!model) throw new Error("--model=... or CODEX_MODEL is required");
const effort = options.effort ?? "high";
const timeoutMs = positiveInteger(options["timeout-seconds"] ?? "600") * 1_000;
const requestedArm = options.arm;
if (requestedArm && !["zvec", "codegraph"].includes(requestedArm)) {
  throw new Error("--arm=... must be zvec or codegraph");
}
const codex = process.env.CODEX_BIN ?? "codex";
const codegraph = process.env.CODEGRAPH_BIN ?? "codegraph";
const sourceHome = resolve(
  process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
);

mkdirSync(outputDir, { recursive: true });
for (const marker of [".zvec-grep", ".codegraph"]) {
  try {
    readFileSync(
      resolve(
        repository,
        marker,
        marker === ".codegraph" ? "codegraph.db" : "manifest.json",
      ),
    );
  } catch {
    throw new Error(`${repository} is missing an indexed ${marker} workspace`);
  }
}

const tempHome = mkdtempSync(resolve(tmpdir(), "zvec-agent-ab-"));
const zvecHome = resolve(tempHome, "zvec-home");
const zvecListen = await availableLoopbackAddress();
try {
  cpSync(resolve(sourceHome, "auth.json"), resolve(tempHome, "auth.json"));
  const records = [];
  const resultFile = resolve(outputDir, "agent-results.jsonl");
  writeFileSync(resultFile, "");
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const arms = requestedArm
      ? [requestedArm]
      : repetition % 2 === 1
        ? ["zvec", "codegraph"]
        : ["codegraph", "zvec"];
    for (const arm of arms) {
      writeConfig(tempHome, repository, arm, codegraph, zvecHome, zvecListen);
      const record = await runArm({ arm, repetition });
      records.push(record);
      appendFileSync(resultFile, `${JSON.stringify(record)}\n`);
    }
  }
  printSummary(records, resultFile);
  if (records.some((record) => !record.ok)) process.exitCode = 1;
} finally {
  spawnSync(
    process.execPath,
    [
      resolve(here, "../../dist/cli/index.js"),
      "server",
      "off",
      "--home",
      zvecHome,
    ],
    { stdio: "ignore" },
  );
  rmSync(tempHome, { recursive: true, force: true });
}

async function runArm({ arm, repetition }) {
  const stem = `${safeName(options.case ?? "case")}-${arm}-${repetition}`;
  const tracePath = resolve(outputDir, `${stem}.jsonl`);
  const answerPath = resolve(outputDir, `${stem}.md`);
  const prompt = [
    "Answer the repository question below. Your first repository tool call must be the available Explore tool; do not use semantic search for initial discovery.",
    "Only inspect source text when Explore leaves a genuine evidentiary gap; do not re-read source ranges already provided by Explore.",
    "Cite repository paths and line numbers in the final answer.",
    "",
    question,
  ].join("\n");
  const started = performance.now();
  const traceFile = createWriteStream(tracePath);
  const child = spawn(
    codex,
    [
      "exec",
      "--ephemeral",
      "--json",
      "--approve-for-me",
      "--skip-git-repo-check",
      "--model",
      model,
      "--cd",
      repository,
      "--output-last-message",
      answerPath,
      prompt,
    ],
    {
      env: { ...process.env, CODEX_HOME: tempHome, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let trace = "";
  let stderr = "";
  let spawnError;
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    trace += chunk;
    traceFile.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  let forceKill;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, timeoutMs);
  const { code, signal } = await new Promise((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  clearTimeout(timeout);
  clearTimeout(forceKill);
  await new Promise((resolveEnd) => traceFile.end(resolveEnd));
  const metrics = summarizeAgentTrace(trace);
  return {
    repo: caseName,
    case: caseName,
    arm,
    rep: repetition,
    repetition,
    question,
    model,
    effort,
    ok: code === 0 && metrics.ok,
    exitCode: code,
    signal,
    timedOut,
    durationMs: Math.round(performance.now() - started),
    ...metrics,
    finalAnswer: readOptional(answerPath),
    error:
      (timedOut ? `timed out after ${timeoutMs / 1_000}s` : "") ||
      stderr.trim() ||
      spawnError?.message,
    tracePath,
  };
}

function writeConfig(
  home,
  project,
  arm,
  codegraphCommand,
  daemonHome,
  daemonListen,
) {
  const projectKey = tomlString(project);
  const common = [
    `model_reasoning_effort = ${tomlString(effort)}`,
    "",
    `[projects.${projectKey}]`,
    'trust_level = "trusted"',
    "",
  ];
  const server =
    arm === "zvec"
      ? [
          "[mcp_servers.zvec]",
          `command = ${tomlString(process.execPath)}`,
          `args = [${tomlString(resolve(here, "../../dist/cli/index.js"))}, "server", "--stdio", "--mcp-toolset", "agent", "--home", ${tomlString(daemonHome)}, "--listen", ${tomlString(daemonListen)}]`,
        ]
      : [
          "[mcp_servers.codegraph]",
          `command = ${tomlString(codegraphCommand)}`,
          `args = ["serve", "--mcp", "--path", ${tomlString(project)}]`,
          'env = { CODEGRAPH_OFFLOAD_DISABLE = "1" }',
        ];
  writeFileSync(
    resolve(home, "config.toml"),
    [
      ...common,
      ...server,
      "startup_timeout_sec = 30",
      "tool_timeout_sec = 120",
      "",
    ].join("\n"),
  );
}

async function availableLoopbackAddress() {
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a loopback port"));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
  return `127.0.0.1:${port}`;
}

function printSummary(records, path) {
  console.log(`Agent Explore A/B: ${question}`);
  for (const arm of ["zvec", "codegraph"]) {
    const group = records.filter((record) => record.arm === arm);
    const value = (key) => median(group.map((record) => record[key]));
    console.log(
      `${arm.padEnd(9)} reads=${value("sourceReadCommands")} readChars=${value("sourceReadChars")} explore=${value("exploreCalls")} exploreChars=${value("exploreChars")} input=${value("inputTokens")} output=${value("outputTokens")} time=${Math.round((value("durationMs") ?? 0) / 1000)}s ok=${group.filter((record) => record.ok).length}/${group.length}`,
    );
  }
  console.log(`results: ${path}`);
}

function parseOptions(args) {
  return Object.fromEntries(
    args.map((argument) => {
      const match = argument.match(/^--([^=]+)=(.*)$/s);
      if (!match) throw new Error(`expected --name=value, got ${argument}`);
      return [match[1], match[2]];
    }),
  );
}

function required(values, name) {
  if (!values[name]) throw new Error(`--${name}=... is required`);
  return values[name];
}

function positiveInteger(raw) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`expected a positive integer, got ${raw}`);
  return value;
}

function safeName(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function tomlString(value) {
  return JSON.stringify(value);
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
