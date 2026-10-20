import assert from "node:assert/strict";
import test from "node:test";
import {
  decideAutomationTaskRunOutcome,
  type TaskRunStop,
} from "./task-run-finalization.ts";
import type { TypedWorkflowOutcome, TypedWorkflowOutcomeSummary } from "./typed-workflow-outcome.ts";

const complete = { status: "completed", counts: {} } as const;
const partial = {
  status: "partial",
  counts: { committedCount: 1, itemCount: 1 },
  products: [{ typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 }],
} as const;
const incomplete: TypedWorkflowOutcomeSummary = {
  status: "partial",
  counts: { committedCount: 1, itemCount: 1, excludedUnknownInstitutionCount: 1 },
  products: [{
    typeId: "settlement", status: "success", itemCount: 1, committedCount: 1,
    collection: { status: "incomplete", exclusionCounts: { excludedUnknownInstitutionCount: 1 } },
  }],
};

function decided(report: TypedWorkflowOutcome, stop: TaskRunStop | null = null) {
  const { status, errorCode, forced } = decideAutomationTaskRunOutcome(report, stop);
  return { status, errorCode, forced };
}

const scenarios: Array<{
  name: string;
  report: TypedWorkflowOutcome;
  expected: { status: string; errorCode: string | null };
}> = [
  {
    name: "a success report without a summary",
    report: { errorCode: null, summary: null },
    expected: { status: "completed", errorCode: null },
  },
  {
    name: "successful typed summary",
    report: { errorCode: null, summary: complete },
    expected: { status: "completed", errorCode: null },
  },
  {
    name: "typed failure overrides a completed summary",
    report: { errorCode: "source-integrity-failed", summary: complete },
    expected: { status: "failed", errorCode: "source-integrity-failed" },
  },
  {
    name: "failed summary without a code retains its null code",
    report: { errorCode: null, summary: { status: "failed", counts: {} } },
    expected: { status: "failed", errorCode: null },
  },
  {
    name: "partial summary without a fatal code",
    report: { errorCode: null, summary: partial },
    expected: { status: "partial", errorCode: null },
  },
  {
    name: "non-TDCC partial summary cannot mask a typed fatal error",
    report: { errorCode: "source-unavailable", summary: partial },
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "TDCC incomplete collection with durable receipts retains the interruption code",
    report: { errorCode: "source-unavailable", summary: incomplete },
    expected: { status: "partial", errorCode: "source-unavailable" },
  },
  {
    name: "TDCC durable receipts preserve partial even when the interrupted summary says failed",
    report: { errorCode: "source-unavailable", summary: { ...incomplete, status: "failed" } },
    expected: { status: "partial", errorCode: "source-unavailable" },
  },
  {
    name: "TDCC incomplete collection without receipts cannot override failure",
    report: { errorCode: "source-unavailable", summary: {
      ...incomplete, status: "failed", counts: { committedCount: 0 },
      products: incomplete.products!.map((product) => ({ ...product, committedCount: 0 })),
    } },
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "inconsistent TDCC receipt counts cannot override failure",
    report: { errorCode: "source-unavailable", summary: { ...incomplete, counts: { committedCount: 2 } } },
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "summary-less unknown commit",
    report: { errorCode: "commit-outcome-unknown", summary: null },
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "unknown commit overrides TDCC durable earlier receipts",
    report: { errorCode: "commit-outcome-unknown", summary: incomplete },
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "a workflow-reported cancellation overrides TDCC durable receipts",
    report: { errorCode: "cancelled", summary: incomplete },
    expected: { status: "cancelled", errorCode: "cancelled" },
  },
];

for (const scenario of scenarios) {
  test(scenario.name, () => {
    assert.deepEqual(decided(scenario.report), { ...scenario.expected, forced: false });
  });
}

const stops: Array<{
  stop: TaskRunStop;
  expected: { status: string; errorCode: string; forced: boolean };
}> = [
  { stop: "forced", expected: { status: "cancelled", errorCode: "cancelled", forced: true } },
  { stop: "cancelled", expected: { status: "cancelled", errorCode: "cancelled", forced: false } },
  { stop: "shutdown", expected: { status: "interrupted", errorCode: "cancelled", forced: false } },
];

for (const { stop, expected } of stops) {
  for (const report of [
    { errorCode: null, summary: complete },
    { errorCode: "source-unavailable", summary: incomplete },
    { errorCode: "workflow-failed", summary: null },
    { errorCode: "cancelled", summary: null },
  ] satisfies TypedWorkflowOutcome[]) {
    test(`a ${stop} stop outranks a ${report.errorCode ?? "success"} report`, () => {
      assert.deepEqual(decided(report, stop), expected);
    });
  }

  for (const summary of [null, incomplete]) {
    test(`unknown commit outranks a ${stop} stop, ${summary ? "with" : "without"} earlier receipts`, () => {
      assert.deepEqual(
        decided({ errorCode: "commit-outcome-unknown", summary }, stop),
        { status: "failed", errorCode: "commit-outcome-unknown", forced: false },
      );
    });
  }
}

test("the decision keeps the reported summary", () => {
  assert.equal(decideAutomationTaskRunOutcome({ errorCode: null, summary: partial }, "cancelled").summary, partial);
});
