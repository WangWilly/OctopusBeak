import { SinopacCaptchaRejectedError } from "../sinopac-captcha.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MessageChannel, Worker } from "node:worker_threads";
import { join } from "node:path";
import test from "node:test";
import { collectSelectedProducts, ProductCollectionFatalError } from "../product-collection.ts";
import type { WorkflowDefinition, WorkflowFinancialCommitPort } from "../workflow-executor.ts";
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

test("worker protocol preserves a character OCR strategy and rejects unregistered settings", () => {
  const frame = { protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION, kind: "human-assistance-request",
    requestId: "character-verification", contract: { ...contract, challengeKind: "text-captcha", ocrAttemptPlan: [
      { imagePreprocessing: ["rakuten-teal-foreground"], ocrCharacterSegmentation: "rakuten-four-slots" },
    ] } };
  const parsed = parseAppWorkflowWorkerOutboundFrame(frame);
  assert.equal(parsed.kind, "human-assistance-request");
  if (parsed.kind === "human-assistance-request") assert.deepEqual(parsed.contract.ocrAttemptPlan, frame.contract.ocrAttemptPlan);
  assert.throws(() => parseAppWorkflowWorkerOutboundFrame({ ...frame,
    contract: { ...frame.contract, ocrAttemptPlan: [{ ocrCharacterSegmentation: "unknown" }] },
  }), /protocol rejected/);
});

function runItem(): PGliteWorkflowRunItem {
  return {
    provider: "fixture",
    product: "fixture",
    itemKey: "fixture-item",
    command: { kind: "financial.source.admit", request: {} },
  } as unknown as PGliteWorkflowRunItem;
}

