import { runLanguageQualityMatrix } from "./language-matrix.mjs";

const report = await runLanguageQualityMatrix();

console.log("Cross-language graph quality matrix");
for (const [language, summary] of Object.entries(report.languages)) {
  console.log(
    `${language.padEnd(10)} ${summary.passed}/${summary.cases} passed`,
  );
}
console.log(
  `overall    ${report.summary.passed}/${report.summary.cases} passed`,
);
console.log("capability coverage:");
for (const [capability, summary] of Object.entries(report.capabilities)) {
  console.log(
    `  ${capability.padEnd(13)} ${summary.passed}/${summary.cases} passed`,
  );
}

for (const item of report.cases) {
  for (const failure of item.failures) console.error(`${item.id}: ${failure}`);
}

if (report.summary.failed > 0) process.exitCode = 1;
