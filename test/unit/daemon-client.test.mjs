import assert from "node:assert/strict";
import test from "node:test";
import {
  serverVersionMatchesBundledContract,
  toolSatisfiesContract,
} from "../../dist/client/daemon-client.js";

test("daemon skips tools/list only for the bundled server contract", () => {
  assert.equal(
    serverVersionMatchesBundledContract(
      { name: "zvec-grep", version: "1.2.3" },
      "1.2.3",
    ),
    false,
  );
  assert.equal(
    serverVersionMatchesBundledContract(
      {
        name: "zvec-grep",
        version: "1.2.3",
        title: "zvec-grep-cli-contract-v1",
      },
      "1.2.3",
    ),
    true,
  );
  assert.equal(
    serverVersionMatchesBundledContract(
      { name: "zvec-grep", version: "1.2.2" },
      "1.2.3",
    ),
    false,
  );
  assert.equal(
    serverVersionMatchesBundledContract(
      { name: "another-server", version: "1.2.3" },
      "1.2.3",
    ),
    false,
  );
  assert.equal(serverVersionMatchesBundledContract(undefined, "1.2.3"), false);
});

test("daemon tool contract checks required schema properties", () => {
  const currentSearch = {
    inputSchema: { properties: { root: {}, routes: {} } },
    outputSchema: { properties: { root: {}, result: {} } },
  };
  assert.equal(
    toolSatisfiesContract(currentSearch, {
      inputProperties: ["routes"],
      outputProperties: ["result"],
    }),
    true,
  );
  assert.equal(
    toolSatisfiesContract(
      { inputSchema: { properties: { root: {} } } },
      { inputProperties: ["routes"] },
    ),
    false,
  );
  assert.equal(
    toolSatisfiesContract(currentSearch, {
      outputProperties: ["missing"],
    }),
    false,
  );
  assert.equal(toolSatisfiesContract(undefined, {}), false);
});
