# Graph quality benchmarks

Quality is checked in two separate layers. Do not tune ranking from the
holdout results and then continue to call that suite a holdout.

## Deterministic CI floor

This offline layer protects graph extraction, resolution, and basic Explore
ranking. It does not download repositories, models, or other test data.

Run the six end-to-end Explore fixtures:

```bash
npm run benchmark:explore-quality
```

Run the parser-to-graph language matrix:

```bash
npm run benchmark:language-quality
```

The matrix contains 525 labelled cases across C, C++, JavaScript, JSX,
TypeScript, TSX, Python, Java, Go, Rust, Vue, and Svelte. It covers local and
cross-file calls, imports and aliases, inheritance, receiver resolution,
dynamic boundaries, negative precision, and component wrappers.

The six Explore fixtures separately report root and call-path recall, relevant
file recall and precision, query-concept and function-body coverage, duplicate
source ratio, output characters, and latency. Together, the two suites contain
531 cases and run in the normal unit-test job.

These are regression floors, not claims of real-repository retrieval quality
or compiler-complete static analysis.
When changing extraction or ranking policy, add or update a language-neutral
capability case where possible instead of encoding repository-specific names.

## Real-repository holdout

`real-cases.json` is a source-labelled catalog pinned to repository commits.
Its suites are disjoint by repository:

- `tuning`: cases that may guide ranking changes.
- `holdout`: repositories that must remain unseen while tuning.

After cloning, indexing, and leaving those repositories at the pinned commits,
run the holdout suite:

```bash
npm run benchmark:explore-holdout
```

Repositories default to sibling directories of this checkout. Set
`ZVEC_GRAPH_BENCH_ROOT` when they live under another parent directory. The
runner fails fast when a repository is at the wrong commit or its graph index
uses an obsolete schema.

Use `node benchmarks/explore-quality/run-real.mjs --suite=tuning` while tuning,
or add `--codegraph` for a presentation-aware comparison. The runner reports
required and optional file recall, visible-symbol recall, labelled noise,
output characters, and latency. This is a retrieval smoke test, not an Agent
A/B or an objective measure of answer precision. It is intentionally not part
of default CI because it depends on external repositories and their indexes.

## Agent A/B

`run-agent-ab.mjs` compares raw zvec and CodeGraph Explore under the same Codex
model, question, repository, and prompt. Both repositories must already be
indexed. For example:

```bash
npm run benchmark:explore-agent-ab -- \
  --repo=/path/to/repository \
  --case=request-flow \
  --model=gpt-5.5 \
  --question="Trace a request from the public API to the socket write"
```

It alternates arm order and defaults to three repetitions. The summary reports
Explore calls and payload, subsequent source-reading commands and output,
tokens, latency, and successful runs. Full traces and final answers are kept in
`/tmp/zvec-explore-agent-ab/` (or `--output=...`) for a separate correctness
judge. Trace events are streamed to disk while an arm runs. Results are
appended after every arm, and the next arm still runs after an independent
timeout (`--timeout-seconds=600` by default). Use `--arm=zvec` or
`--arm=codegraph` to reproduce one side. `--model` is required and `--effort`
defaults to `high`, making both arms use the same explicit inference
configuration. The prompt requires Explore as the first repository tool call.
The zvec arm starts the current build in an isolated temporary daemon and
stops it afterward, so a stale shared daemon cannot silently change the tested
code. Stop any existing zvec daemon that already owns the selected workspace
index before running the benchmark.
When `--truth=/path/to/ground-truth.json` is supplied, the selected case's
frozen question is used automatically and the emitted JSONL is compatible with
CodeGraph's independent `offload-eval-judge.mjs` (`repo`, `arm`, `rep`, and
`finalAnswer`).

Freeze a source-verified answer before running this comparison. An independent
LLM judge may compare final answers with that ground truth, but must not create
or revise the ground truth itself. Fewer source reads are useful only when
answer correctness is preserved.
