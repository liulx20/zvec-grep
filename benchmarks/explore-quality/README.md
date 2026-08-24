# Explore quality benchmark

This deterministic offline suite protects graph extraction, resolution, and
Explore ranking behavior. It does not download repositories, models, or other
test data.

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

The six Explore fixtures separately check root recall, call-path recall, file
precision, and selected-source coverage. Together, the two suites contain 531
cases and run in the normal unit-test job.

These are regression floors, not claims of compiler-complete static analysis.
When changing extraction or ranking policy, add or update a language-neutral
capability case where possible instead of encoding repository-specific names.
