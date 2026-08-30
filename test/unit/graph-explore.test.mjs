import assert from "node:assert/strict";
import test from "node:test";
import {
  SqliteGraphStorage,
  UnavailableGraphStorage,
  exploreGraph,
  exploreSubgraph,
  queryGraphNeighborhood,
} from "../../dist/engine/graph/index.js";
import { selectExploreFiles } from "../../dist/engine/graph/explore/file-selection.js";
import { ExploreCandidatePool } from "../../dist/engine/graph/explore/candidate-pool.js";
import { collectExploreFileEvidence } from "../../dist/engine/graph/explore/file-evidence.js";
import {
  collectCallPaths,
  deriveExecutionPaths,
} from "../../dist/engine/graph/explore/paths.js";
import {
  resolveExactExploreSeedGroups,
  resolveExploreSeeds,
} from "../../dist/engine/graph/explore/policy.js";
import { entityStorage, graphEntity as entity } from "../helpers/graph.mjs";

test("named-root flows prefer the most complete connecting chain", () => {
  const paths = new Map([
    ["a\0b", [{ id: "a" }, { id: "b" }]],
    ["a\0c", [{ id: "a" }, { id: "bridge" }, { id: "c" }]],
  ]);
  const result = collectCallPaths(
    {
      pathBetween(from, to) {
        return paths.get(`${from}\0${to}`) ?? null;
      },
    },
    ["a", "b", "c"],
    3,
    1,
  );

  assert.deepEqual(result.paths[0]?.nodes, ["a", "bridge", "c"]);
  assert.deepEqual(
    new Set(result.refs.map(({ id }) => id)),
    new Set(["a", "bridge", "c"]),
  );
});

test("explicit file paths disambiguate exact explore symbols", () => {
  const target = entity(
    "target",
    "signTransactionThunk",
    "src/sendFormThunks.ts",
    { symbolType: "function" },
  );
  const unrelated = entity(
    "unrelated",
    "signTransactionThunk",
    "legacy/sendFormThunks.ts",
    { symbolType: "function" },
  );

  const groups = resolveExactExploreSeedGroups(
    entityStorage([target, unrelated]),
    "src/sendFormThunks.ts signTransactionThunk full function body",
    8,
  );

  assert.deepEqual(
    groups?.map(({ ids }) => ids),
    [["target"]],
  );

  assert.equal(
    resolveExactExploreSeedGroups(
      entityStorage([target, unrelated]),
      "Trace transaction signing and review; include src/sendFormThunks.ts",
      8,
    ),
    null,
  );

  const owner = entity("owner", "SessionEncrypted", "session/encrypted.ts", {
    symbolType: "class",
  });
  const privateMethod = entity(
    "private-send",
    "#send",
    "session/encrypted.ts",
    { symbolType: "function" },
  );
  privateMethod.entity.metadata.scope = "SessionEncrypted";
  const focused = resolveExactExploreSeedGroups(
    entityStorage([owner, privateMethod]),
    "SessionEncrypted::#send serialize request session/encrypted.ts",
    8,
  );
  assert.deepEqual(
    focused?.map(({ ids }) => ids),
    [["private-send"]],
  );

  const loop = entity("send-loop", "#sendLoopBody", "session/encrypted.ts", {
    symbolType: "function",
  });
  loop.entity.metadata.scope = "SessionEncrypted";
  assert.deepEqual(
    resolveExploreSeeds(
      entityStorage([owner, privateMethod, loop]),
      "SessionEncrypted #sendLoopBody encrypt and transport",
      undefined,
      8,
    )[0],
    "send-loop",
  );

  const writer = entity("writer", "writeMessage", "tl/message.ts", {
    symbolType: "function",
  });
  assert.deepEqual(
    resolveExploreSeeds(
      entityStorage([owner, privateMethod, writer]),
      "SessionEncrypted::#send then writeMessage",
      undefined,
      8,
    ).slice(0, 2),
    ["private-send", "writer"],
  );
});

