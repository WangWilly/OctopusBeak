import { SinopacCaptchaRejectedError } from "../sinopac-captcha.ts";
import { CathayAppVerificationError } from "../verification-errors.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { MessageChannel, Worker } from "node:worker_threads";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowDefinition, WorkflowFinancialCommitPort } from "../workflow-executor.ts";
import type { CathayGmailOtpPort } from "../../../workflows/cathay-statements.ts";
import type { PGliteWorkflowRunItem, PGliteWorkflowRunResult } from "../../../ledger/pglite/workflow-run.ts";
import {
  APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
  parseAppWorkflowWorkerInboundFrame,
  parseAppWorkflowWorkerOutboundFrame,
  parseAppWorkflowWorkerStart,
  type AppWorkflowWorkerOutboundFrame,
} from "./app-workflow-worker-protocol.ts";
import { runAppWorkflowWorker } from "./app-workflow-worker-runtime.ts";
import { createPGliteChildRpcServer } from "../../../../electron/pglite-child-rpc.ts";

const start = {
  protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
  workflowId: "fixture-protocol",
  taskRunId: "run-fixture-1",
  input: { credential: "sensitive-fixture" },
  browserConnection: {
    endpoint: "http://127.0.0.1:9222",
    targetId: "fixture-target",
  },
  pgliteRpc: { endpoint: "/tmp/octopusbeak-fixture.sock", token: "a".repeat(32) },
} as const;

const contract = {
  stageId: "fixture-verification",
  title: "Complete the fixture verification",
  targets: [{ id: "answer", label: "Answer", semanticId: "verification-answer", modes: ["type"] as const }],
  contextRegions: [],
  completion: { mode: "inline" as const, targetIds: ["answer"] },
  focus: { targetId: "answer", contextRegionIds: [] },
};

function runItem(): PGliteWorkflowRunItem {
  return {
    provider: "fixture",
    product: "fixture",
    itemKey: "fixture-item",
    command: { kind: "canonical.source.admit", request: {} },
  } as unknown as PGliteWorkflowRunItem;
}

function successfulCommit(): PGliteWorkflowRunResult<unknown> {
  return {
    status: "completed",
    items: [],
    diagnostics: [],
    committedCount: 1,
    failedCount: 0,
  };
}

