import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { createZvecGrep } from "../../dist/index.js";

const [rootArg, queryArg, iterationsArg] = process.argv.slice(2);
if (!rootArg || !queryArg) {
  console.error(
    "Usage: node benchmarks/explore-quality/run-warm-query.mjs <root> <query> [iterations]",
  );
  process.exit(2);
}

const root = resolve(rootArg);
const iterations = positiveInteger(iterationsArg, 4);
const service = await createZvecGrep({ root });
const samples = [];
try {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const started = performance.now();
    const result = await service.context({
      root,
      query: queryArg,
      limit: 10,
      autoUpdate: false,
      trace: true,
    });
    const elapsedMs = Math.round(performance.now() - started);
    samples.push(elapsedMs);
    console.log(
      JSON.stringify({
        iteration,
        elapsedMs,
        hits: result.items.length,
        timings: Object.fromEntries(
          (result.diagnostics.timings ?? []).map((timing) => [
            timing.name,
            timing.durationMs,
          ]),
        ),
      }),
    );
  }
  const warm = samples.slice(1);
  console.log(
    JSON.stringify({
      summary: {
        coldMs: samples[0],
        warmSamples: warm.length,
        warmMedianMs: percentile(warm, 0.5),
        warmP95Ms: percentile(warm, 0.95),
      },
    }),
  );
} finally {
  await service.close();
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * quantile)];
}

function positiveInteger(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`iterations must be a positive integer, got ${raw}`);
  return value;
}