test("natural-language flow queries reserve code identifiers, not prose words", () => {
  const clientSend = entity("client-send", "sendMessage", "client/client.ts", {
    symbolType: "function",
    text: "async sendMessage() { return this.messageManager.sendMessage(); }",
  });
  clientSend.entity.metadata.scope = "Client";
  const candidates = [
    clientSend,
    entity("message-send", "sendMessage", "client/message-manager.ts", {
      symbolType: "function",
      text: "serialize the message into an MTProto request",
    }),
    entity("transport", "writePacket", "session/transport.ts", {
      symbolType: "function",
      text: "write the serialized request to the network transport session",
    }),
    entity("trace", "Trace", "logger.ts", { symbolType: "value" }),
    entity("explore", "Explore", "pages/explore.ts", {
      symbolType: "function",
    }),
    entity("swap", "Swap", "parser/swap.ts", { symbolType: "interface" }),
    entity("level", "AnyLevelX", "filters.ts", { symbolType: "alias" }),
  ];

  const seeds = resolveExploreSeeds(
    entityStorage(candidates),
    "Trace how the high-level client.sendMessage() method gets the message serialized into an MTProto request and sent over the network transport",
    undefined,
    8,
  );

  assert.equal(seeds[0], "client-send");
  assert.deepEqual(seeds, ["client-send"]);
  assert.ok(!seeds.includes("trace"));
  assert.ok(!seeds.includes("explore"));
  assert.ok(!seeds.includes("swap"));
  assert.ok(!seeds.includes("level"));
  assert.ok(
    seeds.length <= 4,
    "natural-language flow queries must not consume the full symbol-list budget",
  );

  const queue = entity("queue", "queue", "server/submission/post.service.ts", {
    symbolType: "function",
  });
  assert.ok(
    resolveExploreSeeds(
      entityStorage([queue, ...candidates]),
      "Trace submitting and queueing from the server submission entry point",
      undefined,
      8,
    ).includes("queue"),
    "an exact inflection variant should remain eligible as a flow seed",
  );

  const queueState = entity(
    "queue-state",
    "submissionQueue",
    "server/post.service.ts",
    { symbolType: "value" },
  );
  const queueCallable = entity(
    "queue-callable",
    "queue",
    "server/post.service.ts",
    { symbolType: "function" },
  );
  const queueStorage = entityStorage([queueState, queueCallable]);
  queueStorage.findSymbolsByQuery = () => [queueState];
  assert.equal(
    resolveExploreSeeds(
      queueStorage,
      "Trace the queue processing flow",
      undefined,
      8,
    )[0],
    "queue-callable",
    "an exact callable in the retrieved value's file should anchor the flow",
  );

  const rates = entity("rates", "getTradeRates", "swapper.ts", {
    symbolType: "function",
  });
  const quotes = entity("quotes", "getTradeQuotes", "swapper.ts", {
    symbolType: "function",
  });
  const unrelated = entity("unrelated", "waitForTradeStatus", "status.ts", {
    symbolType: "function",
    text: "helper function that fetches quotes and dispatches a swapper",
  });
  assert.deepEqual(
    resolveExploreSeeds(
      entityStorage([rates, quotes, unrelated]),
      "Show getTradeQuotes and getTradeRates and how they dispatch the selected swapper",
      undefined,
      8,
    ),
    ["quotes", "rates"],
  );

  const registry = entity("registry", "swapperApi", "state/swapperApi.ts", {
    symbolType: "value",
  });
  const similarlyNamedType = entity("api-type", "SwapperApi", "types.ts", {
    symbolType: "alias",
  });
  const tradeQuotes = entity("trade-quotes", "TradeQuotes", "TradeQuotes.tsx", {
    symbolType: "function",
  });
  const generatedHook = entity(
    "quote-hook",
    "useGetTradeQuoteQuery",
    "state/swapperApi.ts",
    { symbolType: "function" },
  );
  const explicitSeeds = resolveExploreSeeds(
    entityStorage([
      registry,
      similarlyNamedType,
      tradeQuotes,
      generatedHook,
      rates,
      quotes,
      unrelated,
    ]),
    "swapperApi useGetTradeQuoteQuery getTradeQuotes TradeQuotes component flow",
    undefined,
    8,
  );
  assert.ok(explicitSeeds.includes("registry"));
  assert.ok(explicitSeeds.includes("trade-quotes"));
  assert.ok(!explicitSeeds.includes("api-type"));

  const retrievedFlow = entity("retrieved-flow", "runWorkflow", "flow.ts", {
    symbolType: "function",
    text: "coordinates the workflow",
  });
  const explicitEntries = ["AlphaEntry", "BetaEntry", "GammaEntry"].map(
    (name, index) =>
      entity(`entry-${index}`, name, `entry-${index}.ts`, {
        symbolType: "function",
      }),
  );
  const execute = entity("client-execute", "execute", "client/impl.ts", {
    symbolType: "function",
  });
  execute.entity.metadata.scope = "ClientImpl";
  const entryStorage = entityStorage([
    retrievedFlow,
    execute,
    ...explicitEntries,
  ]);
  const findEntrySymbols = entryStorage.findSymbolsByQuery;
  entryStorage.findSymbolsByQuery = (query) =>
    query.includes("alpha entry") &&
    query.includes("beta") &&
    query.includes("gamma") &&
    query.includes("workflow")
      ? [retrievedFlow]
      : findEntrySymbols(query);
  const entrySeeds = resolveExploreSeeds(
    entryStorage,
    "Trace Client.execute with AlphaEntry BetaEntry GammaEntry across the workflow orchestration pipeline storage transport lifecycle",
    undefined,
    8,
  );
  assert.ok(entrySeeds.includes("retrieved-flow"));
  assert.ok(
    explicitEntries.every(({ entity }) => entrySeeds.includes(entity.id)),
  );

  const stakeSign = entity("stake-sign", "signTransaction", "stake/form.ts", {
    symbolType: "function",
  });
  stakeSign.entity.metadata.scope = "Stake";
  const flow = entity("send-flow", "signAndPush", "wallet/send.ts", {
    symbolType: "function",
    text: "crypto review send form action calls TrezorConnect signTransaction",
  });
  const review = entity("review", "ReviewButton", "wallet/ReviewButton.tsx", {
    symbolType: "function",
  });
  const action = entity("action", "Action", "generic/reducer.ts", {
    symbolType: "alias",
  });
  const state = entity("state", "SignTransactionState", "wallet/send.ts", {
    symbolType: "alias",
  });
  const unrelatedPushes = ["stake", "rewards"].map((scope) => {
    const item = entity(
      `${scope}-push`,
      "pushTransaction",
      `${scope}/actions.ts`,
      { symbolType: "function" },
    );
    item.entity.metadata.scope = scope;
    return item;
  });
  const overloads = Array.from({ length: 8 }, (_, index) => {
    const item = entity(
      `overload-${index}`,
      "signTransaction",
      `coin-${index}.ts`,
      {
        symbolType: "function",
      },
    );
    item.entity.metadata.scope = `Coin${index}`;
    return item;
  });
  const transactionStorage = entityStorage([
    stakeSign,
    ...overloads,
    flow,
    review,
    action,
    state,
    ...unrelatedPushes,
    entity(
      "a-connect-mobile-facade",
      "TrezorConnect",
      "packages/connect-mobile/src/index.ts",
      {
        symbolType: "value",
        text: "const TrezorConnect = createMobileClient()",
      },
    ),
    entity("connect-facade", "TrezorConnect", "packages/connect/src/index.ts", {
      symbolType: "value",
      text: "const TrezorConnect = createClient(new Core())",
    }),
    entity(
      "connect-sign",
      "SignTransaction",
      "packages/connect/src/api/signTransaction.ts",
      { symbolType: "class" },
    ),
    entity(
      "connect-sign-type",
      "SignTransaction",
      "packages/connect-common/src/types/signTransaction.ts",
      { symbolType: "interface" },
    ),
  ]);
  const queries = [];
  const findSymbolsByQuery = transactionStorage.findSymbolsByQuery;
  transactionStorage.findSymbolsByQuery = (query) => {
    queries.push(query);
    const matches = findSymbolsByQuery(query);
    return query ===
      "send form review action trezor connect sign transaction push"
      ? [
          state,
          flow,
          ...matches.filter((item) => item !== state && item !== flow),
        ]
      : matches;
  };
  const transactionSeeds = resolveExploreSeeds(
    transactionStorage,
    "Trace the send form review action through @trezor/connect TrezorConnect.signTransaction and pushTransaction",
    undefined,
    8,
  );
  assert.equal(
    queries[0],
    "send form review action trezor connect sign transaction push",
  );
  assert.equal(transactionSeeds[0], "send-flow");
  assert.ok(transactionSeeds.includes("connect-facade"));
  assert.ok(!transactionSeeds.includes("a-connect-mobile-facade"));
  assert.ok(!transactionSeeds.includes("connect-sign"));
  assert.ok(!transactionSeeds.includes("connect-sign-type"));
  assert.ok(!transactionSeeds.includes("action"));
  assert.ok(
    unrelatedPushes.every(
      ({ entity }) => !transactionSeeds.includes(entity.id),
    ),
  );

  const contract = entity("contract", "Swapper", "types.ts", {
    symbolType: "alias",
  });
  assert.ok(
    resolveExploreSeeds(
      entityStorage([contract, flow]),
      "Trace quote execution through the Swapper interface",
      undefined,
      8,
    ).includes("contract"),
  );
});

test("qualified owner fallbacks prefer the variant connected to the flow", () => {
  const entry = entity("entry", "startRequest", "src/request.ts", {
    symbolType: "function",
    text: "function startRequest() { Client.execute(); }",
  });
  const unrelated = entity("client-a", "Client", "adapters/a.ts", {
    symbolType: "value",
  });
  const connected = entity("client-b", "Client", "adapters/b.ts", {
    symbolType: "value",
  });
  const base = entityStorage([entry, unrelated, connected]);
  const storage = {
    ...base,
    incomingEdges(ids, kinds) {
      return ids.includes("client-b") && kinds.includes("REFS")
        ? [{ src: "entry", dst: "client-b", kind: "REFS" }]
        : [];
    },
    outgoingEdges() {
      return [];
    },
  };

  const seeds = resolveExploreSeeds(
    storage,
    "Trace startRequest through Client.execute",
    undefined,
    8,
  );

  assert.ok(seeds.includes("client-b"));
  assert.ok(!seeds.includes("client-a"));

  const factory = entity("factory", "factoryPrivileged", "factory.ts", {
    symbolType: "function",
  });
  const receiver = entity("core-value", "core", "bridge.ts", {
    symbolType: "value",
  });
  const call = entity("core-call", "call", "core-in-module.ts", {
    symbolType: "function",
  });
  call.entity.metadata.scope = "CoreInModule";
  const otherCall = entity("other-call", "call", "desktop.ts", {
    symbolType: "function",
  });
  otherCall.entity.metadata.scope = "CoreInSuiteDesktop";
  const expressionStorage = entityStorage([factory, receiver, call, otherCall]);
  expressionStorage.dynamicBoundaries = (ids) =>
    ids.includes("factory")
      ? [
          {
            sourceId: "factory",
            target: { raw: "core.call", member: "call" },
            reason: "polymorphic_dispatch",
            candidates: ["core-call"],
            candidatesTruncated: false,
            candidateDetails: [
              {
                targetId: "core-call",
                reason: "generic_bound",
                confidence: 0.65,
              },
            ],
          },
        ]
      : [];
  const expressionSeeds = resolveExploreSeeds(
    expressionStorage,
    "factoryPrivileged through core.call",
    undefined,
    8,
  );
  assert.ok(expressionSeeds.includes("core-call"));
  assert.ok(!expressionSeeds.includes("other-call"));
  assert.ok(!expressionSeeds.includes("core-value"));
});

