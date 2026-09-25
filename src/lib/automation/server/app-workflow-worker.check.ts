import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { MessageChannel, Worker } from "node:worker_threads";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowDefinition, WorkflowFinancialCommitPort } from "../workflow-executor.ts";
import type { PGliteWorkflowRunItem, PGliteWorkflowRunResult } from "../../../ledger/pglite/workflow-run.ts";
import {
  parseAppWorkflowWorkerInboundFrame,
  parseAppWorkflowWorkerOutboundFrame,
  parseAppWorkflowWorkerStart,
  type AppWorkflowWorkerOutboundFrame,
} from "./app-workflow-worker-protocol.ts";
import { runAppWorkflowWorker } from "./app-workflow-worker-runtime.ts";

const start = {
  protocolVersion: 1,
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
    () => parseAppWorkflowWorkerInboundFrame({ protocolVersion: 1, kind: "human-assistance-response", requestId: "x", status: "pending" }),
    /protocol rejected/u,
  );
  assert.throws(
    () => parseAppWorkflowWorkerOutboundFrame({ protocolVersion: 1, kind: "event", eventId: "e1", event: { runId: "run-fixture-1", stage: "collection", code: "valid-code", occurredAt: "2026-09-26T00:00:00.000Z", raw: "source bytes" } }),
    /protocol rejected/u,
  );
  assert.throws(
    () => parseAppWorkflowWorkerStart({ ...start, input: { credential: "x".repeat(2_000_000) } }),
    /protocol rejected/u,
  );
});

test("Electron build emits the worker as an internal managed entry", () => {
  assert.ok(existsSync(join(process.cwd(), "build-electron", "app-workflow-worker.cjs")));
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
    protocolVersion: 1,
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
        protocolVersion: 1,
        kind: "event-ack",
        eventId: frame.eventId,
        ok: true,
      });
    } else if (frame.kind === "human-assistance-request") {
      channel.port2.postMessage({
        protocolVersion: 1,
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
      channel.port2.postMessage({ protocolVersion: 1, kind: "event-ack", eventId: frame.eventId, ok: true });
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
      channel.port2.postMessage({ protocolVersion: 1, kind: "event-ack", eventId: frame.eventId, ok: true });
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
    channel.port2.postMessage({ protocolVersion: 1, kind: "cancel" });
    await running;
    const terminal = await terminalReceived;
    assert.equal(terminal.kind, "cancelled");
    assert.equal(observed.some((frame) => frame.kind === "failed" && JSON.stringify(frame).includes("account data")), false);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});
