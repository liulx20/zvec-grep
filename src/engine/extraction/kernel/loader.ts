import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import {
  EDGE_KINDS,
  NODE_KINDS,
  type KernelBuffers,
  type KernelContractInfo,
  type KernelModule,
} from "./types.js";
import { KERNEL_ABI_VERSION } from "./layout.js";

const debugEnabled = () => process.env.CODEGRAPH_KERNEL_DEBUG === "1";
function debug(msg: string): void {
  if (debugEnabled()) process.stderr.write(`[codegraph-kernel] ${msg}\n`);
}

let kernelLanguages: ReadonlySet<string> = new Set();
let cached: KernelModule | null | undefined;

function candidatePaths(): string[] {
  const candidates: string[] = [];
  if (process.env.CODEGRAPH_KERNEL_PATH) {
    candidates.push(process.env.CODEGRAPH_KERNEL_PATH);
  }
  const packageRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
  candidates.push(join(packageRoot, "kernel", "codegraph-kernel.node"));
  candidates.push(
    join(
      packageRoot,
      "codegraph-kernel",
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "codegraph-kernel.node",
    ),
  );
  return candidates;
}

function verifyContract(mod: KernelModule, from: string): boolean {
  const info = mod.contractInfo();
  if (info.abiVersion !== KERNEL_ABI_VERSION) {
    debug(
      `${from}: ABI ${info.abiVersion} != expected ${KERNEL_ABI_VERSION} — ignoring kernel`,
    );
    return false;
  }
  const sameTable = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  if (
    !sameTable(info.nodeKinds, NODE_KINDS) ||
    !sameTable(info.edgeKinds, EDGE_KINDS)
  ) {
    debug(`${from}: NodeKind/EdgeKind tables differ — ignoring kernel`);
    return false;
  }
  return true;
}

export function getKernel(): KernelModule | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const candidate of candidatePaths()) {
    try {
      if (!existsSync(candidate)) continue;
      const req = createRequire(import.meta.url);
      const mod = req(candidate) as KernelModule;
      if (
        typeof mod.extractFile !== "function" ||
        typeof mod.contractInfo !== "function"
      ) {
        debug(`${candidate}: missing expected exports — ignoring`);
        continue;
      }
      if (!verifyContract(mod, candidate)) continue;
      kernelLanguages = new Set(mod.contractInfo().languages);
      debug(`loaded ${candidate} (languages: ${[...kernelLanguages].join(", ")})`);
      cached = mod;
      break;
    } catch (err) {
      debug(
        `${candidate}: failed to load — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return cached;
}

export function kernelSupports(language: string): boolean {
  if (process.env.CODEGRAPH_KERNEL === "0") return false;
  return getKernel() !== null && kernelLanguages.has(language);
}

export function resetKernelForTests(): void {
  cached = undefined;
  kernelLanguages = new Set();
}

export type { KernelBuffers, KernelContractInfo, KernelModule };