test("flow paths can cross a value reference without preferring a shorter unrelated action", () => {
  const entities = [
    entity("start", "submitTransaction", "src/submit.ts", {
      symbolType: "function",
    }),
    entity("sign", "signTransactionThunk", "src/sign.ts", {
      symbolType: "function",
    }),
    entity("cancel", "cancelTransaction", "src/cancel.ts", {
      symbolType: "function",
    }),
    entity("facade", "Client", "src/client.ts", { symbolType: "value" }),
  ];
  const storage = entityStorage(entities);
  const edges = [
    { src: "start", dst: "cancel", kind: "CALLS", rel: "call", first_line: 2 },
    { src: "cancel", dst: "facade", kind: "REFS", rel: "value", first_line: 3 },
    { src: "start", dst: "sign", kind: "CALLS", rel: "call", first_line: 4 },
    { src: "sign", dst: "facade", kind: "REFS", rel: "value", first_line: 5 },
  ].map((edge) => ({
    ...edge,
    count: 1,
    ref_name: edge.dst,
    confidence: 1,
  }));
  const graph = {
    ...storage,
    pathBetween: () => [{ id: "start" }, { id: "cancel" }, { id: "facade" }],
    outgoingEdges(ids) {
      const sources = new Set(ids);
      return edges.filter((edge) => sources.has(edge.src));
    },
  };

  assert.deepEqual(
    collectCallPaths(
      graph,
      ["start", "facade"],
      4,
      2,
      ["sign", "transaction"],
      ["signTransaction"],
    ).paths[0]?.nodes,
    ["start", "sign", "facade"],
  );
});

test("execution flow continues through a terminal root with outgoing calls", () => {
  const edge = (src, dst) => ({
    src,
    dst,
    kind: "CALLS",
    rel: "call",
    count: 1,
    firstLine: 1,
    refName: dst,
    provenance: "static",
    confidence: 1,
  });
  const result = deriveExecutionPaths(
    [{ from: "entry", to: "facade", nodes: ["entry", "facade"] }],
    [edge("facade", "factory"), edge("factory", "dispatch")],
    ["entry", "facade"],
    new Map(),
    new Map(),
    3,
    4,
    new Set(["entry", "facade"]),
  );

  assert.deepEqual(result[0]?.nodes, ["entry", "facade", "factory"]);

  const aliasResult = deriveExecutionPaths(
    [],
    [
      {
        ...edge("entry", "alias"),
        provenance: "heuristic",
        confidence: 0.85,
      },
      { ...edge("alias", "implementation"), kind: "REFS", rel: "function" },
      edge("implementation", "dispatch"),
    ],
    ["entry"],
    new Map(),
    new Map(),
    3,
    2,
  );
  assert.deepEqual(aliasResult[0]?.nodes, [
    "entry",
    "alias",
    "implementation",
    "dispatch",
  ]);

  const registryResult = deriveExecutionPaths(
    [],
    [
      { ...edge("entry", "registry"), kind: "REFS", rel: "value" },
      { ...edge("registry", "provider"), kind: "REFS", rel: "value" },
      { ...edge("provider", "implementation"), kind: "REFS", rel: "value" },
      edge("implementation", "dispatch"),
    ],
    ["entry"],
    new Map(),
    new Map(),
    4,
    2,
  );
  assert.deepEqual(registryResult[0]?.nodes, [
    "entry",
    "registry",
    "provider",
    "implementation",
    "dispatch",
  ]);
});

test("explore accepts an exact symbol name as seedId", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "service-file",
    [
      {
        id: "post-service",
        kind: "class",
        is_exported: true,
        name: "PostService",
      },
      {
        id: "queue",
        kind: "function",
        is_exported: true,
        name: "queue",
      },
    ],
    [],
    [],
  );
  Object.assign(
    graph,
    entityStorage([
      entity("post-service", "PostService", "post/post.service.ts", {
        symbolType: "class",
      }),
      entity("queue", "queue", "post/post.service.ts", {
        symbolType: "function",
      }),
    ]),
  );
  graph.getEntity("queue").entity.metadata.scope = "PostService";

  const result = exploreGraph(graph, {
    query: "Trace post submission",
    seedId: "PostService",
  });

  assert.equal(result.emptyReason, undefined);
  assert.equal(result.nodes.find((node) => node.isRoot)?.id, "post-service");

  const contextual = exploreGraph(graph, {
    query: "PostService.queue workflow",
    seedId: "post-service",
  });
  assert.ok(
    contextual.nodes.some((node) => node.id === "queue" && node.isRoot),
  );
  graph.close();
});

test("file selection uses symbol overlap rather than role labels for redundancy", () => {
  const selected = selectExploreFiles({
    ordered: [
      ["root", 10],
      ["duplicate", 9],
      ["distinct", 8.5],
    ],
    maxFiles: 2,
    intent: "exact_symbol",
    evidence: new Map([
      [
        "root",
        new Map([
          ["root", 1],
          ["symbol:class::Root", 1],
        ]),
      ],
      ["duplicate", new Map([["symbol:class::Root", 1]])],
      ["distinct", new Map([["symbol:class::Other", 1]])],
    ]),
  });

  assert.deepEqual(
    selected.map(({ fileId }) => fileId),
    ["root", "distinct"],
  );
});

test("impact-only files need source-upgrade evidence", () => {
  const evidence = (...entries) => new Map(entries);
  const impact = (...entries) => evidence(["impact_summary", 1], ...entries);
  const selected = selectExploreFiles({
    ordered: [
      ["root", 10],
      ["passive", 9],
      ["direct", 8],
      ["aligned", 7],
      ["partial", 6],
    ],
    maxFiles: 5,
    intent: "exact_symbol",
    evidence: new Map([
      ["root", evidence(["root", 1])],
      ["passive", impact()],
      ["direct", impact(["direct_call", 1])],
      ["aligned", impact(["query_alignment", 1])],
      ["partial", impact(["query_alignment", 0.5])],
    ]),
  });

  assert.deepEqual(
    new Set(selected.map(({ fileId }) => fileId)),
    new Set(["root", "direct", "aligned"]),
  );
});

test("file selection ranks call paths instead of reserving a slot", () => {
  const selected = selectExploreFiles({
    ordered: [
      ["root", 10],
      ["lexical", 9],
      ["flow", 1],
    ],
    maxFiles: 2,
    intent: "concept",
    evidence: new Map([
      ["root", new Map([["root", 1]])],
      ["lexical", new Map([["semantic_seed", 1]])],
      ["flow", new Map([["call_path", 1]])],
    ]),
  });

  assert.deepEqual(
    selected.map(({ fileId }) => fileId),
    ["root", "lexical"],
  );
});

