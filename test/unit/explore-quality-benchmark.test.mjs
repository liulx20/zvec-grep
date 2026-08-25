import assert from "node:assert/strict";
import test from "node:test";
import { runLanguageQualityMatrix } from "../../benchmarks/explore-quality/language-matrix.mjs";
import { runExploreQualityBenchmark } from "../../benchmarks/explore-quality/run.mjs";

test("cross-language Explore quality benchmark stays green", () => {
  const report = runExploreQualityBenchmark();
  assert.equal(report.summary.cases, 6);
  assert.equal(report.summary.rootRecall, 1);
  assert.equal(report.summary.pathRecall, 1);
  assert.equal(report.summary.fileRecall, 1);
  assert.equal(report.summary.filePrecision, 1);
  assert.equal(report.summary.conceptCoverage, 1);
  assert.equal(report.summary.bodyCoverage, 1);
  assert.equal(report.summary.sourceCoverage, 1);
  assert.equal(report.summary.redundancy, 0);
});

test("every supported language and component wrapper meets its quality floor", async () => {
  const report = await runLanguageQualityMatrix();
  assert.deepEqual(Object.keys(report.languages).sort(), [
    "c",
    "cpp",
    "go",
    "java",
    "javascript",
    "jsx",
    "python",
    "rust",
    "svelte",
    "tsx",
    "typescript",
    "vue",
  ]);
  for (const [language, summary] of Object.entries(report.languages)) {
    const componentWrapper = language === "vue" || language === "svelte";
    assert.ok(
      summary.cases >= (componentWrapper ? 3 : 40),
      `${language} only has ${summary.cases} cases`,
    );
    assert.ok(
      report.cases.filter(
        (item) => item.language === language && item.multiFile,
      ).length >= (componentWrapper ? 2 : 5),
      `${language} lacks cross-file cases`,
    );
    assert.equal(
      summary.failed,
      0,
      `${language}:\n${report.cases
        .filter((item) => item.language === language && item.failures.length)
        .map((item) => `${item.id}: ${item.failures.join(", ")}`)
        .join("\n")}`,
    );
  }
  const minimumCapabilityCases = {
    deterministic: 350,
    dynamic: 40,
    negative: 45,
    multiFile: 70,
  };
  for (const [capability, minimum] of Object.entries(minimumCapabilityCases)) {
    const summary = report.capabilities[capability];
    assert.ok(
      summary.cases >= minimum,
      `${capability} only has ${summary.cases} labelled cases`,
    );
    assert.equal(summary.failed, 0, `${capability} capability regressed`);
  }
});
