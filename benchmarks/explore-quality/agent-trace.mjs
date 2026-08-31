const SOURCE_READ_COMMAND =
  /(?:^|[;&|()"']|\s)(?:rg|grep|sed|nl|cat|head|tail|awk)(?:\s|$)/;

export function summarizeAgentTrace(text) {
  let exploreFailed = false;
  const summary = {
    ok: false,
    exploreCalls: 0,
    graphCalls: 0,
    exploreChars: 0,
    shellCommands: 0,
    sourceReadCommands: 0,
    sourceReadChars: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "turn.completed") {
      summary.ok = true;
      summary.inputTokens += event.usage?.input_tokens ?? 0;
      summary.cachedInputTokens += event.usage?.cached_input_tokens ?? 0;
      summary.outputTokens += event.usage?.output_tokens ?? 0;
      continue;
    }
    if (event.type !== "item.completed") continue;
    const item = event.item ?? {};
    if (item.type === "mcp_tool_call") {
      summary.graphCalls += 1;
      if (/explore/i.test(item.tool ?? "")) {
        summary.exploreCalls += 1;
        const output = resultText(item.result);
        summary.exploreChars += output.length;
        exploreFailed ||=
          item.result?.isError === true || /^\[INDEX_BUSY\]/m.test(output);
      }
    } else if (item.type === "command_execution") {
      summary.shellCommands += 1;
      if (SOURCE_READ_COMMAND.test(item.command ?? "")) {
        summary.sourceReadCommands += 1;
        summary.sourceReadChars += item.aggregated_output?.length ?? 0;
      }
    }
  }
  if (exploreFailed) summary.ok = false;
  return summary;
}

function resultText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("");
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
