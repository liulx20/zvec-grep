# Explore quality benchmark

This offline benchmark exercises graph extraction and query behavior across C,
C++, JavaScript, JSX, TypeScript, TSX, Python, Java, Go, and Rust. The fixtures
deliberately include test-file and same-name distractors.

Run it from the repository root:

```bash
npm run benchmark:explore-quality
```

For machine-readable results:

```bash
npm run benchmark:explore-quality -- --json
```

Run the pinned, human-labelled real-repository suite with:

```bash
npm run benchmark:explore-real
npm run benchmark:explore-real -- --codegraph
```

Run the parser-to-graph language matrix with:

```bash
npm run benchmark:language-quality
```

The matrix currently contains 512 cases across ten structured-code languages
plus Vue and Svelte component wrappers. Every case parses real source syntax, builds and resolves the SQLite
graph, executes Explore, and checks Impact where a dependency exists. Shared
coverage includes declarations, local/duplicate/chained/recursive calls,
member receivers, inheritance, type references, qualified external calls, and
unresolved boundaries. Multi-file cases exercise imports,
aliases or namespaces, cross-file calls, inheritance, and type references.
Cross-file factory-return chains are covered for TypeScript, Python, Java,
C++, Go, and Rust. Additional language-specific cases cover constructs
such as decorators, annotations, async calls, interface/supertrait embedding,
static/associated calls, C++ virtual inheritance, Go defer/goroutines, and
Rust trait implementations.

The report separately shows deterministic-edge, dynamic-boundary, negative
precision, and multi-file coverage. `512/512` means every labelled case
passed; it does not claim complete static resolution of runtime dispatch in
dynamic languages.

Eight explicit-inheritance formats also run a parser-to-presentation adaptive
sizing case. A four-file implementation family must retain exactly one full
representative body and render the other two implementations as signature
skeletons. Go is instead covered by structural-interface real-repository cases;
C has no corresponding inheritance construct.

`real-cases.json` records required, optional, and explicitly forbidden files
for Explore, Impact, Callers, and Callees queries across ten formats. The runner reports required recall,
optional coverage, forbidden-file noise, output size, and latency. It verifies
repository commits first so labels cannot silently drift.

Required coverage counts both file and semantic-output assertions. Overall
coverage is weighted by the number of labelled assertions rather than averaged
per case. A case with no optional labels reports `optional=n/a`; it cannot
inflate the aggregate optional score to 100%.

`requiredOutput` and `forbiddenOutput` describe zvec's presentation contract.
When `--codegraph` is enabled, shared file/path assertions are compared across
both tools, while CodeGraph prose is checked only when a case explicitly sets
`codegraphRequiredOutput` or `codegraphForbiddenOutput`. This prevents CLI
syntax differences from being misreported as graph-quality failures. Explore
cases also pass the same per-case `maxFiles` budget to both CLIs, so a tool's
default response size cannot masquerade as a recall difference.

Real cases may also require output fragments, file-path categories, and minimum
or maximum file counts. Interface queries therefore fail when they omit an
integration call site, dynamic boundary, or representative implementation even
if their root file was recalled.

The runner reports four deterministic metrics:

- `rootRecall`: expected query symbols retained as graph roots.
- `pathRecall`: expected call paths present in the explored subgraph.
- `filePrecision`: test and unrelated same-name files excluded from source output.
- `sourceCoverage`: expected current-source method bodies included in the context pack.

The small deterministic fixture suite isolates Explore ranking behavior. The
language matrix covers parser-to-query correctness, while the pinned
real-repository suite measures representative output quality. For manual
comparison with CodeGraph, index the same real repository in both tools, run
the same query, and compare roots, call paths, source files, and low-value-file
count; do not compare output length alone.

Reported latency includes CLI cold start. Query cases therefore include the
Node process, model acquisition, and query embedding; they measure end-to-end
retrieval latency, not SQLite graph latency in isolation. The pinned worktrees
run with `--refresh off`, so workspace freshness scanning is measured by CLI
E2E tests rather than contaminating every quality comparison. Investigate
regressions with the per-stage `--debug` timings and a warm daemon/service
session as well.
Optional recall identifies useful non-essential context, but must not be raised
by inventing unsupported dynamic edges or allowing unbounded expansion.

Measure repeated Query latency without process/model cold start separately:

```bash
node benchmarks/explore-quality/run-warm-query.mjs /path/to/repo 'SymbolName' 4
```

The first iteration includes service/model initialization. Later iterations
reuse the same service and report internal timing stages alongside wall time.
The final record separates cold latency from warm median/p95 so process startup
variation cannot hide a read-session regression.