test("files consuming a root-family value receive collaborator evidence", () => {
  const contract = entity("contract", "Contract", "contract.ts", {
    symbolType: "alias",
  });
  const registry = entity("registry", "implementations", "registry.ts", {
    symbolType: "value",
  });
  const consumer = entity("consumer", "resolveRequest", "consumer.ts", {
    symbolType: "function",
  });
  const nodes = [contract, registry, consumer].map((stored) => ({
    id: stored.entity.id,
    isRoot: stored === contract,
    entity: stored,
  }));
  const edges = [
    { src: "registry", dst: "contract" },
    { src: "consumer", dst: "registry" },
  ].map((edge) => ({
    ...edge,
    kind: "REFS",
    rel: "value",
    count: 1,
    firstLine: 1,
    refName: edge.dst,
    provenance: "static",
    confidence: 1,
  }));
  const pool = new ExploreCandidatePool(nodes, new Map());

  collectExploreFileEvidence({
    graph: { outgoingEdges: () => [] },
    pool,
    edges,
    callPaths: [],
    rootFileIds: new Set([contract.file.id]),
    query: "resolve contract implementation",
  });

  assert.equal(
    pool.fileEvidence.get(consumer.file.id)?.has("collaborator"),
    true,
  );
});

test("exploreSubgraph expands and RWR-scores multiple seeds without context assembly", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "flow",
    [
      { id: "left", kind: "function", is_exported: true, name: "left" },
      { id: "bridge", kind: "function", is_exported: false, name: "bridge" },
      { id: "right", kind: "function", is_exported: true, name: "right" },
    ],
    [
      {
        src: "left",
        dst: "bridge",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "bridge",
        kind: "CALLS",
      },
      {
        src: "bridge",
        dst: "right",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "right",
        kind: "CALLS",
      },
    ],
    [],
  );
  const storage = entityStorage([
    entity("left", "left", "flow.ts"),
    entity("bridge", "bridge", "flow.ts"),
    entity("right", "right", "flow.ts"),
  ]);

  Object.assign(graph, storage);
  const result = exploreSubgraph(graph, {
    seedIds: ["left", "right"],
    seedWeights: new Map([
      ["left", 9],
      ["right", 1],
    ]),
    traversalDepth: 2,
    maxNodes: 32,
    includeCallPaths: false,
  });

  assert.deepEqual(result.rootIds, ["left", "right"]);
  assert.ok(result.nodes.some((node) => node.id === "bridge"));
  assert.equal(result.callPaths.length, 0);
  assert.ok((result.nodeScores.get("bridge") ?? 0) > 0);
  assert.ok(
    (result.nodeScores.get("left") ?? 0) >
      (result.nodeScores.get("right") ?? 0),
  );
  graph.close();
});

test("exploreSubgraph retains direct value collaborators within its node budget", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const callees = Array.from({ length: 20 }, (_, index) => `callee-${index}`);
  graph.upsertFileGraph(
    "flow",
    [
      { id: "root", kind: "function", is_exported: true, name: "root" },
      { id: "zz-client", kind: "value", is_exported: false, name: "Client" },
      ...callees.map((id) => ({
        id,
        kind: "function",
        is_exported: false,
        name: id,
      })),
    ],
    [
      {
        src: "root",
        dst: "zz-client",
        rel: "ref",
        count: 1,
        first_line: 1,
        ref_name: "Client",
        kind: "REFS",
      },
      ...callees.map((id, index) => ({
        src: "root",
        dst: id,
        rel: "call",
        count: 1,
        first_line: index + 2,
        ref_name: id,
        kind: "CALLS",
      })),
    ],
    [],
  );
  Object.assign(
    graph,
    entityStorage([
      entity("root", "root", "flow.ts"),
      entity("zz-client", "Client", "client.ts", { symbolType: "value" }),
      ...callees.map((id) => entity(id, id, "flow.ts")),
    ]),
  );

  const result = exploreSubgraph(graph, {
    seedIds: ["root"],
    query: "Client send",
    maxNodes: 16,
    includeCallPaths: false,
  });

  assert.equal(result.nodes.length, 16);
  assert.ok(result.nodes.some((node) => node.id === "zz-client"));
  graph.close();
});

test("exploreSubgraph retains collaborator construction wiring", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "flow",
    [
      { id: "client", kind: "class", is_exported: true, name: "Client" },
      {
        id: "constructor",
        kind: "function",
        is_exported: false,
        name: "constructor",
      },
      {
        id: "entry",
        kind: "function",
        is_exported: true,
        name: "sendMessage",
      },
      { id: "manager", kind: "class", is_exported: true, name: "Manager" },
      {
        id: "dispatch",
        kind: "function",
        is_exported: true,
        name: "dispatch",
      },
      { id: "invoke", kind: "function", is_exported: false, name: "invoke" },
      { id: "send", kind: "function", is_exported: false, name: "send" },
    ],
    [
      {
        src: "client",
        dst: "constructor",
        rel: "contains",
        count: 1,
        first_line: 1,
        ref_name: "constructor",
        kind: "CONTAINS",
      },
      {
        src: "manager",
        dst: "dispatch",
        rel: "contains",
        count: 1,
        first_line: 10,
        ref_name: "dispatch",
        kind: "CONTAINS",
      },
      {
        src: "entry",
        dst: "dispatch",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "dispatch",
        kind: "CALLS",
      },
      {
        src: "constructor",
        dst: "manager",
        rel: "new",
        count: 1,
        first_line: 2,
        ref_name: "Manager",
        kind: "CALLS",
      },
      {
        src: "constructor",
        dst: "invoke",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "invoke",
        kind: "CALLS",
      },
      {
        src: "invoke",
        dst: "send",
        rel: "call",
        count: 1,
        first_line: 4,
        ref_name: "send",
        kind: "CALLS",
      },
    ],
    [],
  );
  Object.assign(
    graph,
    entityStorage([
      entity("client", "Client", "client.ts", { symbolType: "class" }),
      entity("constructor", "constructor", "client.ts", {
        symbolType: "function",
      }),
      entity("entry", "sendMessage", "client.ts", {
        symbolType: "function",
      }),
      entity("manager", "Manager", "manager.ts", { symbolType: "class" }),
      entity("dispatch", "dispatch", "manager.ts", {
        symbolType: "function",
      }),
      entity("invoke", "invoke", "client.ts", { symbolType: "function" }),
      entity("send", "send", "transport.ts", { symbolType: "function" }),
    ]),
  );
  graph.dynamicBoundaries = (ids) =>
    ids.includes("dispatch")
      ? [
          {
            sourceId: "dispatch",
            target: { raw: "client.invoke", member: "invoke" },
            reason: "unknown_receiver_type",
            candidates: [],
            candidatesTruncated: false,
            candidateDetails: [],
          },
        ]
      : [];

  const result = exploreSubgraph(graph, {
    seedIds: ["entry"],
    query: "send message through manager dispatch wiring",
    traversalDepth: 2,
    maxNodes: 16,
  });

  assert.ok(result.nodes.some((node) => node.id === "constructor"));
  assert.deepEqual(result.structuralBridgeIds, [
    "constructor",
    "invoke",
    "send",
  ]);
  graph.close();
});

test("exploreSubgraph bounds failed call-path attempts and edge reads", () => {
  class TrackingGraph extends SqliteGraphStorage {
    pathAttempts = 0;
    edgeBudget = 0;
    pathBetween(_from, _to, _depth, edgeLimit) {
      this.pathAttempts += 1;
      this.edgeBudget += edgeLimit;
      return null;
    }
  }
  const graph = new TrackingGraph("", { inMemory: true });
  const rootIds = Array.from({ length: 32 }, (_, index) => `isolated-${index}`);
  const storage = entityStorage(
    rootIds.map((id) => entity(id, id, `${id}.ts`)),
  );

  Object.assign(graph, storage);
  const result = exploreSubgraph(graph, {
    seedIds: rootIds,
    traversalDepth: 3,
    maxNodes: 16,
    includeCallPaths: true,
  });

  assert.equal(result.rootIds.length, 16);
  assert.ok(
    result.rootIds.every((id) => result.nodes.some((node) => node.id === id)),
  );
  assert.equal(graph.pathAttempts, 32);
  assert.ok(graph.edgeBudget <= 20_000);
  graph.close();
});

