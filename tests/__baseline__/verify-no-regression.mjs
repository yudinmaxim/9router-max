// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));

// Report paths are absolute. known-fails.txt is keyed relative to the repo's
// tests/ dir ("tests/unit/foo.test.js :: name"), so cut at the last "tests/"
// segment. The previous split("/app/")[1] only ever matched Docker-style
// paths and yielded undefined for every local run, so nothing was ever
// compared against the baseline.
function relTestPath(abs) {
  const i = abs.lastIndexOf("tests/");
  return i === -1 ? abs : abs.slice(i);
}

const nowFails = r.testResults.flatMap(f => {
  const file = relTestPath(f.name);
  const failed = f.assertionResults
    .filter(a => a.status === "failed")
    .map(a => file + " :: " + a.fullName);
  // A suite that fails to import produces no assertions at all, so it would
  // slip past the assertion filter above. Surface it as a file-level entry.
  if (failed.length === 0 && f.status === "failed") {
    failed.push(file + " :: <suite failed to collect>");
  }
  return failed;
});

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