test("worker protocol rejects malformed, oversized, and unexpected frames", () => {
  assert.equal(parseAppWorkflowWorkerStart(start).taskRunId, "run-fixture-1");
  assert.throws(
    () => parseAppWorkflowWorkerStart({ ...start, unexpected: "raw provider response" }),
    /protocol rejected/u,
  );
  assert.throws(
    () => parseAppWorkflowWorkerInboundFrame({ protocolVersion: 2, kind: "human-assistance-response", requestId: "x", status: "pending" }),
    /protocol rejected/u,
  );
  assert.throws(
    () => parseAppWorkflowWorkerOutboundFrame({ protocolVersion: 2, kind: "event", eventId: "e1", event: { runId: "run-fixture-1", stage: "collection", code: "valid-code", occurredAt: "2026-09-26T00:00:00.000Z", raw: "source bytes" } }),
    /protocol rejected/u,
  );
  const scopedProgressEvent = parseAppWorkflowWorkerOutboundFrame({
    protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
    kind: "event",
    eventId: "scoped-progress",
    event: {
      runId: "run-fixture-1",
      stage: "collection",
      code: "statement-download-started",
      occurredAt: "2026-10-04T00:00:00.000Z",
      statementType: "deposit",
      activity: "download",
      retrying: true,
    },
  });
  assert.equal(scopedProgressEvent.kind, "event");
  if (scopedProgressEvent.kind === "event") {
    assert.equal(scopedProgressEvent.event.statementType, "deposit");
    assert.equal(scopedProgressEvent.event.activity, "download");
    assert.equal(scopedProgressEvent.event.retrying, true);
  }
  for (const metadata of [
    { activity: { value: "download" } },
    { activity: "delete" },
    { statementType: "private-account-name" },
    { statementType: 42 },
    { retrying: "true" },
  ]) {
    assert.throws(() => parseAppWorkflowWorkerOutboundFrame({
      protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
      kind: "event",
      eventId: "invalid-progress",
      event: {
        runId: "run-fixture-1",
        stage: "collection",
        code: "statement-download-started",
        occurredAt: "2026-10-04T00:00:00.000Z",
        ...metadata,
      },
    }), /protocol rejected/u, "only bounded progress metadata crosses the worker boundary");
  }
  assert.throws(
    () => parseAppWorkflowWorkerStart({ ...start, input: { credential: "x".repeat(2_000_000) } }),
    /protocol rejected/u,
  );
  const { browserConnection: _browserConnection, ...nonBrowserStart } = start;
  assert.equal(parseAppWorkflowWorkerStart({
    ...nonBrowserStart,
    workflowId: "exchange-rates",
    input: null,
  }).workflowId, "exchange-rates");
  assert.throws(() => parseAppWorkflowWorkerStart({
    ...start,
    workflowId: "exchange-rates",
    input: null,
    browserConnection: start.browserConnection,
  }), /protocol rejected/u);
  assert.throws(() => parseAppWorkflowWorkerStart({
    ...nonBrowserStart,
    workflowId: "sync-maicoin",
    input: null,
    pgliteRpc: undefined,
  }), /protocol rejected/u);
  assert.equal(parseAppWorkflowWorkerOutboundFrame({
    protocolVersion: 2,
    kind: "exchange-rate-progress",
    eventId: "progress-1",
    phaseCode: "complete",
    completed: 3,
    total: 3,
    percent: 100,
  }).kind, "exchange-rate-progress");
  assert.throws(() => parseAppWorkflowWorkerOutboundFrame({
    protocolVersion: 2,
    kind: "exchange-rate-progress",
    eventId: "progress-2",
    phaseCode: "private-value",
    completed: 1,
    total: 3,
    percent: 33,
  }), /protocol rejected/u);
  const otpRequest = {
    protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
    kind: "cathay-gmail-otp-request",
    requestId: "c5596c12-0db2-46a3-bc80-14d31dc0d35e",
    operation: "retrieve",
    boundaryId: "ad6c9a82-815c-42f1-a5ba-7173f82616ec",
  };
  assert.equal(parseAppWorkflowWorkerOutboundFrame(otpRequest).kind, "cathay-gmail-otp-request");
  assert.throws(
    () => parseAppWorkflowWorkerOutboundFrame({ ...otpRequest, unexpected: "extra" }),
    /protocol rejected/u,
  );
  assert.throws(
    () => parseAppWorkflowWorkerInboundFrame({
      protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
      kind: "cathay-gmail-otp-response",
      requestId: "c5596c12-0db2-46a3-bc80-14d31dc0d35e",
      operation: "retrieve",
      status: "found",
      otp: "private mailbox response",
    }),
    /protocol rejected/u,
  );
  assert.throws(
    () => parseAppWorkflowWorkerInboundFrame({
      protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
      kind: "cathay-gmail-otp-response",
      requestId: "c5596c12-0db2-46a3-bc80-14d31dc0d35e",
      operation: "retrieve",
      status: "fallback",
      reason: "private mailbox response",
    }),
    /protocol rejected/u,
  );
});