test("explore reports truncated dynamic boundary output", () => {
  class BoundaryGraph extends SqliteGraphStorage {
    dynamicBoundaries(_ids, limit) {
      return Array.from({ length: limit }, (_, index) => ({
        sourceId: "root",
        target: { raw: `value.run${index}`, member: `run${index}` },
        reason: "polymorphic_dispatch",
        candidates: [`candidate-${index}`],
        candidatesTruncated: false,
        candidateDetails: [
          {
            targetId: `candidate-${index}`,
            reason: "hierarchy",
            confidence: 0.5,
          },
        ],
      }));
    }
  }
  const graph = new BoundaryGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "root-file",
    [{ id: "root", kind: "function", is_exported: true, name: "root" }],
    [],
    [],
  );
  const storage = entityStorage([entity("root", "root", "root.ts")]);

  Object.assign(graph, storage);
  const result = exploreGraph(graph, {
    query: "root",
    maxNodes: 16,
  });

  assert.equal(result.dynamicBoundaries.length, 16);
  assert.equal(result.dynamicBoundariesTruncated, true);
  graph.close();
});

test("explore keeps unresolved dynamic boundaries on the execution spine", () => {
  class BoundaryGraph extends SqliteGraphStorage {
    dynamicBoundaries() {
      return [
        {
          sourceId: "root",
          target: { raw: "client.invoke", member: "invoke" },
          reason: "polymorphic_dispatch",
          candidates: [],
          candidatesTruncated: false,
          candidateDetails: [],
        },
      ];
    }
  }
  const graph = new BoundaryGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "root-file",
    [{ id: "root", kind: "function", is_exported: true, name: "root" }],
    [],
    [],
  );
  Object.assign(graph, entityStorage([entity("root", "root", "root.ts")]));

  const result = exploreGraph(graph, { query: "root", maxNodes: 16 });

  assert.deepEqual(
    result.dynamicBoundaries.map((boundary) => boundary.target.raw),
    ["client.invoke"],
  );
  graph.close();
});

test("execution boundaries are not crowded out by peripheral candidates", () => {
  class BoundaryGraph extends SqliteGraphStorage {
    dynamicBoundaries() {
      return [
        ...Array.from({ length: 16 }, (_, index) => ({
          sourceId: `peripheral-${index}`,
          target: { raw: `value.run${index}`, member: `run${index}` },
          reason: "polymorphic_dispatch",
          candidates: [`candidate-${index}`],
          candidatesTruncated: false,
          candidateDetails: [
            {
              targetId: `candidate-${index}`,
              reason: "hierarchy",
              confidence: 0.5,
            },
          ],
        })),
        {
          sourceId: "root",
          target: { raw: "registry[key]", member: "<dynamic>" },
          reason: "runtime_dispatch",
          candidates: [],
          candidatesTruncated: false,
          candidateDetails: [],
        },
      ];
    }
  }
  const graph = new BoundaryGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "root-file",
    [{ id: "root", kind: "function", is_exported: true, name: "root" }],
    [],
    [],
  );
  Object.assign(graph, entityStorage([entity("root", "root", "root.ts")]));

  const result = exploreGraph(graph, { query: "root", maxNodes: 16 });

  assert.ok(
    result.dynamicBoundaries.some(
      (boundary) => boundary.target.raw === "registry[key]",
    ),
  );
  graph.close();
});

test("explore follows a unique query-aligned dynamic target", () => {
  class BoundaryGraph extends SqliteGraphStorage {
    dynamicBoundaries() {
      return [
        {
          sourceId: "root",
          line: 2,
          target: { raw: "registry[key]", member: "<dynamic>" },
          reason: "runtime_dispatch",
          candidates: ["writer", "other"],
          candidatesTruncated: false,
          candidateDetails: [
            {
              targetId: "writer",
              reason: "namespace_export",
              confidence: 0.7,
            },
            {
              targetId: "other",
              reason: "namespace_export",
              confidence: 0.7,
            },
          ],
        },
      ];
    }
  }
  const graph = new BoundaryGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "root-file",
    [{ id: "root", kind: "function", is_exported: true, name: "serialize" }],
    [],
    [],
  );
  Object.assign(
    graph,
    entityStorage([
      entity("root", "serialize", "serialize.ts", { symbolType: "function" }),
      entity("writer", "writeObject", "writer.ts", {
        symbolType: "function",
      }),
      entity("other", "unrelated", "other.ts", {
        symbolType: "function",
      }),
    ]),
  );

  const result = exploreGraph(graph, {
    query: "serialize request with writer",
    seedId: "root",
    maxFiles: 2,
    maxNodes: 16,
  });

  assert.ok(
    result.files.some((file) => file.file.relativePath === "writer.ts"),
  );
  assert.equal(
    result.edges.some((edge) => edge.src === "root" && edge.dst === "other"),
    false,
  );
  graph.close();
});

test("explore binds generic dispatch to the implementation instantiated by its caller", () => {
  class BoundaryGraph extends SqliteGraphStorage {
    dynamicBoundaries(ids) {
      return ids.includes("factory")
        ? [
            {
              sourceId: "factory",
              line: 2,
              target: { raw: "core.call", member: "call" },
              reason: "polymorphic_dispatch",
              candidates: ["base-call", "other-call"],
              candidatesTruncated: false,
              candidateDetails: [
                {
                  targetId: "base-call",
                  reason: "generic_bound",
                  confidence: 0.65,
                },
                {
                  targetId: "other-call",
                  reason: "generic_bound",
                  confidence: 0.65,
                },
              ],
            },
          ]
        : [];
    }
  }
  const graph = new BoundaryGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "graph",
    [
      { id: "facade", kind: "value", is_exported: true, name: "facade" },
      { id: "factory", kind: "function", is_exported: true, name: "factory" },
      { id: "impl", kind: "class", is_exported: true, name: "Impl" },
      { id: "base", kind: "class", is_exported: true, name: "Base" },
      { id: "base-call", kind: "function", is_exported: true, name: "call" },
      { id: "other", kind: "class", is_exported: true, name: "Other" },
      { id: "other-call", kind: "function", is_exported: true, name: "call" },
    ],
    [
      { src: "facade", dst: "factory", kind: "CALLS", rel: "call" },
      {
        src: "facade",
        dst: "impl",
        kind: "INSTANTIATES",
        rel: "instantiates",
      },
      { src: "impl", dst: "base", kind: "INHERITS", rel: "extends" },
      { src: "base", dst: "base-call", kind: "CONTAINS", rel: "contains" },
      {
        src: "other",
        dst: "other-call",
        kind: "CONTAINS",
        rel: "contains",
      },
    ].map((edge) => ({
      ...edge,
      count: 1,
      first_line: 1,
      ref_name: edge.dst,
    })),
    [],
  );
  Object.assign(
    graph,
    entityStorage([
      entity("facade", "facade", "facade.ts", { symbolType: "value" }),
      entity("factory", "factory", "factory.ts"),
      entity("impl", "Impl", "impl.ts", { symbolType: "class" }),
      entity("base", "Base", "base.ts", { symbolType: "class" }),
      entity("base-call", "call", "base.ts"),
      entity("other", "Other", "other.ts", { symbolType: "class" }),
      entity("other-call", "call", "other.ts"),
    ]),
  );

  const result = exploreGraph(graph, {
    query: "trace facade dispatch",
    seedId: "facade",
    maxFiles: 5,
    maxNodes: 24,
  });

  assert.ok(
    result.edges.some(
      (edge) =>
        edge.src === "factory" &&
        edge.dst === "base-call" &&
        edge.rel === "dynamic",
    ),
  );
  assert.equal(
    result.edges.some(
      (edge) => edge.src === "factory" && edge.dst === "other-call",
    ),
    false,
  );
  graph.close();
});