function successfulCommit(items: readonly PGliteWorkflowRunItem[] = [runItem()]): PGliteWorkflowRunResult<unknown> {
  return {
    status: "completed",
    items: items.map((item) => ({
      itemKey: item.itemKey, provider: item.provider, product: item.product,
      status: "committed", admissionSummaries: [], value: null, relationWarnings: [],
    })),
    diagnostics: [],
    committedCount: items.length,
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
    () => parseAppWorkflowWorkerOutboundFrame({ protocolVersion: 2, kind: "event", eventId: "e1", event: { runId: "run-fixture-1", stage: "collection", outcome: "advanced", code: "valid-code", occurredAt: "2026-09-26T00:00:00.000Z", raw: "source bytes" } }),
    /protocol rejected/u,
  );
  const scopedProgressEvent = parseAppWorkflowWorkerOutboundFrame({
    protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
    kind: "event",
    eventId: "scoped-progress",
    event: {
      runId: "run-fixture-1",
      stage: "collection",
      outcome: "started", code: "statement-download-started",
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
        outcome: "started", code: "statement-download-started",
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
        async request() { return { dailyHistory: [] }; },
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
      const values = [...items];
      assert.equal(values[0]?.itemKey, "fixture-item");
      commitCalls += 1;
      return successfulCommit(values);
    },
  };
  const definition: WorkflowDefinition = {
    id: "fixture-protocol",
    requiresFinancialCommit: true,
    async run(context, input) {
      assert.deepEqual(input, start.input);
      await context.browser.withPage(async () => { browserCalls += 1; });
      assert.equal(context.text.decode(Uint8Array.of(0x41), "utf-8"), "A");
      await context.event("collection", "started", "fixture-started", { completed: 1, total: 1 });
      assert.equal(await context.humanAssistance.request(contract, context.signal), "verified");
      const committed = await context.financialCommit!.execute([runItem()]);
      assert.equal(committed.status, "completed");
      return { status: "completed", count: 1, accountNumber: "must-not-cross-worker-boundary" };
    },
  };

  channel.port2.on("message", (value: unknown) => {
    const frame = parseAppWorkflowWorkerOutboundFrame(value);
    observed.push(frame);
    if (frame.kind === "completed" || frame.kind === "failed" || frame.kind === "cancelled") resolveTerminal(frame);
    if (frame.kind === "event" || frame.kind === "commit-attempt") {
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
    assert.equal(observed.filter((frame) => frame.kind === "event").length, 5);
    assert.deepEqual(
      observed.flatMap((frame) => frame.kind === "commit-attempt" ? [frame.attempt.phase] : []),
      ["started", "settled"],
    );
    assert.equal(observed.filter((frame) => frame.kind === "human-assistance-request").length, 1);
    assert.equal(browserCalls, 1);
    assert.equal(commitCalls, 1);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test("a browser workflow that needs only account identity reaches it through the authenticated RPC", async () => {
  const continuityRequest = {
    integrationNamespace: "fubon",
    sourceConnectionKey: `sha256:${"C".repeat(43)}`,
    identityEpochKey: `sha256:${"E".repeat(43)}`,
    stream: "domestic-deposit",
    identifier: { kind: "depository-account" as const, value: "1".repeat(14) },
  };
  const continued = { status: "continued", sourceAccountKey: `sha256:${"K".repeat(43)}` };
  const continuityRequests: unknown[] = [];
  const server = createPGliteChildRpcServer({
    provider: {
      operational: {},
      financial: {
        async request(operation: string, args: unknown[]) {
          assert.equal(operation, "financial.accountIdentity.continuity");
          continuityRequests.push(args[0]);
          return continued;
        },
      },
    } as never,
  });
  const channel = new MessageChannel();
  const terminal = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => {
    channel.port2.on("message", (value: unknown) => {
      const frame = parseAppWorkflowWorkerOutboundFrame(value);
      if (frame.kind === "event" || frame.kind === "commit-attempt") {
        channel.port2.postMessage({
          protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
          kind: "event-ack",
          eventId: frame.eventId,
          ok: true,
        });
      } else if (frame.kind === "completed" || frame.kind === "failed" || frame.kind === "cancelled") {
        resolve(frame);
      }
    });
  });
  const definition: WorkflowDefinition = {
    id: "fixture-protocol",
    requiresFinancialCommit: false,
    requiresAccountIdentity: true,
    async run(context) {
      assert.deepEqual(await context.accountIdentity!.continuity(continuityRequest as never), continued);
      return { status: "completed", count: 1 };
    },
  };
  try {
    await server.ready;
    await runAppWorkflowWorker({
      port: channel.port1,
      workerData: {
        ...start,
        pgliteRpc: {
          endpoint: server.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT,
          token: server.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN,
        },
      },
      resolveDefinition: () => definition,
      browser: { async withPage(run) { return await run({} as never); } },
    });
    const frame = await terminal;
    assert.equal(frame.kind, "completed", JSON.stringify(frame));
    assert.deepEqual(continuityRequests, [continuityRequest]);
  } finally {
    channel.port1.close();
    channel.port2.close();
    await server.close();
  }
});

test("a product failure inside a partial run appends one correlated diagnostic record", async () => {
  const channel = new MessageChannel();
  let resolveTerminal!: (frame: AppWorkflowWorkerOutboundFrame) => void;
  const terminalReceived = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => { resolveTerminal = resolve; });
  channel.port2.on("message", (value: unknown) => {
    const frame = parseAppWorkflowWorkerOutboundFrame(value);
    if (frame.kind === "event" || frame.kind === "commit-attempt") {
      channel.port2.postMessage({ protocolVersion: 2, kind: "event-ack", eventId: frame.eventId, ok: true });
    } else if (frame.kind === "failed" || frame.kind === "completed" || frame.kind === "cancelled") {
      resolveTerminal(frame);
    }
  });
  const definition: WorkflowDefinition = {
    id: "fixture-protocol",
    requiresFinancialCommit: true,
    async run(context) {
      return await collectSelectedProducts({
        productIds: ["deposit", "credit_card"],
        selectedIds: ["deposit", "credit_card"],
        signal: context.signal,
        collect: async (typeId, staged) => {
          if (typeId === "credit_card") throw new TypeError("provider row 123-456-789 unreadable");
          staged.push(runItem());
          return { sourceCaptureCount: 1, rowCount: 1, itemCount: 1 };
        },
        commit: (_typeId, staged) => context.financialCommit!.execute(staged),
        event: context.event,
        productFailure: context.productFailure,
      });
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "octopus-worker-product-diagnostics-"));
  const diagnosticPath = join(directory, "workflow-failures.jsonl");
  const previousEnv = {
    OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE: process.env.OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE,
    OCTOPUSBEAK_APP_ROOT: process.env.OCTOPUSBEAK_APP_ROOT,
  };
  process.env.OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE = diagnosticPath;
  process.env.OCTOPUSBEAK_APP_ROOT = process.cwd();
  try {
    await runAppWorkflowWorker({
      port: channel.port1,
      workerData: start,
      resolveDefinition: () => definition,
      browser: { async withPage() { throw new Error("unused"); } },
      financialCommit: {
        async execute() {
          return {
            ...successfulCommit(),
            items: [{
              provider: "fixture", product: "fixture", itemKey: "fixture-item",
              status: "committed" as const, value: null, admissionSummaries: [], relationWarnings: [],
            }],
          };
        },
      },
    });
    const terminal = await terminalReceived;
    assert.equal(terminal.kind, "completed");
    const lines = (await readFile(diagnosticPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1, "one product failure appends exactly one record");
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(record.workflowId, "fixture-protocol");
    assert.equal(record.taskRunId, "run-fixture-1");
    assert.equal(record.source, "workflow-worker");
    assert.equal(record.errorCode, "source-collection-failed");
    assert.equal(record.stage, "collection");
    assert.equal(record.statementType, "credit_card");
    const chain = (record.error as { chain: Array<{ type: string; frames: Array<{ file: string }> }> }).chain;
    assert.equal(chain[0]?.type, "TypeError");
    assert.equal(chain[0]?.frames[0]?.file, "src/lib/automation/server/app-workflow-worker.check.ts");
    assert.doesNotMatch(lines[0]!, /123-456-789|unreadable|sensitive-fixture/u);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    channel.port1.close();
    channel.port2.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker failures cross the boundary only as a stable error code", async () => {
  const channel = new MessageChannel();
  let resolveTerminal!: (frame: AppWorkflowWorkerOutboundFrame) => void;
  const terminalReceived = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => { resolveTerminal = resolve; });
  channel.port2.on("message", (value: unknown) => {
    const frame = parseAppWorkflowWorkerOutboundFrame(value);
    if (frame.kind === "event" || frame.kind === "commit-attempt") {
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

test("a Cathay run that needs device registration keeps that code across the worker boundary", async () => {
  const channel = new MessageChannel();
  let resolveTerminal!: (frame: AppWorkflowWorkerOutboundFrame) => void;
  const terminalReceived = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => { resolveTerminal = resolve; });
  const frames: AppWorkflowWorkerOutboundFrame[] = [];
  channel.port2.on("message", (value: unknown) => {
    const frame = parseAppWorkflowWorkerOutboundFrame(value);
    frames.push(frame);
    if (frame.kind === "event" || frame.kind === "commit-attempt") {
      channel.port2.postMessage({ protocolVersion: 2, kind: "event-ack", eventId: frame.eventId, ok: true });
    } else if (frame.kind === "failed" || frame.kind === "completed" || frame.kind === "cancelled") {
      resolveTerminal(frame);
    }
  });
  const definition: WorkflowDefinition = {
    id: "fixture-protocol",
    requiresFinancialCommit: false,
    async run(context) {
      await context.event("authentication", "advanced", "device-registration-required");
      throw new ProductCollectionFatalError("device-registration-required");
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
    assert.equal(terminal.kind === "failed" ? terminal.errorCode : null, "device-registration-required");
    assert.ok(frames.some((frame) => frame.kind === "event" && frame.event.code === "device-registration-required"));
    assert.doesNotMatch(JSON.stringify(frames), /required workflow condition|private/u);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test("worker keeps the observed failure stage across the validated IPC boundary", async () => {
  const cases = [
    { stage: "authentication", outcome: "started", code: "authentication-started", name: "TimeoutError", expected: "authentication-timeout" },
    { stage: "authentication", outcome: "failed", signal: "login-dialog-interrupted", code: "login-dialog-interrupted", name: "Error", expected: "authentication-dialog-interrupted" },
    { stage: "authentication", outcome: "failed", signal: "human-assistance-failed", code: "human-assistance-failed", name: "Error", expected: "verification-failed" },
    { stage: "authentication", outcome: "advanced", code: "human-assistance-completed", name: "Error", expected: "authentication-failed" },
    { stage: "collection", outcome: "failed", code: "current-balance-collection-failed", name: "Error", expected: "source-collection-failed" },
  ] as const;
  for (const scenario of cases) {
    const channel = new MessageChannel();
    let resolveTerminal!: (frame: AppWorkflowWorkerOutboundFrame) => void;
    const terminalReceived = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => { resolveTerminal = resolve; });
    const frames: AppWorkflowWorkerOutboundFrame[] = [];
    channel.port2.on("message", (value: unknown) => {
      const frame = parseAppWorkflowWorkerOutboundFrame(value);
      frames.push(frame);
      if (frame.kind === "event" || frame.kind === "commit-attempt") {
        channel.port2.postMessage({ protocolVersion: 2, kind: "event-ack", eventId: frame.eventId, ok: true });
      } else if (frame.kind === "failed" || frame.kind === "completed" || frame.kind === "cancelled") {
        resolveTerminal(frame);
      }
    });
    const definition: WorkflowDefinition = {
      id: "fixture-protocol",
      requiresFinancialCommit: false,
      async run(context) {
        if ("signal" in scenario) await context.signalEvent(scenario.signal);
        else await context.event(scenario.stage, scenario.outcome, scenario.code);
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
    if (frame.kind === "event" || frame.kind === "commit-attempt") {
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
    if (frame.kind === "event" || frame.kind === "commit-attempt") {
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

test("a settlement that finishes after cancellation still reaches the host", async () => {
  const channel = new MessageChannel();
  const observed: AppWorkflowWorkerOutboundFrame[] = [];
  const definition: WorkflowDefinition = {
    id: "fixture-protocol",
    requiresFinancialCommit: true,
    async run(context) {
      await context.browser.withPage(async () => undefined);
      await context.financialCommit!.execute([runItem()], { signal: context.signal });
      context.signal.throwIfAborted();
      return null;
    },
  };
  const financialCommit: WorkflowFinancialCommitPort = {
    // The canonical request stops at the next item boundary once the run is cancelled.
    async execute(_items, options) {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        status: "cancelled", items: [], committedCount: 0, failedCount: 0,
        diagnostics: [{ provider: "fixture", product: "fixture", itemKey: "fixture-item", stage: "cancellation", errorCode: "cancelled", message: "cancelled" }],
      };
    },
  };
  // Like the supervisor: after asking the worker to stop, ACK only commit attempts.
  let stopping = false;
  const terminal = new Promise<AppWorkflowWorkerOutboundFrame>((resolve) => {
    channel.port2.on("message", (value: unknown) => {
      const frame = parseAppWorkflowWorkerOutboundFrame(value);
      observed.push(frame);
      if (frame.kind === "completed" || frame.kind === "failed" || frame.kind === "cancelled") resolve(frame);
      if (frame.kind === "commit-attempt" || (frame.kind === "event" && !stopping)) {
        channel.port2.postMessage({ protocolVersion: 2, kind: "event-ack", eventId: frame.eventId, ok: true });
      }
      if (frame.kind === "commit-attempt" && frame.attempt.phase === "started") {
        stopping = true;
        channel.port2.postMessage({ protocolVersion: 2, kind: "cancel" });
      }
    });
  });
  try {
    await runAppWorkflowWorker({
      port: channel.port1,
      workerData: start,
      resolveDefinition: () => definition,
      browser: { async withPage(run) { return await run({} as never); } },
      financialCommit,
    });
    assert.equal((await terminal).kind, "cancelled");
    assert.deepEqual(
      observed.flatMap((frame) => frame.kind === "commit-attempt" ? [frame.attempt] : []).map((attempt) =>
        attempt.phase === "settled" ? [attempt.phase, attempt.outcome] : [attempt.phase]),
      [["started"], ["settled", "cancelled"]],
    );
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});
