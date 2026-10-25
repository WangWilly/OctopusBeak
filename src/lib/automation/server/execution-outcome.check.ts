import assert from "node:assert/strict";
import test from "node:test";
import { reportExecution, type ExecutionEnding } from "./execution-outcome.ts";
import type { AppWorkflowWorkerOutcome } from "./app-workflow-worker-supervisor.ts";
import { signalRunEvent, type RunEventOutcome, type WorkflowRunEvent } from "../run-event.ts";
import { ProductCollectionInterruptedError } from "../product-collection.ts";
import { SourceUnavailableError } from "../source-access.ts";
import type { WorkflowRunResult } from "../workflow-run-result.ts";

const at = { runId: "run-1", occurredAt: "2026-10-24T12:00:00.000Z" };
const event = (stage: WorkflowRunEvent["stage"], outcome: RunEventOutcome): WorkflowRunEvent => ({
  ...at, stage, outcome, code: `${stage}-${outcome}`,
});
const authenticationFailed = [event("authentication", "started"), event("authentication", "failed")];
const assistanceFailed = (
  ...signals: ReadonlyArray<"solver-route-unavailable" | "solver-challenge-unsupported">
): WorkflowRunEvent[] => [
  event("authentication", "started"),
  ...signals.map((signal) => signalRunEvent(signal, at)),
  signalRunEvent("human-assistance-failed", at),
];

const failedProduct: WorkflowRunResult = {
  status: "failed",
  counts: {},
  products: [{ typeId: "deposit", status: "failed", itemCount: 0, committedCount: 0, errorCode: "workflow-failed" }],
};

function workerFailed(
  errorCode: Extract<AppWorkflowWorkerOutcome, { status: "failed" }>["errorCode"],
  summary: WorkflowRunResult | null = null,
): ExecutionEnding {
  return { kind: "worker", outcome: { status: "failed", errorCode, summary, failureKind: "workflow" } };
}

test("a worker's ending becomes a report whose failure is proven only by explicit evidence", () => {
  const cases: ReadonlyArray<Readonly<{
    name: string;
    ending: ExecutionEnding;
    events: readonly WorkflowRunEvent[];
    failure: ReturnType<typeof reportExecution>["failure"];
  }>> = [
    {
      name: "completed",
      ending: { kind: "worker", outcome: { status: "completed", errorCode: null, summary: null } },
      events: authenticationFailed,
      failure: null,
    },
    {
      name: "a specific worker code is proven",
      ending: workerFailed("source-unavailable"),
      events: authenticationFailed,
      failure: { code: "source-unavailable", proven: true },
    },
    {
      name: "workflow-failed confirmed by a failed product is proven",
      ending: workerFailed("workflow-failed", failedProduct),
      events: authenticationFailed,
      failure: { code: "workflow-failed", proven: true },
    },
    {
      name: "unconfirmed workflow-failed is classified from events",
      ending: workerFailed("workflow-failed"),
      events: authenticationFailed,
      failure: { code: "authentication-failed", proven: false },
    },
    {
      name: "a worker cannot claim commit outcome unknown",
      ending: workerFailed("commit-outcome-unknown"),
      events: [event("collection", "failed")],
      failure: { code: "source-collection-failed", proven: false },
    },
    {
      name: "a worker start failure is classified from events",
      ending: workerFailed("worker-start-failed"),
      events: [],
      failure: { code: "workflow-failed", proven: false },
    },
    {
      name: "a worker cancellation is classified, not proven",
      ending: { kind: "worker", outcome: { status: "cancelled", errorCode: "cancelled", summary: null } },
      events: authenticationFailed,
      failure: { code: "cancelled", proven: false },
    },
    {
      name: "the host's missing solver route outranks the worker's verification code",
      ending: workerFailed("verification-failed"),
      events: assistanceFailed("solver-route-unavailable"),
      failure: { code: "verification-configuration-failed", proven: true },
    },
    {
      name: "the host's unsupported challenge outranks the worker's verification code",
      ending: workerFailed("verification-failed"),
      events: assistanceFailed("solver-challenge-unsupported"),
      failure: { code: "verification-configuration-failed", proven: true },
    },
    {
      name: "without a route signal the worker's verification code stands",
      ending: workerFailed("verification-failed"),
      events: assistanceFailed(),
      failure: { code: "verification-failed", proven: true },
    },
    {
      name: "a worker cancellation keeps its classification over a route signal",
      ending: { kind: "worker", outcome: { status: "cancelled", errorCode: "cancelled", summary: null } },
      events: assistanceFailed("solver-route-unavailable"),
      failure: { code: "cancelled", proven: false },
    },
    {
      name: "events signal an exhausted solver",
      ending: workerFailed("protocol-invalid"),
      events: [signalRunEvent("verification-solver-exhausted", at)],
      failure: { code: "verification-failed", proven: false },
    },
  ];
  for (const { name, ending, events, failure } of cases) {
    assert.deepEqual(reportExecution(ending, events).failure, failure, name);
  }
});

test("a worker's summary is reported unchanged", () => {
  const report = reportExecution(workerFailed("workflow-failed", failedProduct), []);
  assert.equal(report.summary, failedProduct);
});

test("a host error is classified from the error and events, never proven", () => {
  assert.deepEqual(reportExecution({
    kind: "host-error",
    error: new SourceUnavailableError(),
    cancelled: false,
    workerSummary: null,
  }, []), { summary: null, failure: { code: "source-unavailable", proven: false } });

  assert.deepEqual(reportExecution({
    kind: "host-error",
    error: new Error("private provider text"),
    cancelled: true,
    workerSummary: null,
  }, authenticationFailed).failure, { code: "cancelled", proven: false });

  assert.deepEqual(reportExecution({
    kind: "host-error",
    error: new Error("private provider text"),
    cancelled: false,
    workerSummary: failedProduct,
  }, authenticationFailed), {
    summary: failedProduct,
    failure: { code: "authentication-failed", proven: false },
  });
});

test("an interrupted product collection keeps its committed products over the worker's summary", () => {
  const products = [{ typeId: "deposit" as const, status: "success" as const, itemCount: 2, committedCount: 2 }];
  const report = reportExecution({
    kind: "host-error",
    error: new ProductCollectionInterruptedError("source-unavailable", {
      status: "partial",
      sourceCaptureCount: 1,
      rowCount: 2,
      itemCount: 2,
      committedCount: 2,
      products,
    }),
    cancelled: false,
    workerSummary: failedProduct,
  }, []);
  assert.deepEqual(report.summary?.products, products);
  assert.deepEqual(report.failure, { code: "source-unavailable", proven: false });
});