test("qualified endpoints retain a call-only path to a matching dynamic boundary", () => {
  class FocusedBoundaryGraph extends SqliteGraphStorage {
    traverse(id, options) {
      const refs = super.traverse(id, options);
      return options.edgeKinds.length === 1 && options.edgeKinds[0] === "CALLS"
        ? refs
        : refs.filter((ref) => ref.id !== "terminal");
    }

    dynamicBoundaries(ids) {
      return ids.includes("terminal")
        ? [
            {
              sourceId: "terminal",
              line: 3,
              target: { raw: "method.run", member: "run" },
              reason: "polymorphic_dispatch",
              candidates: ["sign-run"],
              candidatesTruncated: false,
              candidateDetails: [
                {
                  targetId: "sign-run",
                  displayName: "SignTransaction::run",
                  filePath: "sign-transaction.ts",
                  reason: "hierarchy",
                  confidence: 0.65,
                },
              ],
            },
          ]
        : [];
    }
  }
  const graph = new FocusedBoundaryGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "flow-file",
    [
      { id: "root", kind: "function", is_exported: true, name: "review" },
      { id: "step", kind: "function", is_exported: false, name: "sign" },
      { id: "terminal", kind: "function", is_exported: false, name: "send" },
      { id: "client", kind: "value", is_exported: true, name: "Client" },
    ],
    [
      {
        src: "root",
        dst: "step",
        kind: "CALLS",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "sign",
      },
      {
        src: "step",
        dst: "terminal",
        kind: "CALLS",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "send",
      },
    ],
    [],
  );
  const signRun = entity("sign-run", "run", "sign-transaction.ts");
  signRun.entity.metadata.scope = "SignTransaction";
  Object.assign(
    graph,
    entityStorage([
      entity("root", "review", "flow.ts"),
      entity("step", "sign", "flow.ts"),
      entity("terminal", "send", "flow.ts"),
      entity("client", "Client", "client.ts", { symbolType: "value" }),
      signRun,
    ]),
  );

  const result = exploreSubgraph(graph, {
    seedIds: ["root", "client"],
    query: "trace review through Client.signTransaction",
    traversalDepth: 3,
    maxNodes: 16,
    includeCallPaths: true,
  });

  assert.ok(
    result.callPaths.some(
      (path) => path.nodes.join(",") === "root,step,terminal",
    ),
  );
  const explored = exploreGraph(graph, {
    query: "trace review through Client.signTransaction",
    seedId: "root",
    maxFiles: 4,
    maxNodes: 16,
  });
  assert.ok(
    explored.dynamicBoundaries.some((item) => item.target.member === "run"),
  );
  assert.ok(explored.nodes.some((node) => node.id === "sign-run"));
  graph.close();
});

test("concept flows keep callers when they name a qualified endpoint", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "flow",
    [
      { id: "button", kind: "function", is_exported: true, name: "button" },
      { id: "send", kind: "function", is_exported: true, name: "send" },
    ],
    [
      {
        src: "button",
        dst: "send",
        kind: "CALLS",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "send",
      },
    ],
    [],
  );
  const send = entity("send", "send", "client.ts");
  send.entity.metadata.scope = "Client";
  Object.assign(
    graph,
    entityStorage([entity("button", "button", "ui.ts"), send]),
  );

  const result = exploreGraph(graph, {
    query: "how does the UI reach Client.send",
    maxFiles: 2,
  });

  assert.ok(result.nodes.some((node) => node.id === "button"));
  graph.close();
});

test("exploreSubgraph drops call paths that exceed the retained node budget", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const rootIds = Array.from({ length: 16 }, (_, index) => `root-${index}`);
  graph.upsertFileGraph(
    "paths",
    [
      ...rootIds.map((id) => ({
        id,
        kind: "function",
        is_exported: true,
        name: id,
      })),
      { id: "bridge", kind: "function", is_exported: false, name: "bridge" },
    ],
    [
      {
        src: rootIds[0],
        dst: "bridge",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "bridge",
        kind: "CALLS",
      },
      {
        src: "bridge",
        dst: rootIds[1],
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: rootIds[1],
        kind: "CALLS",
      },
    ],
    [],
  );
  const storage = entityStorage([
    ...rootIds.map((id) => entity(id, id, "paths.ts")),
    entity("bridge", "bridge", "paths.ts"),
  ]);
  Object.assign(graph, storage);
  const result = exploreSubgraph(graph, {
    seedIds: rootIds,
    maxNodes: 16,
    includeCallPaths: true,
  });
  const retained = new Set(result.nodes.map((node) => node.id));
  assert.equal(result.nodes.length, 16);
  assert.equal(retained.has("bridge"), false);
  assert.equal(result.callPaths.length, 0);
  assert.ok(
    result.callPaths.every((path) =>
      path.nodes.every((id) => retained.has(id)),
    ),
  );
  graph.close();
});

test("explore maxChars is a hard source-text budget", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "large",
    [
      {
        id: "large-symbol",
        kind: "function",
        is_exported: true,
        name: "large",
      },
    ],
    [],
    [],
  );
  const storage = entityStorage([
    entity("large-symbol", "large", "large.ts", {
      symbolType: "function",
      text: `export function large() {\n${"x".repeat(8_000)}\n}`,
    }),
  ]);
  Object.assign(graph, storage);
  const result = exploreGraph(graph, {
    query: "large",
    maxChars: 1_000,
    maxFiles: 1,
  });
  assert.ok(result.files.length > 0);
  assert.ok(
    result.files.reduce((sum, file) => sum + file.text.length, 0) <= 1_000,
  );
  assert.ok(result.files[0].text.length < 1_000);
  assert.match(result.files[0].text, /truncated/);
  assert.doesNotMatch(result.files[0].text, /[^\n]\/\/ \.\.\. truncated/);
  graph.close();
});

test("exact explore renders its root before a larger call-spine neighbor", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "flow",
    [
      { id: "helper", kind: "function", is_exported: false, name: "helper" },
      { id: "target", kind: "function", is_exported: true, name: "target" },
    ],
    [
      {
        src: "target",
        dst: "helper",
        rel: "call",
        count: 1,
        first_line: 72,
        ref_name: "helper",
        kind: "CALLS",
      },
    ],
    [],
  );
  Object.assign(
    graph,
    entityStorage([
      entity("helper", "helper", "flow.ts", {
        symbolType: "function",
        startLine: 1,
        endLine: 60,
        text: `function helper() {\n${"  work();\n".repeat(58)}}`,
      }),
      entity("target", "target", "flow.ts", {
        symbolType: "function",
        startLine: 70,
        endLine: 74,
        text: "function target() {\n  helper();\n  return TARGET_COMPLETE;\n}",
      }),
    ]),
  );
  graph.getEntity("target").entity.metadata.scope = "Service";

  const result = exploreGraph(graph, {
    query: "target",
    maxChars: 700,
    maxFiles: 1,
  });

  assert.match(result.files[0]?.text ?? "", /TARGET_COMPLETE/);
  assert.match(result.files[0]?.text ?? "", /Service::target/);
  graph.close();
});

