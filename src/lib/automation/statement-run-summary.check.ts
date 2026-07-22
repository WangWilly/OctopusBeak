import assert from "node:assert/strict";
import {
  aggregateStatementResults,
  parseStatementRunSummary,
  statementRunSummaryLine,
} from "./statement-run-summary.ts";

const results = [
  { typeId: "deposit", status: "success" as const },
  { typeId: "loan", status: "failed" as const, error: "no account" },
  { typeId: "fund", status: "skipped" as const },
];

assert.equal(aggregateStatementResults(results), "partial");
assert.deepEqual(parseStatementRunSummary(`noise\n${statementRunSummaryLine(results)}\n`), {
  status: "partial",
  results,
});
assert.equal(
  aggregateStatementResults([{ typeId: "loan", status: "failed", error: "x" }]),
  "failed",
);
assert.equal(
  aggregateStatementResults([{ typeId: "deposit", status: "success" }]),
  "completed",
);
assert.equal(parseStatementRunSummary("automation-statement-summary: not-json"), null);
assert.equal(parseStatementRunSummary("ordinary workflow output"), null);
