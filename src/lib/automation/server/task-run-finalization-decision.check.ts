import assert from "node:assert/strict";
import test from "node:test";
import {
  decideAutomationTaskRunOutcome,
  type AutomationTaskExecutionResult,
} from "./task-run-finalization.ts";
import type { TypedWorkflowOutcomeSummary } from "./typed-workflow-outcome.ts";

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

function result(overrides: Partial<AutomationTaskExecutionResult> = {}): AutomationTaskExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    error: null,
    appWorkflowOutcome: { errorCode: null, summary: null },
    outputPersistenceWarnings: [],
    externalPrerequisiteIds: [],
    ...overrides,
  };
}

type Decision = ReturnType<typeof decideAutomationTaskRunOutcome>;
const scenarios: Array<{
  name: string;
  input: Partial<AutomationTaskExecutionResult>;
  expected: Decision;
}> = [
  {
    name: "successful exit without a summary",
    input: {},
    expected: { status: "completed", errorCode: null },
  },
  {
    name: "successful typed summary",
    input: { appWorkflowOutcome: { errorCode: null, summary: complete } },
    expected: { status: "completed", errorCode: null },
  },
  {
    name: "nonzero exit overrides a completed summary",
    input: { exitCode: 1, appWorkflowOutcome: { errorCode: null, summary: complete } },
    expected: { status: "failed", errorCode: "workflow-failed" },
  },
  {
    name: "missing exit and outcome fail closed",
    input: { exitCode: null, appWorkflowOutcome: undefined },
    expected: { status: "failed", errorCode: "workflow-failed" },
  },
  {
    name: "untyped exception produces only a safe code",
    input: { error: new Error("untrusted provider detail") },
    expected: { status: "failed", errorCode: "workflow-failed" },
  },
  {
    name: "typed failure overrides a successful exit",
    input: { appWorkflowOutcome: { errorCode: "source-integrity-failed", summary: complete } },
    expected: { status: "failed", errorCode: "source-integrity-failed" },
  },
  {
    name: "failed summary without an exception retains its existing null code",
    input: { appWorkflowOutcome: { errorCode: null, summary: { status: "failed", counts: {} } } },
    expected: { status: "failed", errorCode: null },
  },
  {
    name: "partial summary survives a nonzero exit without a fatal error",
    input: { exitCode: 1, appWorkflowOutcome: { errorCode: null, summary: partial } },
    expected: { status: "partial", errorCode: null },
  },
  {
    name: "non-TDCC partial summary cannot mask a typed fatal error",
    input: { appWorkflowOutcome: { errorCode: "source-unavailable", summary: partial } },
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "non-TDCC partial summary cannot mask an untyped exception",
    input: { error: new Error("provider failure"), appWorkflowOutcome: { errorCode: null, summary: partial } },
    expected: { status: "failed", errorCode: "workflow-failed" },
  },
  {
    name: "TDCC incomplete collection with durable receipts retains the interruption code",
    input: { exitCode: 1, error: new Error("handled interruption"), appWorkflowOutcome: { errorCode: "source-unavailable", summary: incomplete } },
    expected: { status: "partial", errorCode: "source-unavailable" },
  },
  {
    name: "TDCC durable receipts preserve partial even when the interrupted summary says failed",
    input: { exitCode: 1, appWorkflowOutcome: { errorCode: "source-unavailable", summary: { ...incomplete, status: "failed" } } },
    expected: { status: "partial", errorCode: "source-unavailable" },
  },
  {
    name: "TDCC incomplete collection without receipts cannot override failure",
    input: { exitCode: 1, appWorkflowOutcome: { errorCode: "source-unavailable", summary: {
      ...incomplete, status: "failed", counts: { committedCount: 0 },
      products: incomplete.products!.map((product) => ({ ...product, committedCount: 0 })),
    } } },
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "inconsistent TDCC receipt counts cannot override failure",
    input: { exitCode: 1, appWorkflowOutcome: { errorCode: "source-unavailable", summary: {
      ...incomplete, counts: { committedCount: 2 },
    } } },
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "summary-less unknown commit overrides successful exit",
    input: { appWorkflowOutcome: { errorCode: "commit-outcome-unknown", summary: null } },
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "unknown commit overrides TDCC durable earlier receipts",
    input: { appWorkflowOutcome: { errorCode: "commit-outcome-unknown", summary: incomplete } },
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "typed cancellation overrides TDCC durable receipts",
    input: { appWorkflowOutcome: { errorCode: "cancelled", summary: incomplete } },
    expected: { status: "cancelled", errorCode: "cancelled" },
  },
];

for (const scenario of scenarios) {
  test(scenario.name, () => {
    assert.deepEqual(decideAutomationTaskRunOutcome(result(scenario.input)), scenario.expected);
  });
}

const cancellationSignals: Array<{
  name: string;
  input: Partial<AutomationTaskExecutionResult>;
  options?: { forceTerminated: boolean };
}> = [
  { name: "SIGTERM", input: { signal: "SIGTERM" } },
  { name: "force termination", input: {}, options: { forceTerminated: true } },
  { name: "host cancellation error", input: { error: new Error("Automation task cancelled.") } },
  { name: "combined cancellation evidence", input: { signal: "SIGTERM", error: new Error("Automation task cancelled.") }, options: { forceTerminated: true } },
];

for (const cancellation of cancellationSignals) {
  test(`${cancellation.name} normalizes both status and safe code`, () => {
    assert.deepEqual(decideAutomationTaskRunOutcome(result({
      ...cancellation.input,
      appWorkflowOutcome: { errorCode: "source-unavailable", summary: incomplete },
    }), cancellation.options), { status: "cancelled", errorCode: "cancelled" });
  });

  for (const summary of [null, incomplete]) {
    test(`unknown commit wins over ${cancellation.name}, ${summary ? "with" : "without"} earlier receipts`, () => {
      assert.deepEqual(decideAutomationTaskRunOutcome(result({
        ...cancellation.input,
        appWorkflowOutcome: { errorCode: "commit-outcome-unknown", summary },
      }), cancellation.options), { status: "failed", errorCode: "commit-outcome-unknown" });
    });
  }
}