test("exact explore prefers query-relevant nested source over large envelopes", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "nested",
    [
      { id: "container", kind: "value", is_exported: true, name: "api" },
      { id: "root", kind: "function", is_exported: true, name: "endpoints" },
      {
        id: "query-fn",
        kind: "function",
        is_exported: false,
        name: "queryFn",
        scope: "api::endpoints::getTradeRates",
      },
    ],
    [
      {
        src: "container",
        dst: "root",
        rel: "contains",
        count: 1,
        first_line: 2,
        ref_name: "endpoints",
        kind: "CONTAINS",
      },
      {
        src: "root",
        dst: "query-fn",
        rel: "contains",
        count: 1,
        first_line: 44,
        ref_name: "queryFn",
        kind: "CONTAINS",
      },
    ],
    [],
  );
  const source = [
    "const api = { // OUTER_ONLY",
    "  endpoints: builder => ({",
    ...Array.from({ length: 40 }, () => "    unrelated(),"),
    "    getTradeRates: builder.query({",
    "      queryFn: async () => {",
    "        return INNER_ROOT_BODY;",
    "      },",
    "    }),",
    ...Array.from({ length: 40 }, () => "    unrelated(),"),
    "  }),",
    "};",
  ].join("\n");
  const container = entity("container", "api", "nested.ts", {
    symbolType: "value",
    startLine: 1,
    endLine: 89,
    text: source,
  });
  const root = entity("root", "endpoints", "nested.ts", {
    symbolType: "function",
    startLine: 2,
    endLine: 88,
    text: source.split("\n").slice(1, 88).join("\n"),
  });
  const queryFn = entity("query-fn", "queryFn", "nested.ts", {
    symbolType: "function",
    scope: "api::endpoints::getTradeRates",
    startLine: 44,
    endLine: 46,
    text: source.split("\n").slice(43, 46).join("\n"),
  });
  Object.assign(container.entity.range, { startOffset: 0, endOffset: 2_000 });
  Object.assign(root.entity.range, { startOffset: 20, endOffset: 1_990 });
  Object.assign(queryFn.entity.range, { startOffset: 900, endOffset: 980 });
  Object.assign(graph, entityStorage([container, root, queryFn]), {
    readFileText: () => source,
  });

  const result = exploreGraph(graph, {
    query: "endpoints getTradeRates",
    maxChars: 1_000,
    maxFiles: 1,
  });

  assert.match(result.files[0]?.text ?? "", /INNER_ROOT_BODY/);
  assert.doesNotMatch(result.files[0]?.text ?? "", /OUTER_ONLY/);
  graph.close();
});

test("explore keeps annotations immediately preceding a selected declaration", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "controller",
    [
      {
        id: "controller",
        kind: "class",
        is_exported: true,
        name: "Controller",
      },
      { id: "queue", kind: "function", is_exported: true, name: "queue" },
    ],
    [
      {
        src: "controller",
        dst: "queue",
        rel: "contains",
        count: 1,
        first_line: 4,
        ref_name: "queue",
        kind: "CONTAINS",
      },
    ],
    [],
  );
  const source = [
    "@Controller('post')",
    "class Controller {",
    "  @Route('queue/:id')",
    "  queue(id: string) { return QUEUE_BODY; }",
    "}",
  ].join("\n");
  const controller = entity("controller", "Controller", "controller.ts", {
    symbolType: "class",
    startLine: 2,
    endLine: 5,
    text: source.split("\n").slice(1).join("\n"),
  });
  const queue = entity("queue", "queue", "controller.ts", {
    symbolType: "function",
    startLine: 4,
    endLine: 4,
    text: "queue(id: string) { return QUEUE_BODY; }",
  });
  queue.entity.metadata.scope = "Controller";
  Object.assign(controller.entity.range, { startOffset: 20, endOffset: 140 });
  Object.assign(queue.entity.range, { startOffset: 80, endOffset: 125 });
  Object.assign(graph, entityStorage([controller, queue]), {
    readFileText: () => source,
  });

  const result = exploreGraph(graph, {
    query: "queue",
    maxChars: 1_000,
    maxFiles: 1,
  });

  assert.match(result.files[0]?.text ?? "", /1\s+@Controller\('post'\)/);
  assert.match(result.files[0]?.text ?? "", /3\s+@Route\('queue\/:id'\)/);
  assert.match(result.files[0]?.text ?? "", /4\s+queue\(id: string\)/);
  graph.close();
});

test("exploreSubgraph gives CALLS more RWR weight than REFS", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "weighted",
    [
      { id: "root", kind: "function", is_exported: true, name: "root" },
      { id: "called", kind: "function", is_exported: true, name: "called" },
      {
        id: "referenced",
        kind: "class",
        is_exported: true,
        name: "referenced",
      },
    ],
    [
      {
        src: "root",
        dst: "called",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "called",
        kind: "CALLS",
      },
      {
        src: "root",
        dst: "referenced",
        rel: "type",
        count: 1,
        first_line: 2,
        ref_name: "referenced",
        kind: "REFS",
      },
    ],
    [],
  );
  const storage = entityStorage([
    entity("root", "root", "weighted.ts"),
    entity("called", "called", "weighted.ts"),
    entity("referenced", "referenced", "weighted.ts", {
      symbolType: "class",
    }),
  ]);

  Object.assign(graph, storage);
  const result = exploreSubgraph(graph, {
    seedIds: ["root"],
    maxNodes: 16,
  });
  assert.ok(
    (result.nodeScores.get("called") ?? 0) >
      (result.nodeScores.get("referenced") ?? 0),
  );
  graph.close();
});

test("exploreSubgraph preserves parallel edge kinds between the same nodes", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "parallel",
    [
      { id: "root", kind: "function", is_exported: true, name: "root" },
      { id: "target", kind: "class", is_exported: true, name: "target" },
    ],
    [
      {
        src: "root",
        dst: "target",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "target",
        kind: "CALLS",
      },
      {
        src: "root",
        dst: "target",
        rel: "type",
        count: 1,
        first_line: 2,
        ref_name: "target",
        kind: "REFS",
      },
    ],
    [],
  );
  const storage = entityStorage([
    entity("root", "root", "parallel.ts"),
    entity("target", "target", "parallel.ts"),
  ]);

  Object.assign(graph, storage);
  const result = exploreSubgraph(graph, {
    seedIds: ["root"],
    maxNodes: 16,
  });

  assert.deepEqual(result.edges.map((edge) => edge.kind).sort(), [
    "CALLS",
    "REFS",
  ]);
  assert.deepEqual(result.edges.map((edge) => edge.rel).sort(), [
    "call",
    "type",
  ]);
  graph.close();
});

