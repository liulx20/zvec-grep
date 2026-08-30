export function extractResultFiles(tool, operation, output) {
  const files = new Set();
  if (operation !== "explore") {
    if (tool === "zvec") {
      if (operation === "query") {
        for (const match of output.matchAll(
          /^#\d+\s+matchedBy=\S+(?:\s+score=\S+)?\s+(.+?):\d+(?:-\d+)?$/gm,
        )) {
          files.add(match[1]);
        }
        return files;
      }
      for (const match of output.matchAll(/\(([^()\n]+):\d+\)/g)) {
        files.add(match[1]);
      }
      return files;
    }

    // CodeGraph's graph commands use two text shapes: callers/callees print
    // an indented `path:line`, while impact prints a bare file heading followed
    // by its symbols. Keep this parser separate from Explore's Markdown blocks.
    for (const match of output.matchAll(
      /^\s+(.+\.[A-Za-z0-9]+):\d+(?::\d+)?\s*$/gm,
    )) {
      files.add(match[1].trim());
    }
    for (const match of output.matchAll(/^([^\s].*\.[A-Za-z0-9]+)\s*$/gm)) {
      files.add(match[1].trim());
    }
    return files;
  }

  const pattern =
    tool === "zvec"
      ? /^(.+?) \((?:central|related|change-surface), score=/gm
      : /^\*\*`([^`]+)`\*\*/gm;
  for (const match of output.matchAll(pattern)) files.add(match[1]);
  return files;
}

export function recallRatio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

export function noiseRatio(forbiddenCount, fileCount) {
  return fileCount === 0 ? 0 : forbiddenCount / fileCount;
}

export function visibleSymbolHits(expectedSymbols, output) {
  return expectedSymbols.filter((symbol) => {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?:^|[^\\p{L}\\p{N}_$#])${escaped}(?=$|[^\\p{L}\\p{N}_$#])`,
      "imu",
    ).test(output);
  });
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function outputAssertionsForTool(spec, tool) {
  if (tool === "zvec")
    return {
      required: spec.requiredOutput ?? [],
      forbidden: spec.forbiddenOutput ?? [],
    };
  return {
    required: spec.codegraphRequiredOutput ?? [],
    forbidden: spec.codegraphForbiddenOutput ?? [],
  };
}

export function aggregateQuality(items) {
  const sum = (key) =>
    items.reduce((total, item) => total + (item[key] ?? 0), 0);
  const samples = items.flatMap((item) => item.elapsedSamples ?? []);
  return {
    requiredRecall: recallRatio(sum("requiredHits"), sum("requiredTotal")),
    optionalRecall: recallRatio(sum("optionalHits"), sum("optionalTotal")),
    symbolRecall: recallRatio(sum("symbolHits"), sum("symbolTotal")),
    noiseRate: noiseRatio(
      items.reduce((total, item) => total + (item.forbidden?.length ?? 0), 0),
      items.reduce((total, item) => total + (item.files?.length ?? 0), 0),
    ),
    averageChars: items.length === 0 ? 0 : sum("chars") / items.length,
    medianLatencyMs: median(samples),
  };
}