test("worker terminal frame round-trips bounded product outcomes and rejects malformed products", () => {
  const products = [
    { typeId: "deposit", status: "success", itemCount: 2, committedCount: 2 },
    { typeId: "credit_card", status: "failed", itemCount: 1, committedCount: 0, errorCode: "source-collection-failed" },
    { typeId: "loan", status: "skipped", itemCount: 0, committedCount: 0, skipReason: "not_selected" },
  ];
  const summary = {
    status: "partial",
    counts: { itemCount: 3, committedCount: 2, sourceCaptureCount: 2 },
    products,
  } as const;
  const frame = parseAppWorkflowWorkerOutboundFrame({
    protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
    kind: "failed",
    taskRunId: "product-outcome-run",
    errorCode: "source-collection-failed",
    summary,
  });
  assert.equal(frame.kind, "failed");
  if (frame.kind !== "failed") return;
  assert.deepEqual(frame.summary, summary);
  assert.throws(() => parseAppWorkflowWorkerOutboundFrame({
    protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
    kind: "failed",
    taskRunId: "product-outcome-run",
    errorCode: "source-collection-failed",
    summary: {
      ...summary,
      products: [...products, { typeId: "fund", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-collection-failed", providerMessage: "private" }],
    },
  }), /protocol rejected/u, "unapproved fields are rejected by the worker protocol");
  assert.throws(() => parseAppWorkflowWorkerOutboundFrame({
    protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
    kind: "failed",
    taskRunId: "product-outcome-run",
    errorCode: "source-collection-failed",
    summary: { ...summary, products: [products[0], products[0]] },
  }), /protocol rejected/u, "duplicate product IDs are rejected");
});

test("nonbrowser exchange-rate worker derives its request through authenticated typed RPC", async () => {
  let readCalls = 0;
  const server = createPGliteChildRpcServer({
    provider: {
      operational: {
        exchangeRates: {
          async readExchangeRates() { readCalls += 1; return []; },
          async upsertExchangeRates() { throw new Error("No rates should be written without currencies."); },
        },
      },
      financial: {
        async overviewCurrent() { return { dailyHistory: [] }; },
      },
    } as never,
  });
  let worker: Worker | undefined;
  const phases: string[] = [];
  const codes: string[] = [];
  try {
    await server.ready;
    worker = new Worker(join(process.cwd(), "build-electron", "app-workflow-worker.cjs"), {
      workerData: {
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        workflowId: "exchange-rates",
        taskRunId: "exchange-worker-run",
        input: null,
        pgliteRpc: {
          endpoint: server.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT,
          token: server.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN,
        },
      },
    });
    const activeWorker = worker;
    const terminal = new Promise<AppWorkflowWorkerOutboundFrame>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Exchange-rate worker did not complete.")), 10_000);
      activeWorker.on("error", (error) => { clearTimeout(timeout); reject(error); });
      activeWorker.on("message", (value: unknown) => {
        const frame = parseAppWorkflowWorkerOutboundFrame(value);
        if (frame.kind === "event" || frame.kind === "exchange-rate-progress") {
          if (frame.kind === "event") codes.push(frame.event.code);
          else phases.push(frame.phaseCode);
          activeWorker.postMessage({
            protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
            kind: "event-ack",
            eventId: frame.eventId,
            ok: true,
          });
        } else if (frame.kind === "completed" || frame.kind === "failed" || frame.kind === "cancelled") {
          clearTimeout(timeout);
          resolve(frame);
        }
      });
    });
    assert.equal((await terminal).kind, "completed");
    assert.deepEqual(phases, ["load-request", "sync", "complete"]);
    assert.deepEqual(codes.slice(-1), ["run-completed"]);
    assert.equal(readCalls, 0, "a zero-currency overview needs no exchange-rate database read");
  } finally {
    if (worker) await worker.terminate();
    await server.close();
  }
});

test("Electron build emits the worker as an internal managed entry", () => {
  const workerBundle = join(process.cwd(), "build-electron", "app-workflow-worker.cjs");
  assert.ok(existsSync(workerBundle));
  assert.doesNotMatch(readFileSync(workerBundle, "utf8"), /gmail-otp-service|cathay-otp-port/u);
});

test("bundled internal worker validates workerData and returns a sanitized frame", async () => {
  const worker = new Worker(join(process.cwd(), "build-electron", "app-workflow-worker.cjs"), {
    workerData: { protocolVersion: 999, privateValue: "must-not-be-returned" },
  });
  const terminal = await new Promise<AppWorkflowWorkerOutboundFrame>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Bundled workflow worker did not reply.")), 5_000);
    worker.once("message", (value: unknown) => {
      clearTimeout(timeout);
      try { resolve(parseAppWorkflowWorkerOutboundFrame(value)); } catch (error) { reject(error); }
    });
    worker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error("Bundled workflow worker exited unexpectedly."));
      }
    });
  });
  assert.deepEqual(terminal, {
    protocolVersion: 2,
    kind: "failed",
    taskRunId: null,
    errorCode: "protocol-invalid",
  });
  assert.equal(JSON.stringify(terminal).includes("must-not-be-returned"), false);
});

