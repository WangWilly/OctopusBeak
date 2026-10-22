import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { WorkerOptions } from "node:worker_threads";
import type {
  AppWorkflowWorkerHandle,
  RunSupervisedAppWorkflowOptions,
} from "./app-workflow-worker-supervisor.ts";
import { runSupervisedAppWorkflow } from "./app-workflow-worker-supervisor.ts";
import {
  APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
  type AppWorkflowWorkerInboundFrame,
} from "./app-workflow-worker-protocol.ts";

const base: Omit<RunSupervisedAppWorkflowOptions, "workerPath" | "workerFactory"> = {
  runId: "supervised-run-1",
  workflowId: "fixture-protocol",
  input: { credential: "secret-test-value" },
  browserConnection: { endpoint: "http://127.0.0.1:9222", targetId: "fixture-target" },
  signal: new AbortController().signal,
  appendEvent: async () => undefined,
  recordCommitAttempt: async () => undefined,
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
    protocolVersion: 2,
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
    protocolVersion: 2,
    kind: "event-ack",
    eventId: "event-1",
    ok: true,
  });
  task.worker.send({ protocolVersion: 2, kind: "completed", taskRunId: base.runId, summary: { counts: { count: 1 } } });
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
    protocolVersion: 2,
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
    protocolVersion: 2,
    kind: "human-assistance-response",
    requestId: "assist-1",
    status: "entered",
  });
  task.worker.send({ protocolVersion: 2, kind: "cancelled", taskRunId: base.runId });
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

test("worker cancellation summary preserves receipts after host cancellation was requested", async () => {
  const controller = new AbortController();
  const task = harness({ signal: controller.signal, cancelGraceMs: 50 });
  task.worker.online();
  controller.abort();
  await tick();
  assert.equal(task.worker.sent.some((frame) => frame.kind === "cancel"), true);
  task.worker.send({
    protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
    kind: "cancelled",
    taskRunId: base.runId,
    summary: {
      status: "completed",
      counts: { itemCount: 1, committedCount: 1 },
      products: [{ typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 }],
    },
  });
  task.worker.exit(0);
  assert.deepEqual(await task.run, {
    status: "cancelled",
    errorCode: "cancelled",
    summary: {
      status: "completed",
      counts: { itemCount: 1, committedCount: 1 },
      products: [{ typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 }],
    },
  });
});

