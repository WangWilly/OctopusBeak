import assert from "node:assert/strict";
import { parseStatementRunSummary } from "../lib/automation/statement-run-summary.ts";
import { runSelectedStatements } from "./run-selected-statements.ts";

const calls: string[] = [];
const summaryLines: string[] = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (...args: unknown[]) => {
  if (
    typeof args[0] === "string" &&
    args[0].startsWith("automation-statement-summary: ")
  ) {
    summaryLines.push(args[0]);
  }
};
console.error = () => undefined;

const run = await runSelectedStatements(["deposit", "loan", "fund"], [
  {
    typeId: "deposit",
    run: async () => {
      calls.push("deposit");
      return { count: 2 };
    },
    fileCount: (value) => (value as { count: number }).count,
  },
  {
    typeId: "credit_card",
    run: async () => {
      calls.push("credit_card");
      return {};
    },
  },
  {
    typeId: "loan",
    prepare: async () => {
      calls.push("prepare-loan");
      throw new Error("loan navigation unavailable");
    },
    run: async () => {
      calls.push("loan");
      return {};
    },
  },
  {
    typeId: "fund",
    run: async () => {
      calls.push("fund");
      return { count: 1 };
    },
  },
]);

console.log = originalLog;
console.error = originalError;

assert.deepEqual(calls, ["deposit", "prepare-loan", "fund"]);
assert.deepEqual(run.results, [
  { typeId: "deposit", status: "success", fileCount: 2 },
  { typeId: "credit_card", status: "skipped" },
  {
    typeId: "loan",
    status: "failed",
    error: "loan navigation unavailable",
  },
  { typeId: "fund", status: "success" },
]);
assert.deepEqual(run.outputs.deposit, { count: 2 });
assert.deepEqual(run.outputs.fund, { count: 1 });
assert.equal(summaryLines.length, 1);
assert.deepEqual(parseStatementRunSummary(summaryLines[0]), {
  status: "partial",
  results: run.results,
});
