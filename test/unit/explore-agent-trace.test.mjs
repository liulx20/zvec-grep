import assert from "node:assert/strict";
import test from "node:test";
import { summarizeAgentTrace } from "../../benchmarks/explore-quality/agent-trace.mjs";

test("agent trace separates Explore context from subsequent source reads", () => {
  const events = [
    {
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        tool: "zvec_grep_explore",
        result: { content: [{ type: "text", text: "source text" }] },
      },
    },
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc \"nl -ba src/a.ts | sed -n '1,20p'\"",
        aggregated_output: "twenty lines",
      },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 },
    },
  ];
  const metrics = summarizeAgentTrace(
    events.map((event) => JSON.stringify(event)).join("\n"),
  );
  assert.deepEqual(metrics, {
    ok: true,
    exploreCalls: 1,
    graphCalls: 1,
    exploreChars: 11,
    shellCommands: 1,
    sourceReadCommands: 1,
    sourceReadChars: 12,
    inputTokens: 100,
    cachedInputTokens: 60,
    outputTokens: 20,
  });
});

test("agent trace recognizes source readers nested in a shell command", () => {
  const event = {
    type: "item.completed",
    item: {
      type: "command_execution",
      command: `/bin/bash -lc "rg -n 'invoke' src/a.ts"`,
      aggregated_output: "src/a.ts:10:invoke()",
    },
  };
  const metrics = summarizeAgentTrace(JSON.stringify(event));
  assert.equal(metrics.sourceReadCommands, 1);
  assert.equal(metrics.sourceReadChars, 20);
});

test("agent trace rejects a shell fallback after Explore cannot open the index", () => {
  const events = [
    {
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        tool: "zvec_grep_explore",
        result: {
          content: [
            {
              type: "text",
              text: "[INDEX_BUSY] Another daemon owns index writes for this root.",
            },
          ],
        },
      },
    },
    { type: "turn.completed", usage: {} },
  ];

  assert.equal(
    summarizeAgentTrace(events.map(JSON.stringify).join("\n")).ok,
    false,
  );
});
