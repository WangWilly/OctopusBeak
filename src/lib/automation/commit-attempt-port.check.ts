import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PGliteWorkflowRunItem,
  PGliteWorkflowRunResult,
} from "../../ledger/pglite/workflow-run.ts";
import {
  CommitOutcomeUnknownError,
  recordedFinancialCommitPort,
  type CommitAttemptReport,
} from "./commit-attempt.ts";

const items: readonly PGliteWorkflowRunItem[] = [1, 2].map((index) => ({
  provider: "fixture",
  product: "deposit",
  itemKey: `item-${index}`,
  command: { kind: "fixture", request: {} } as never,
}));

function committed(item: PGliteWorkflowRunItem) {
  return {
    itemKey: item.itemKey,
    provider: item.provider,
    product: item.product,
    status: "committed" as const,
    admissionSummaries: [],
    value: null,
    relationWarnings: [],
  };
}

function failed(item: PGliteWorkflowRunItem, failureKind: "item" | "fatal") {
  return {
    itemKey: item.itemKey,
    provider: item.provider,
    product: item.product,
    status: "failed" as const,
    failureKind,
    diagnostics: [],
  };
}

function result(
  status: PGliteWorkflowRunResult<unknown>["status"],
  results: PGliteWorkflowRunResult<unknown>["items"],
  diagnostics: PGliteWorkflowRunResult<unknown>["diagnostics"] = [],
): PGliteWorkflowRunResult<unknown> {
  const committedCount = results.filter((item) => item.status === "committed").length;
  return { status, items: results, diagnostics, committedCount, failedCount: results.length - committedCount };
}

function harness(execute: () => Promise<PGliteWorkflowRunResult<unknown>>) {
  const reports: CommitAttemptReport[] = [];
  const events: string[] = [];
  const port = recordedFinancialCommitPort({
    commit: { execute },
    attempts: { record: async (report) => { reports.push(report); } },
    event: async (code, counts, product) => { events.push(`${code}:${counts.completed}/${counts.total}:${product}`); },
    newAttemptId: () => "attempt-1",
  });
  return { port, reports, events };
}

const started = { phase: "started", attemptId: "attempt-1", product: "deposit", total: 2 } as const;

test("a completed result settles the attempt as completed", async () => {
  const { port, reports, events } = harness(async () => result("completed", items.map(committed)));
  assert.equal((await port.execute(items, { product: "deposit" })).status, "completed");
  assert.deepEqual(reports, [started, { phase: "settled", attemptId: "attempt-1", outcome: "completed", committedCount: 2 }]);
  assert.deepEqual(events, [
    "canonical-commit-started:0/2:deposit",
    "canonical-commit-completed:2/2:deposit",
  ]);
});

test("a returned item failure is a known failed outcome", async () => {
  const { port, reports, events } = harness(async () =>
    result("partially-completed", [committed(items[0]!), failed(items[1]!, "item")]));
  assert.equal((await port.execute(items, { product: "deposit" })).status, "partially-completed");
  assert.deepEqual(reports.at(-1), { phase: "settled", attemptId: "attempt-1", outcome: "failed", committedCount: 1 });
  assert.equal(events.at(-1), "canonical-commit-failed:1/2:deposit");
});

test("a cancelled result is a known outcome that keeps its committed receipts", async () => {
  const { port, reports } = harness(async () => result("cancelled", [committed(items[0]!)], [
    { stage: "cancellation", errorCode: "cancelled", message: "cancelled", provider: "fixture", product: "deposit", itemKey: "item-2" },
  ]));
  await port.execute(items, { product: "deposit" });
  assert.deepEqual(reports.at(-1), { phase: "settled", attemptId: "attempt-1", outcome: "cancelled", committedCount: 1 });
});

test("a thrown request leaves the attempt unsettled", async () => {
  const { port, reports } = harness(async () => { throw new Error("worker transport closed"); });
  await assert.rejects(port.execute(items, { product: "deposit" }), CommitOutcomeUnknownError);
  assert.deepEqual(reports, [started]);
});

test("receipts that do not answer their items leave the attempt unsettled", async () => {
  for (const untrusted of [
    result("completed", [committed(items[1]!), committed(items[0]!)]),
    result("completed", [committed(items[0]!)]),
    result("failed", [committed(items[0]!), failed(items[1]!, "fatal")]),
    result("failed", items.map(committed), [
      { stage: "run", errorCode: "invalid-receipt", message: "invalid", provider: "fixture", product: "deposit", itemKey: "item-2" },
    ]),
    { ...result("completed", items.map(committed)), committedCount: 1 },
  ]) {
    const { port, reports } = harness(async () => untrusted);
    await assert.rejects(port.execute(items, { product: "deposit" }), CommitOutcomeUnknownError);
    assert.deepEqual(reports, [started]);
  }
});

test("an unknown outcome still reports the receipts that answer their own items", async () => {
  const { port } = harness(async () => result("failed", [committed(items[0]!), failed(items[1]!, "fatal")]));
  await assert.rejects(port.execute(items), (error: unknown) =>
    error instanceof CommitOutcomeUnknownError && error.committedCount === 1);
  const misordered = harness(async () => result("completed", [committed(items[1]!), committed(items[0]!)]));
  await assert.rejects(misordered.port.execute(items), (error: unknown) =>
    error instanceof CommitOutcomeUnknownError && error.committedCount === 0);
});

test("an unrecorded start never reaches the canonical worker", async () => {
  let commits = 0;
  const port = recordedFinancialCommitPort({
    commit: { execute: async () => { commits += 1; return result("completed", items.map(committed)); } },
    attempts: { record: async () => { throw new Error("event-persistence-failed"); } },
    event: async () => undefined,
  });
  await assert.rejects(port.execute(items), /event-persistence-failed/u);
  assert.equal(commits, 0);
});

test("an unrecorded settlement does not turn a completed commit into a failure", async () => {
  const reports: CommitAttemptReport[] = [];
  const port = recordedFinancialCommitPort({
    commit: { execute: async () => result("completed", items.map(committed)) },
    attempts: {
      record: async (report) => {
        if (report.phase === "settled") throw new Error("event-persistence-failed");
        reports.push(report);
      },
    },
    event: async () => undefined,
  });
  assert.equal((await port.execute(items)).status, "completed");
  assert.equal(reports.length, 1);
});
