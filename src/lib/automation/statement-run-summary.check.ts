import assert from "node:assert/strict";
import {
  aggregateStatementResults,
  parseStatementRunSummary,
  STATEMENT_RUN_SUMMARY_PREFIX,
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

const completedLine = statementRunSummaryLine([{ typeId: "deposit", status: "success" }]);
assert.deepEqual(
  parseStatementRunSummary(`${completedLine}\n${STATEMENT_RUN_SUMMARY_PREFIX}not-json`),
  { status: "completed", results: [{ typeId: "deposit", status: "success" }] },
);

const summaryLine = (value: unknown) => STATEMENT_RUN_SUMMARY_PREFIX + JSON.stringify(value);
assert.equal(parseStatementRunSummary(summaryLine({ status: "failed", results: [null] })), null);
assert.equal(
  parseStatementRunSummary(summaryLine({ status: "failed", results: [{ status: "failed" }] })),
  null,
);
assert.equal(
  parseStatementRunSummary(summaryLine({
    status: "failed",
    results: [{ typeId: "  ", status: "failed" }],
  })),
  null,
);
assert.equal(
  parseStatementRunSummary(summaryLine({
    status: "failed",
    results: [{ typeId: "deposit", status: "unknown" }],
  })),
  null,
);
assert.equal(
  parseStatementRunSummary(summaryLine({
    status: "completed",
    results: [{ typeId: "loan", status: "failed", error: "no account" }],
  })),
  null,
);
assert.equal(
  parseStatementRunSummary(summaryLine({
    status: "completed",
    results: [{ typeId: "deposit", status: "success", fileCount: "1" }],
  })),
  null,
);
assert.equal(
  parseStatementRunSummary(summaryLine({
    status: "failed",
    results: [{ typeId: "loan", status: "failed", error: 42 }],
  })),
  null,
);