test("worker runs a definition through typed ports and the bounded host request protocol", async () => {
  const channel = new MessageChannel();
  const observed: AppWorkflowWorkerOutboundFrame[] = [];
  let resolveTerminal!: (frame: AppWorkflowWorkerOutboundFrame) => void;
  const terminalReceived = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => { resolveTerminal = resolve; });
  let browserCalls = 0;
  let commitCalls = 0;
  const financialCommit: WorkflowFinancialCommitPort = {
    async execute(items) {
      const values: PGliteWorkflowRunItem[] = [];
      if (Symbol.asyncIterator in Object(items)) {
        for await (const item of items as AsyncIterable<PGliteWorkflowRunItem>) values.push(item);
      } else {
        for (const item of items as Iterable<PGliteWorkflowRunItem>) values.push(item);
      }
      assert.equal(values[0]?.itemKey, "fixture-item");
      commitCalls += 1;
      return successfulCommit();
    },
  };
  const definition: WorkflowDefinition = {
    id: "fixture-protocol",
    requiresFinancialCommit: true,
    async run(context, input) {
      assert.deepEqual(input, start.input);
      await context.browser.withPage(async () => { browserCalls += 1; });
      assert.equal(context.text.decode(Uint8Array.of(0x41), "utf-8"), "A");
      await context.event("collection", "fixture-started", { completed: 1, total: 1 });
      assert.equal(await context.humanAssistance.request(contract, context.signal), "verified");
      const committed = await context.financialCommit!.execute([runItem()]);
      assert.equal(committed.status, "completed");
      await context.event("commit", "canonical-commit-completed");
      return { status: "completed", count: 1, accountNumber: "must-not-cross-worker-boundary" };
    },
  };

  channel.port2.on("message", (value: unknown) => {
    const frame = parseAppWorkflowWorkerOutboundFrame(value);
    observed.push(frame);
    if (frame.kind === "completed" || frame.kind === "failed" || frame.kind === "cancelled") resolveTerminal(frame);
    if (frame.kind === "event") {
      channel.port2.postMessage({
        protocolVersion: 2,
        kind: "event-ack",
        eventId: frame.eventId,
        ok: true,
      });
    } else if (frame.kind === "human-assistance-request") {
      channel.port2.postMessage({
        protocolVersion: 2,
        kind: "human-assistance-response",
        requestId: frame.requestId,
        status: "verified",
      });
    }
  });

  try {
    await runAppWorkflowWorker({
      port: channel.port1,
      workerData: start,
      resolveDefinition: () => definition,
      browser: {
        async withPage(run) {
          return await run({} as never);
        },
      },
      financialCommit,
    });
    const terminal = await terminalReceived;
    assert.equal(terminal?.kind, "completed", observed.map((frame) => frame.kind === "failed" ? frame.errorCode : frame.kind).join(","));
    if (terminal?.kind === "completed") {
      assert.deepEqual(terminal.summary, { status: "completed", counts: { count: 1 } });
      assert.equal(JSON.stringify(terminal).includes("must-not-cross-worker-boundary"), false);
    }
    assert.equal(JSON.stringify(observed).includes("sensitive-fixture"), false);
    assert.equal(observed.filter((frame) => frame.kind === "event").length, 4);
    assert.equal(observed.filter((frame) => frame.kind === "human-assistance-request").length, 1);
    assert.equal(browserCalls, 1);
    assert.equal(commitCalls, 1);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test("worker failures cross the boundary only as a stable error code", async () => {
  const channel = new MessageChannel();
  let resolveTerminal!: (frame: AppWorkflowWorkerOutboundFrame) => void;
  const terminalReceived = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => { resolveTerminal = resolve; });
  channel.port2.on("message", (value: unknown) => {
    const frame = parseAppWorkflowWorkerOutboundFrame(value);
    if (frame.kind === "event") {
      channel.port2.postMessage({ protocolVersion: 2, kind: "event-ack", eventId: frame.eventId, ok: true });
    } else if (frame.kind === "failed" || frame.kind === "completed" || frame.kind === "cancelled") {
      resolveTerminal(frame);
    }
  });
  const definition: WorkflowDefinition = {
    id: "fixture-protocol",
    requiresFinancialCommit: false,
    async run() {
      throw new Error("provider returned account number 123-456-789 and raw invoice text");
    },
  };
  try {
    await runAppWorkflowWorker({
      port: channel.port1,
      workerData: (({ pgliteRpc: _pgliteRpc, ...withoutRpc }) => withoutRpc)(start),
      resolveDefinition: () => definition,
      browser: { async withPage() { throw new Error("unused"); } },
    });
    const terminal = await terminalReceived;
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.kind === "failed" ? terminal.errorCode : null, "workflow-failed");
    assert.equal(JSON.stringify(terminal).includes("123-456-789"), false);
    assert.equal(JSON.stringify(terminal).includes("raw invoice text"), false);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test("Cathay verification errors retain their actionable code across the worker boundary", async () => {
  const channel = new MessageChannel();
  let resolveTerminal!: (frame: AppWorkflowWorkerOutboundFrame) => void;
  const terminalReceived = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => { resolveTerminal = resolve; });
  const frames: AppWorkflowWorkerOutboundFrame[] = [];
  channel.port2.on("message", (value: unknown) => {
    const frame = parseAppWorkflowWorkerOutboundFrame(value);
    frames.push(frame);
    if (frame.kind === "event") {
      channel.port2.postMessage({ protocolVersion: 2, kind: "event-ack", eventId: frame.eventId, ok: true });
    } else if (frame.kind === "failed" || frame.kind === "completed" || frame.kind === "cancelled") {
      resolveTerminal(frame);
    }
  });
  const definition: WorkflowDefinition = {
    id: "fixture-protocol",
    requiresFinancialCommit: false,
    async run(context) {
      await context.event("authentication", "cathay-email-otp-gmail-needs-authorization");
      throw new CathayAppVerificationError("gmail-needs-authorization");
    },
  };
  try {
    await runAppWorkflowWorker({
      port: channel.port1,
      workerData: (({ pgliteRpc: _pgliteRpc, ...withoutRpc }) => withoutRpc)(start),
      resolveDefinition: () => definition,
      browser: { async withPage() { throw new Error("unused"); } },
    });
    const terminal = await terminalReceived;
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.kind === "failed" ? terminal.errorCode : null, "verification-configuration-failed");
    assert.ok(frames.some((frame) => frame.kind === "event" && frame.event.code === "cathay-email-otp-gmail-needs-authorization"));
    assert.doesNotMatch(JSON.stringify(frames), /could not be completed|refresh-token|private/u);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test("worker keeps the observed failure stage across the validated IPC boundary", async () => {
  const cases = [
    { stage: "authentication", code: "authentication-started", name: "TimeoutError", expected: "authentication-timeout" },
    { stage: "authentication", code: "login-dialog-interrupted", name: "Error", expected: "authentication-dialog-interrupted" },
    { stage: "authentication", code: "human-assistance-failed", name: "Error", expected: "verification-failed" },
    { stage: "authentication", code: "human-assistance-completed", name: "Error", expected: "authentication-failed" },
    { stage: "collection", code: "current-balance-collection-failed", name: "Error", expected: "source-collection-failed" },
  ] as const;
  for (const scenario of cases) {
    const channel = new MessageChannel();
    let resolveTerminal!: (frame: AppWorkflowWorkerOutboundFrame) => void;
    const terminalReceived = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => { resolveTerminal = resolve; });
    const frames: AppWorkflowWorkerOutboundFrame[] = [];
    channel.port2.on("message", (value: unknown) => {
      const frame = parseAppWorkflowWorkerOutboundFrame(value);
      frames.push(frame);
      if (frame.kind === "event") {
        channel.port2.postMessage({ protocolVersion: 2, kind: "event-ack", eventId: frame.eventId, ok: true });
      } else if (frame.kind === "failed" || frame.kind === "completed" || frame.kind === "cancelled") {
        resolveTerminal(frame);
      }
    });
    const definition: WorkflowDefinition = {
      id: "fixture-protocol",
      requiresFinancialCommit: false,
      async run(context) {
        await context.event(scenario.stage, scenario.code);
        const error = new Error("private-authentication-material must not cross the boundary");
        error.name = scenario.name;
        throw error;
      },
    };
    try {
      await runAppWorkflowWorker({
        port: channel.port1,
        workerData: (({ pgliteRpc: _pgliteRpc, ...withoutRpc }) => withoutRpc)(start),
        resolveDefinition: () => definition,
        browser: { async withPage() { throw new Error("unused"); } },
      });
      const terminal = await terminalReceived;
      assert.equal(terminal.kind === "failed" ? terminal.errorCode : terminal.kind, scenario.expected);
      assert.doesNotMatch(JSON.stringify(frames), /private-authentication-material/u);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  }
});

test("SinoPac rejection crosses the worker boundary as an allowlisted typed terminal outcome", async () => {
  const channel = new MessageChannel();
  let resolveTerminal!: (frame: AppWorkflowWorkerOutboundFrame) => void;
  const terminalReceived = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => { resolveTerminal = resolve; });
  channel.port2.on("message", (value: unknown) => {
    const frame = parseAppWorkflowWorkerOutboundFrame(value);
    if (frame.kind === "event") {
      channel.port2.postMessage({ protocolVersion: 2, kind: "event-ack", eventId: frame.eventId, ok: true });
    } else if (frame.kind === "failed" || frame.kind === "completed" || frame.kind === "cancelled") {
      resolveTerminal(frame);
    }
  });
  const definition: WorkflowDefinition = {
    id: "fixture-protocol",
    requiresFinancialCommit: false,
    async run() {
      throw new SinopacCaptchaRejectedError();
    },
  };
  try {
    await runAppWorkflowWorker({
      port: channel.port1,
      workerData: (({ pgliteRpc: _pgliteRpc, ...withoutRpc }) => withoutRpc)(start),
      resolveDefinition: () => definition,
      browser: { async withPage() { throw new Error("unused"); } },
    });
    const terminal = await terminalReceived;
    assert.equal(terminal.kind, "failed");
    assert.equal(terminal.kind === "failed" ? terminal.errorCode : null, "captcha-provider-rejected");
    assert.equal(JSON.stringify(terminal).includes("123-456-789"), false);
    assert.equal(JSON.stringify(terminal).includes("raw invoice text"), false);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test("worker cancellation aborts a pending definition and emits no provider exception", async () => {
  const channel = new MessageChannel();
  const observed: AppWorkflowWorkerOutboundFrame[] = [];
  let resolveTerminal!: (frame: AppWorkflowWorkerOutboundFrame) => void;
  const terminalReceived = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => { resolveTerminal = resolve; });
  let started!: () => void;
  const hasStarted = new Promise<void>((resolve) => { started = resolve; });
  const definition: WorkflowDefinition = {
    id: "fixture-protocol",
    requiresFinancialCommit: false,
    async run(context) {
      started();
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("account data in provider exception")), { once: true });
      });
    },
  };
  channel.port2.on("message", (value: unknown) => {
    const frame = parseAppWorkflowWorkerOutboundFrame(value);
    observed.push(frame);
    if (frame.kind === "completed" || frame.kind === "failed" || frame.kind === "cancelled") resolveTerminal(frame);
    if (frame.kind === "event") {
      channel.port2.postMessage({ protocolVersion: 2, kind: "event-ack", eventId: frame.eventId, ok: true });
    }
  });
  try {
    const running = runAppWorkflowWorker({
      port: channel.port1,
      workerData: (({ pgliteRpc: _pgliteRpc, ...withoutRpc }) => withoutRpc)(start),
      resolveDefinition: () => definition,
      browser: { async withPage() { throw new Error("unused"); } },
    });
    await hasStarted;
    channel.port2.postMessage({ protocolVersion: 2, kind: "cancel" });
    await running;
    const terminal = await terminalReceived;
    assert.equal(terminal.kind, "cancelled");
    assert.equal(observed.some((frame) => frame.kind === "failed" && JSON.stringify(frame).includes("account data")), false);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test("Cathay worker relays Gmail OTP through the injected host port and keeps it out of events and terminal output", async () => {
  const channel = new MessageChannel();
  const cathayStart = { ...start, workflowId: "cathay-all-statements" };
  const observed: AppWorkflowWorkerOutboundFrame[] = [];
  const eventFrames: AppWorkflowWorkerOutboundFrame[] = [];
  const operationOrder: string[] = [];
  const otp = "ABCD-123456";
  const boundaryId = "ad6c9a82-815c-42f1-a5ba-7173f82616ec";
  let resolveTerminal!: (frame: AppWorkflowWorkerOutboundFrame) => void;
  const terminalReceived = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => { resolveTerminal = resolve; });
  let injectedOtp: CathayGmailOtpPort | undefined;
  const definition: WorkflowDefinition = {
    id: "cathay-all-statements",
    requiresFinancialCommit: false,
    async run(context) {
      assert.ok(injectedOtp);
      assert.deepEqual(await injectedOtp.ensureAccess(), { status: "ready" });
      const prepared = await injectedOtp.prepareRetrieval();
      assert.deepEqual(prepared, { status: "prepared", boundaryId });
      assert.deepEqual(await injectedOtp.retrieve(boundaryId), { status: "found", otp });
      await context.event("authentication", "otp-accepted");
      return { status: "completed", count: 1, otp };
    },
  };

  channel.port2.on("message", (value: unknown) => {
    const frame = parseAppWorkflowWorkerOutboundFrame(value);
    observed.push(frame);
    if (frame.kind === "completed" || frame.kind === "failed" || frame.kind === "cancelled") resolveTerminal(frame);
    if (frame.kind === "event") {
      eventFrames.push(frame);
      channel.port2.postMessage({
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "event-ack",
        eventId: frame.eventId,
        ok: true,
      });
      return;
    }
    if (frame.kind !== "cathay-gmail-otp-request") return;
    operationOrder.push(frame.operation);
    if (frame.operation === "ensure-access") {
      channel.port2.postMessage({
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "cathay-gmail-otp-response",
        requestId: frame.requestId,
        operation: frame.operation,
        status: "ready",
      });
    } else if (frame.operation === "prepare-retrieval") {
      channel.port2.postMessage({
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "cathay-gmail-otp-response",
        requestId: frame.requestId,
        operation: frame.operation,
        status: "prepared",
        boundaryId,
      });
    } else {
      channel.port2.postMessage({
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "cathay-gmail-otp-response",
        requestId: frame.requestId,
        operation: frame.operation,
        status: "found",
        otp,
      });
    }
  });

  try {
    await runAppWorkflowWorker({
      port: channel.port1,
      workerData: cathayStart,
      resolveDefinition(workflowId, dependencies) {
        assert.equal(workflowId, "cathay-all-statements");
        injectedOtp = dependencies?.cathayGmailOtpPort;
        return definition;
      },
      browser: { async withPage(run) { return await run({} as never); } },
    });
    const terminal = await terminalReceived;
    assert.equal(terminal.kind, "completed");
    assert.deepEqual(operationOrder, ["ensure-access", "prepare-retrieval", "retrieve"]);
    assert.equal(eventFrames.some((frame) => JSON.stringify(frame).includes(otp)), false);
    assert.equal(JSON.stringify(terminal).includes(otp), false);
    assert.equal(JSON.stringify(terminal).includes("private"), false);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});
