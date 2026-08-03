import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentHarnessService,
  createInMemoryAgentRunStore,
  type AgentHelper,
  type AgentProvider,
} from "./harness.ts";
import { createSqliteAgentRunStore } from "./store.ts";

function deterministicAdapter() {
  const completions = new Map<string, () => void>();
  const cancellations: string[] = [];
  const provider: AgentProvider = {
    start({ runId, onComplete }) {
      completions.set(runId, onComplete);
    },
    cancel(runId) {
      cancellations.push(runId);
    },
  };
  const helper: AgentHelper = {
    launch(input) {
      input.provider.start(input);
    },
    cancel(runId) {
      provider.cancel(runId);
    },
  };
  return {
    helper,
    provider,
    complete(runId: string) {
      completions.get(runId)?.();
    },
    cancellations,
  };
}

test("host-owned harness exposes lifecycle and persists safe lineage", () => {
  const adapter = deterministicAdapter();
  const diagnostics: unknown[] = [];
  let nextRun = 1;
  const service = createAgentHarnessService({
    helper: adapter.helper,
    provider: adapter.provider,
    runStore: createInMemoryAgentRunStore(),
    toolGateway: {
      execute() {
        throw new Error("no-tool run must not execute a tool");
      },
    },
    clock: {
      now: () => "2026-08-03T00:00:00.000Z",
    },
    diagnosticsSink: {
      record(event) {
        diagnostics.push(event);
      },
    },
    idFactory: () => `run-deterministic-${nextRun++}`,
    secretValues: [],
  });

  const started = service.start({ analysisId: "analysis-1" });
  assert.deepEqual(started, {
    runId: "run-deterministic-1",
    phase: "running",
    action: { type: "cancel" },
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: null,
  });
  assert.deepEqual(service.status(started.runId), started);
  assert.deepEqual(service.lineage(started.runId).map((event) => event.kind), ["run.started"]);

  adapter.complete(started.runId);
  assert.deepEqual(service.status(started.runId), {
    ...started,
    phase: "completed",
    action: null,
    finishedAt: "2026-08-03T00:00:00.000Z",
  });
  assert.deepEqual(service.lineage(started.runId).map((event) => event.kind), [
    "run.started",
    "run.completed",
  ]);

  const cancelled = service.start({});
  const cancelledStatus = service.cancel(cancelled.runId);
  assert.equal(cancelledStatus.phase, "cancelled");
  assert.equal(cancelledStatus.action, null);
  assert.deepEqual(adapter.cancellations, [cancelled.runId]);
  assert.deepEqual(service.lineage(cancelled.runId).map((event) => event.kind), [
    "run.started",
    "run.cancelled",
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("analysis-1"), false);
});

test("lineage survives a run-store reopen through the public service", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-harness-"));
  try {
    const adapter = deterministicAdapter();
    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    const service = createAgentHarnessService({
      helper: adapter.helper,
      provider: adapter.provider,
      runStore: store,
      toolGateway: { execute: () => ({ status: "rejected" }) },
      clock: { now: () => "2026-08-03T00:00:00.000Z" },
      diagnosticsSink: { record() {} },
      idFactory: () => "run-persisted-1",
      secretValues: [],
    });

    const started = service.start({ analysisId: "analysis-persisted-1" });
    adapter.complete(started.runId);
    assert.deepEqual(service.lineage(started.runId).map((event) => event.kind), [
      "run.started",
      "run.completed",
    ]);
    store.close();

    const reopenedStore = createSqliteAgentRunStore(root, { secretValues: [] });
    const reopenedService = createAgentHarnessService({
      helper: adapter.helper,
      provider: adapter.provider,
      runStore: reopenedStore,
      toolGateway: { execute: () => ({ status: "rejected" }) },
      clock: { now: () => "2026-08-03T00:00:00.000Z" },
      diagnosticsSink: { record() {} },
      secretValues: [],
    });
    assert.equal(reopenedService.status(started.runId).phase, "completed");
    assert.deepEqual(reopenedService.lineage(started.runId).map((event) => event.kind), [
      "run.started",
      "run.completed",
    ]);
    assert.equal(reopenedService.lineage(started.runId)[0]?.analysisId, "analysis-persisted-1");
    reopenedStore.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret boundary fails closed before agent persistence and diagnostics", () => {
  const canary = "agent-harness-secret-canary";
  const runStore = createInMemoryAgentRunStore();
  const diagnostics: unknown[] = [];
  const adapter = deterministicAdapter();
  const service = createAgentHarnessService({
    helper: adapter.helper,
    provider: adapter.provider,
    runStore,
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record: (event) => diagnostics.push(event) },
    idFactory: () => canary,
    secretValues: [canary],
  });

  assert.throws(() => service.start({}), /SECRET_BOUNDARY_VIOLATION/);
  assert.equal(runStore.getRun(canary), null);
  assert.equal(JSON.stringify(diagnostics).includes(canary), false);
});

test("SQLite Agent store rejects a canary before writing a run", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-harness-boundary-"));
  const canary = "agent-sqlite-secret-canary";
  try {
    const store = createSqliteAgentRunStore(root, { secretValues: [canary] });
    assert.throws(
      () => store.createRun({
        runId: canary,
        analysisId: null,
        phase: "running",
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: null,
      }),
      /SECRET_BOUNDARY_VIOLATION/,
    );
    assert.equal(store.getRun(canary), null);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