test("exploreGraph expands hierarchy, ranks files, assembles zvec content", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "file-base.ts",
    [
      { id: "Base", kind: "class", is_exported: true, name: "Base" },
      { id: "base-run", kind: "function", is_exported: true, name: "run" },
    ],
    [
      {
        src: "Base",
        dst: "base-run",
        rel: "member",
        count: 1,
        first_line: 2,
        ref_name: "run",
        kind: "CONTAINS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "file-child.ts",
    [
      { id: "Child", kind: "class", is_exported: true, name: "Child" },
      { id: "child-run", kind: "function", is_exported: true, name: "run" },
      { id: "helper", kind: "function", is_exported: true, name: "helper" },
    ],
    [
      {
        src: "Child",
        dst: "Base",
        rel: "extends",
        count: 1,
        first_line: 1,
        ref_name: "Base",
        kind: "INHERITS",
      },
      {
        src: "Child",
        dst: "child-run",
        rel: "member",
        count: 1,
        first_line: 2,
        ref_name: "run",
        kind: "CONTAINS",
      },
      {
        src: "helper",
        dst: "Child",
        rel: "call",
        count: 2,
        first_line: 8,
        ref_name: "Child",
        kind: "CALLS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "file-sib.ts",
    [{ id: "Other", kind: "class", is_exported: true, name: "Other" }],
    [
      {
        src: "Other",
        dst: "Base",
        rel: "extends",
        count: 1,
        first_line: 1,
        ref_name: "Base",
        kind: "INHERITS",
      },
    ],
    [],
  );

  const baseRun = entity("base-run", "run", "base.ts", {
    symbolType: "function",
    text: "abstract run(): void;",
  });
  baseRun.entity.metadata.scope = "Base";
  const childRun = entity("child-run", "run", "child.ts", {
    symbolType: "function",
    text: "run() { return 1; }",
  });
  childRun.entity.metadata.scope = "Child";
  const storage = entityStorage([
    entity("Base", "Base", "base.ts"),
    baseRun,
    entity("Child", "Child", "child.ts"),
    childRun,
    entity("helper", "helper", "child.ts", {
      symbolType: "function",
      startLine: 8,
      endLine: 12,
      text: "export function helper() {\n  return Child;\n}",
    }),
    entity("Other", "Other", "sib.ts"),
  ]);

  Object.assign(graph, storage);
  const result = exploreGraph(graph, {
    query: "Child",
    maxFiles: 4,
    traversalDepth: 2,
  });

  assert.equal(result.available, true);
  assert.ok(result.roots.some((r) => r.id === "Child"));
  assert.ok(
    result.nodes.some((n) => n.id === "Base"),
    "hierarchy base",
  );
  assert.ok(
    result.nodes.some((n) => n.id === "Other"),
    "sibling type",
  );
  assert.ok(
    result.nodes.some((n) => n.id === "helper"),
    "call neighbor",
  );
  assert.ok(result.files.length >= 1);
  assert.ok(
    result.files.some(
      (f) => f.text.includes("class Child") || f.text.includes("Child"),
    ),
  );
  assert.ok(result.files.every((f) => f.text.length > 0));
  const methodResult = exploreGraph(graph, {
    query: "Child::run",
    maxFiles: 4,
    traversalDepth: 2,
  });
  assert.ok(
    methodResult.files.some((file) => file.text.includes("abstract run")),
    "method roots retain the inherited contract",
  );
  graph.close();
});

test("exploreGraph rescues a buried callable signature type as change surface", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "request-file",
    [
      {
        id: "request",
        kind: "class",
        is_exported: true,
        name: "CreateRequest",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "helpers-file",
    [
      { id: "helper-a", kind: "function", is_exported: false, name: "helperA" },
      { id: "helper-b", kind: "function", is_exported: false, name: "helperB" },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "root-file",
    [{ id: "create", kind: "function", is_exported: true, name: "create" }],
    [
      {
        src: "create",
        dst: "request",
        rel: "type",
        count: 1,
        first_line: 1,
        ref_name: "CreateRequest",
        kind: "REFS",
      },
      {
        src: "create",
        dst: "helper-a",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "helperA",
        kind: "CALLS",
      },
      {
        src: "create",
        dst: "helper-b",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "helperB",
        kind: "CALLS",
      },
    ],
    [],
  );
  const storage = entityStorage([
    entity("create", "create", "service.ts", { symbolType: "function" }),
    entity("request", "CreateRequest", "model/request.ts", {
      symbolType: "class",
    }),
    entity("helper-a", "helperA", "service/helpers.ts", {
      symbolType: "function",
    }),
    entity("helper-b", "helperB", "service/helpers.ts", {
      symbolType: "function",
    }),
  ]);

  Object.assign(graph, storage);
  const result = exploreGraph(graph, {
    query: "execute workflow",
    seedId: "create",
    searchLimit: 1,
    maxFiles: 2,
  });

  const surface = result.changeSurface.find((item) => item.id === "request");
  assert.ok(surface);
  assert.equal(surface.rel, "type");
  assert.equal(surface.rescued, true);
  assert.ok(
    result.files.some(
      (file) =>
        file.file.relativePath === "model/request.ts" && file.isChangeSurface,
    ),
  );
  graph.close();
});

test("queryGraphNeighborhood supports impact direction", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "fa",
    [
      { id: "user", kind: "function", is_exported: true, name: "user" },
      { id: "target", kind: "function", is_exported: true, name: "target" },
    ],
    [
      {
        src: "user",
        dst: "target",
        rel: "type",
        count: 1,
        first_line: 2,
        ref_name: "target",
        kind: "REFS",
      },
    ],
    [],
  );
  const storage = entityStorage([
    entity("user", "user", "a.ts", { symbolType: "function" }),
    entity("target", "target", "a.ts", { symbolType: "function" }),
  ]);

  Object.assign(graph, storage);
  const result = queryGraphNeighborhood(graph, {
    direction: "impact",
    query: "target",
  });
  assert.equal(result.neighbors[0]?.id, "user");
  graph.close();
});

test("exploreGraph reports graph_unavailable", () => {
  const graph = new UnavailableGraphStorage();
  const result = exploreGraph(graph, { query: "X" });
  assert.equal(result.available, false);
  assert.equal(result.emptyReason, "graph_unavailable");
});

test("exploreGraph recalls natural-language seeds, preserves call paths, and reports blast radius", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "production",
    [
      { id: "login", kind: "function", is_exported: true, name: "login" },
      { id: "bridge", kind: "function", is_exported: false, name: "bridge" },
      {
        id: "validate",
        kind: "function",
        is_exported: true,
        name: "validateToken",
      },
      {
        id: "caller",
        kind: "function",
        is_exported: true,
        name: "requestHandler",
      },
    ],
    [
      {
        src: "login",
        dst: "bridge",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "bridge",
        kind: "CALLS",
      },
      {
        src: "bridge",
        dst: "validate",
        rel: "call",
        count: 1,
        first_line: 6,
        ref_name: "validateToken",
        kind: "CALLS",
      },
      {
        src: "caller",
        dst: "login",
        rel: "call",
        count: 1,
        first_line: 10,
        ref_name: "login",
        kind: "CALLS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "tests",
    [
      {
        id: "login-test",
        kind: "function",
        is_exported: false,
        name: "loginTest",
      },
    ],
    [
      {
        src: "login-test",
        dst: "login",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "login",
        kind: "CALLS",
      },
    ],
    [],
  );

  const storage = entityStorage([
    entity("login", "login", "src/auth.ts", {
      symbolType: "function",
      text: "export function login() {}",
    }),
    entity("bridge", "bridge", "src/auth.ts", {
      symbolType: "function",
      text: "function bridge() {}",
    }),
    entity("validate", "validateToken", "src/token.ts", {
      symbolType: "function",
      text: "export function validateToken() {}",
    }),
    entity("caller", "requestHandler", "src/http.ts", {
      symbolType: "function",
    }),
    entity("login-test", "loginTest", "test/auth.test.ts", {
      symbolType: "function",
    }),
  ]);

  Object.assign(graph, storage);
  const result = exploreGraph(graph, {
    query: "how does login reach validateToken",
    searchLimit: 2,
    maxNodes: 16,
  });

  assert.deepEqual(
    new Set(result.roots.map((root) => root.id)),
    new Set(["login", "validate"]),
  );
  assert.ok(
    result.callPaths.some(
      (path) => path.nodes.join(",") === "login,bridge,validate",
    ),
  );
  assert.ok(
    result.nodes.some((node) => node.id === "bridge"),
    "path bridge is retained",
  );
  const loginBlast = result.blastRadius.find((item) => item.rootId === "login");
  assert.ok(loginBlast?.dependents.some((item) => item.id === "caller"));
  assert.ok(loginBlast?.tests.some((item) => item.id === "login-test"));
  graph.close();
});