test("unexpected worker errors and exits become a sanitized failure", async () => {
  const task = harness();
  task.worker.online();
  task.worker.emit("error", new Error("account number 12345 secret provider response"));
  task.worker.exit(1);
  const outcome = await task.run;
  assert.equal(outcome.status, "failed");
  if (outcome.status !== "failed") return;
  assert.equal(outcome.errorCode, "workflow-failed");
  assert.equal(outcome.summary, null);
  assert.equal(outcome.failureKind, "worker-crash");
  assert.deepEqual(outcome.diagnostic?.chain.map(({ type }) => type), ["Error"]);
  const frames = outcome.diagnostic?.chain.flatMap(({ frames: captured }) => captured) ?? [];
  assert.equal(
    frames.some(({ file }) => file === "src/lib/automation/server/app-workflow-worker-supervisor.check.ts"),
    true,
    "the worker error location survives as a repository-relative frame",
  );
  assert.ok(frames.every((frame) => Object.keys(frame).sort().join(",") === "column,file,line"));
  const serialized = JSON.stringify(outcome);
  assert.equal(serialized.includes("12345"), false);
  assert.equal(serialized.includes("secret provider response"), false);
  assert.equal(serialized.includes("account number"), false);
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
  task.worker.send({ protocolVersion: 2, kind: "raw-provider-response", response: "must-not-escape" });
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

function fakeTdccSessionHost() {
  const saved: unknown[] = [];
  const calls: string[] = [];
  const host = {
    open() {
      calls.push("open");
      return {
        status: "ready" as const,
        connection: { sourceConnectionKey: `sha256:${"a".repeat(43)}` as const, identityEpochKey: `sha256:${"b".repeat(43)}` as const },
        device: { deviceId: "0123456789abcdef", devType: "Android:14", devModel: "SM-G991B" },
        session: { tokenId: "saved-token", richUrl: null, issuedAt: "2026-10-01T00:00:00.000Z" },
      };
    },
    signInDetails() {
      calls.push("sign-in-details");
      return { status: "ready" as const, details: { userId: "fixture-user", password: "fixture-password" } };
    },
    saveSession(session: unknown) { saved.push(session); },
  };
  return { host, saved, calls };
}

const tdccRequestId = "6f1c2a8e-0b7d-4c3e-9a1f-2d4b6c8e0a1b";
const rotated = (tokenId: string) => ({
  protocolVersion: 2,
  kind: "tdcc-session-rotated",
  session: { tokenId, richUrl: null, issuedAt: "2026-10-09T00:00:00.000Z" },
});

test("TDCC session requests are answered only by the host port of a TDCC run", async () => {
  const tdcc = fakeTdccSessionHost();
  const task = harness({ tdccSession: tdcc.host });
  task.worker.send({ protocolVersion: 2, kind: "tdcc-session-request", requestId: tdccRequestId, operation: "open" });
  const openResponse = task.worker.sent.at(-1) as unknown as { lease: { status: string } };
  assert.equal(openResponse.lease.status, "ready");
  assert.equal(JSON.stringify(openResponse).includes("fixture-password"), false, "opening a session never sends the password");
  task.worker.send({ protocolVersion: 2, kind: "tdcc-session-request", requestId: "7f1c2a8e-0b7d-4c3e-9a1f-2d4b6c8e0a1b", operation: "sign-in-details" });
  assert.deepEqual((task.worker.sent.at(-1) as unknown as { lease: unknown }).lease, {
    status: "ready",
    details: { userId: "fixture-user", password: "fixture-password" },
  });
  assert.deepEqual(tdcc.calls, ["open", "sign-in-details"]);
  task.worker.send({ protocolVersion: 2, kind: "completed", taskRunId: base.runId, summary: null });
  task.worker.exit(0);
  assert.equal((await task.run).status, "completed");

  const leaked = harness({ tdccSession: {
    ...tdcc.host,
    open: () => ({ ...tdcc.host.open(), password: "fixture-password" }),
  } });
  leaked.worker.send({ protocolVersion: 2, kind: "tdcc-session-request", requestId: tdccRequestId, operation: "open" });
  assert.equal(leaked.worker.sent.some((frame) => frame.kind === "tdcc-session-response"), false, "a lease carrying a password is never sent");
  assert.equal((await leaked.run).errorCode, "protocol-invalid");

  const other = harness();
  other.worker.send({ protocolVersion: 2, kind: "tdcc-session-request", requestId: tdccRequestId, operation: "open" });
  const outcome = await other.run;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorCode, "protocol-invalid");
});

test("the newest rotated TDCC session is saved even when the worker fails or exits right after", async () => {
  const failedRun = fakeTdccSessionHost();
  const failing = harness({ tdccSession: failedRun.host });
  failing.worker.send(rotated("token-1"));
  failing.worker.send(rotated("token-2"));
  failing.worker.send({ protocolVersion: 2, kind: "failed", taskRunId: base.runId, errorCode: "source-collection-failed" });
  failing.worker.exit(1);
  assert.equal((await failing.run).status, "failed");
  assert.deepEqual(failedRun.saved.map((session) => (session as { tokenId: string }).tokenId), ["token-2"]);

  const cancelledRun = fakeTdccSessionHost();
  const controller = new AbortController();
  const cancelling = harness({ tdccSession: cancelledRun.host, signal: controller.signal });
  controller.abort();
  cancelling.worker.send(rotated("token-after-cancel"));
  cancelling.worker.send({ protocolVersion: 2, kind: "cancelled", taskRunId: base.runId });
  cancelling.worker.exit(0);
  assert.equal((await cancelling.run).status, "cancelled");
  assert.deepEqual(cancelledRun.saved.map((session) => (session as { tokenId: string }).tokenId), ["token-after-cancel"]);

  const crashedRun = fakeTdccSessionHost();
  const crashing = harness({ tdccSession: crashedRun.host });
  crashing.worker.online();
  crashing.worker.send(rotated("token-3"));
  crashing.worker.exit(1);
  assert.equal((await crashing.run).status, "failed");
  assert.deepEqual(crashedRun.saved.map((session) => (session as { tokenId: string }).tokenId), ["token-3"]);
});
