import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { WorkerOptions } from "node:worker_threads";
import type {
  AppWorkflowWorkerHandle,
  RunSupervisedAppWorkflowOptions,
} from "./app-workflow-worker-supervisor.ts";
import { runSupervisedAppWorkflow } from "./app-workflow-worker-supervisor.ts";
import type { AppWorkflowWorkerInboundFrame } from "./app-workflow-worker-protocol.ts";

const base: Omit<RunSupervisedAppWorkflowOptions, "workerPath" | "workerFactory"> = {
  runId: "supervised-run-1",
  workflowId: "fixture-protocol",
  input: { credential: "secret-test-value" },
  browserConnection: { endpoint: "http://127.0.0.1:9222", targetId: "fixture-target" },
  signal: new AbortController().signal,
  appendEvent: async () => undefined,
  requestHumanAssistance: async () => "verified" as const,
  cancelGraceMs: 15,
  terminalGraceMs: 15,
};

class FakeDataStream extends EventEmitter {
  resumed = false;
  resume() { this.resumed = true; return this; }
}

class FakeWorker extends EventEmitter implements AppWorkflowWorkerHandle {
  readonly sent: AppWorkflowWorkerInboundFrame[] = [];
  terminated = false;
  readonly stdout = new FakeDataStream();
  readonly stderr = new FakeDataStream();
  readonly workerData: WorkerOptions["workerData"];
  constructor(workerData: WorkerOptions["workerData"]) {
    super();
    this.workerData = workerData;
  }
  postMessage(frame: AppWorkflowWorkerInboundFrame) { this.sent.push(frame); }
  terminate() {
    this.terminated = true;
    this.emit("exit", 1);
    return Promise.resolve(1);
  }
  send(value: unknown) { this.emit("message", value); }
  online() { this.emit("online"); }
  exit(code = 0) { this.emit("exit", code); }
}

function harness(overrides: Partial<typeof base> = {}) {
  let worker: FakeWorker | undefined;
  const run = runSupervisedAppWorkflow({
    ...base,
    ...overrides,
    workerFactory: (_path, options) => {
      worker = new FakeWorker(options.workerData);
      return worker;
    },
  });
  return { run, get worker() { return worker!; } };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("worker events are ACKed only after operational event persistence settles", async () => {
  let release!: () => void;
  let persisted = false;
  const persistence = new Promise<void>((resolve) => { release = resolve; });
  const task = harness({ appendEvent: async () => { await persistence; persisted = true; } });
  task.worker.send({
    protocolVersion: 1,
    kind: "event",
    eventId: "event-1",
    event: {
      runId: base.runId,
      stage: "collection",
      code: "fixture-started",
      occurredAt: "2026-09-26T00:00:00.000Z",
    },
  });
  await tick();
  assert.equal(task.worker.sent.some((frame) => frame.kind === "event-ack"), false);
  release();
  await tick();
  assert.equal(persisted, true);
  assert.deepEqual(task.worker.sent.at(-1), {
    protocolVersion: 1,
    kind: "event-ack",
    eventId: "event-1",
    ok: true,
  });
  task.worker.send({ protocolVersion: 1, kind: "completed", taskRunId: base.runId, summary: { counts: { count: 1 } } });
  task.worker.exit(0);
  assert.deepEqual(await task.run, { status: "completed", errorCode: null, summary: { counts: { count: 1 } } });
  assert.equal(task.worker.stdout.resumed, true);
  assert.equal(task.worker.stderr.resumed, true);
  assert.equal(task.worker.stdout.listenerCount("data"), 0);
  assert.equal(task.worker.stderr.listenerCount("data"), 0);
  for (const event of ["online", "message", "error", "exit"]) {
    assert.equal(task.worker.listenerCount(event), 0, `listener ${event} is removed`);
  }
});

test("human assistance requests return the App's completion status to the worker", async () => {
  const task = harness({ requestHumanAssistance: async (contract) => {
    assert.equal(contract.stageId, "verification");
    return "entered";
  } });
  task.worker.send({
    protocolVersion: 1,
    kind: "human-assistance-request",
    requestId: "assist-1",
    contract: {
      stageId: "verification",
      title: "Complete verification",
      targets: [{ id: "answer", label: "Answer", semanticId: "verification-answer", modes: ["type"] }],
      contextRegions: [],
      completion: { mode: "inline", targetIds: ["answer"] },
      focus: { targetId: "answer", contextRegionIds: [] },
    },
  });
  await tick();
  assert.deepEqual(task.worker.sent.at(-1), {
    protocolVersion: 1,
    kind: "human-assistance-response",
    requestId: "assist-1",
    status: "entered",
  });
  task.worker.send({ protocolVersion: 1, kind: "cancelled", taskRunId: base.runId });
  task.worker.exit(0);
  assert.equal((await task.run).status, "cancelled");
});

test("abort sends cancel and force-terminates a worker after the grace period", async () => {
  const controller = new AbortController();
  const task = harness({ signal: controller.signal, cancelGraceMs: 5 });
  controller.abort();
  const outcome = await task.run;
  assert.equal(task.worker.sent.some((frame) => frame.kind === "cancel"), true);
  assert.equal(task.worker.terminated, true);
  assert.deepEqual(outcome, { status: "cancelled", errorCode: "cancelled", summary: null });
});

test("unexpected worker errors and exits become a sanitized failure", async () => {
  const task = harness();
  task.worker.online();
  task.worker.emit("error", new Error("account number 12345 secret provider response"));
  task.worker.exit(1);
  const outcome = await task.run;
  assert.deepEqual(outcome, {
    status: "failed",
    errorCode: "workflow-failed",
    summary: null,
    failureKind: "worker-crash",
  });
  assert.equal(JSON.stringify(outcome).includes("12345"), false);
  assert.equal(JSON.stringify(outcome).includes("secret provider response"), false);
});

test("an unexpected exit after startup is classified without leaking worker state", async () => {
  const task = harness();
  task.worker.online();
  task.worker.exit(0);
  assert.deepEqual(await task.run, {
    status: "failed",
    errorCode: "workflow-failed",
    summary: null,
    failureKind: "unexpected-exit",
  });
});

test("invalid outbound frames are rejected, cancelled, and force-terminated", async () => {
  const task = harness({ cancelGraceMs: 5 });
  task.worker.send({ protocolVersion: 1, kind: "raw-provider-response", response: "must-not-escape" });
  const outcome = await task.run;
  assert.deepEqual(outcome, {
    status: "failed",
    errorCode: "protocol-invalid",
    summary: null,
    failureKind: "protocol",
  });
  assert.equal(task.worker.sent.some((frame) => frame.kind === "cancel"), true);
  assert.equal(task.worker.terminated, true);
  assert.equal(JSON.stringify(outcome).includes("must-not-escape"), false);
});

test("worker creation failure returns only its stable code", async () => {
  const outcome = await runSupervisedAppWorkflow({
    ...base,
    workerFactory: () => { throw new Error("secret worker startup detail"); },
  });
  assert.deepEqual(outcome, {
    status: "failed",
    errorCode: "worker-start-failed",
    summary: null,
    failureKind: "worker-start",
  });
  assert.equal(JSON.stringify(outcome).includes("secret worker startup detail"), false);
});
