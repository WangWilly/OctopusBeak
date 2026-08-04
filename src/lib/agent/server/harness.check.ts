import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentHarnessService,
  createInlineAgentHelper,
  createInMemoryAgentRunStore,
  type AgentHelper,
  type AgentProvider,
} from "./harness.ts";
import {
  APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
  createAppleSystemModelProvider,
  createAppleSystemModelProtocolClient,
  type EmbeddedHelperProcess,
} from "./apple-system-model-provider.ts";
import { createSqliteAgentRunStore } from "./store.ts";

function deterministicAdapter() {
  const completions = new Map<string, () => void>();
  const streams = new Map<string, (content: string) => void>();
  const cancellations: string[] = [];
  const provider: AgentProvider = {
    async activate() {
      return {
        availability: "available",
        providerIdentity: "deterministic.no-tool-provider",
        osBuild: "deterministic",
      };
    },
    start({ runId, onStream, onComplete }) {
      streams.set(runId, onStream);
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
    stream(runId: string, content: string) {
      streams.get(runId)?.(content);
    },
    cancellations,
  };
}

test("a helper crash is terminal, ordinary activation cannot replace it, and Start new run performs the replacement handshake", async () => {
  let helperLaunches = 0;
  let crashed = false;
  let replacementActivations = 0;
  const provider: AgentProvider = {
    async activate({ userStartedNewRun = false } = {}) {
      if (crashed && !userStartedNewRun) {
        throw new Error("Apple system model helper replacement requires starting a new run.");
      }
      if (userStartedNewRun) replacementActivations += 1;
      return {
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      };
    },
    start() {},
    cancel() {},
  };
  const service = createAgentHarnessService({
    helper: {
      launch(input) {
        helperLaunches += 1;
        if (!crashed) {
          crashed = true;
          input.onFailure(new Error("helper-launch-failed"));
        }
      },
      cancel() {},
    },
    provider,
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    idFactory: (() => { let n = 0; return () => `crash-run-${++n}`; })(),
  });

  await service.activate();
  const failed = service.start({ prompt: "Crash this run." });
  assert.equal(service.status(failed.runId).phase, "failed");
  await assert.rejects(service.activate(), /replacement requires starting a new run/);
  assert.equal(helperLaunches, 1);

  const replacement = await service.startNewRun({ prompt: "Start a clean run." });
  assert.equal(replacement.phase, "running");
  assert.equal(helperLaunches, 2);
  assert.equal(replacementActivations, 1);
});

test("a synchronous helper start write failure terminals once, ignores late output, and permits a clean new run", async () => {
  let launches = 0;
  const firstListener = { value: null as ((line: string) => void) | null };
  let firstTerminates = 0;
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => {
      launches += 1;
      const currentLaunch = launches;
      let listener: ((line: string) => void) | null = null;
      return {
        onLine(nextListener) {
          listener = nextListener;
          if (currentLaunch === 1) firstListener.value = nextListener;
          queueMicrotask(() => listener?.(JSON.stringify({
            protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
            type: "handshake",
            helperVersion: "1",
          })));
          return () => { listener = null; };
        },
        onExit() { return () => {}; },
        writeLine(line) {
          const request = JSON.parse(line) as { type: string; requestId?: string; runId?: string };
          if (request.type === "activate") {
            queueMicrotask(() => listener?.(JSON.stringify({
              protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
              type: "activation",
              requestId: request.requestId,
              availability: "available",
              providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
              osBuild: "25C56",
            })));
            return;
          }
          if (currentLaunch === 1) throw new Error("synchronous start write failure");
          queueMicrotask(() => listener?.(JSON.stringify({
            protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
            type: "complete",
            runId: request.runId,
          })));
        },
        terminate() {
          if (currentLaunch === 1) firstTerminates += 1;
        },
      } satisfies EmbeddedHelperProcess;
    },
    requestIdFactory: (() => { let n = 0; return () => `write-failure-${++n}`; })(),
    runFirstResponseTimeoutMs: 10,
    runIdleTimeoutMs: 10,
  });
  const service = createAgentHarnessService({
    helper: createInlineAgentHelper(),
    provider: createAppleSystemModelProvider({ client, hostOsBuild: () => "25C56" }),
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    idFactory: (() => { let n = 0; return () => `write-run-${++n}`; })(),
  });

  await service.activate();
  assert.throws(() => service.start({ prompt: "Must fail once." }), /Agent helper launch failed/);
  assert.equal(service.status("write-run-1").phase, "failed");
  assert.equal(firstTerminates, 1);
  firstListener.value?.(JSON.stringify({
    protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
    type: "stream",
    runId: "write-run-1",
    content: "late output",
  }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(firstTerminates, 1);
  assert.equal(service.lineage("write-run-1").filter((event) => event.kind === "run.failed").length, 1);

  const replacement = await service.startNewRun({ prompt: "A clean replacement." });
  assert.equal(launches, 2);
  assert.equal(replacement.phase, "running");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(service.status(replacement.runId).phase, "completed");
});

test("host-owned harness exposes lifecycle and persists safe lineage", async () => {
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

  await service.activate();
  const started = service.start({ analysisId: "analysis-1" });
  assert.deepEqual(started, {
    runId: "run-deterministic-1",
    phase: "running",
    action: { type: "cancel" },
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: null,
    output: "",
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

test("host-owned harness activates an available Apple system provider with measured build evidence", async () => {
  const adapter = deterministicAdapter();
  const service = createAgentHarnessService({
    helper: adapter.helper,
    provider: {
      ...adapter.provider,
      async activate() {
        return {
          availability: "available" as const,
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
        };
      },
    },
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    secretValues: [],
  });

  assert.deepEqual(await service.activate(), {
    availability: "available",
    providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
    osBuild: "25C56",
    assurance: "verified-build",
  });
  const started = service.start({ prompt: "Summarize locally." });
  assert.deepEqual(service.lineage(started.runId)[0], {
    runId: started.runId,
    analysisId: null,
    seq: 1,
    kind: "run.started",
    status: "allowed",
    occurredAt: "2026-08-03T00:00:00.000Z",
    dataClasses: [],
    providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
    osBuild: "25C56",
    providerAssurance: "verified-build",
    transitionReason: null,
    secretFields: [],
  });
});

test("host-owned harness does not verify a known build with the wrong provider identity", async () => {
  const adapter = deterministicAdapter();
  const service = createAgentHarnessService({
    helper: adapter.helper,
    provider: {
      ...adapter.provider,
      async activate() {
        return {
          availability: "available" as const,
          providerIdentity: "unexpected.provider",
          osBuild: "25C56",
        };
      },
    },
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    secretValues: [],
  });

  assert.equal((await service.activate()).assurance, "unverified-build");
  const started = service.start({ prompt: "Do not overstate assurance." });
  assert.equal(
    service.lineage(started.runId)[0]?.providerAssurance,
    "unverified-build",
  );
});

test("host-owned harness blocks activation when the Apple system provider is unavailable", async () => {
  const adapter = deterministicAdapter();
  const service = createAgentHarnessService({
    helper: adapter.helper,
    provider: {
      ...adapter.provider,
      async activate() {
        return {
          availability: "unavailable" as const,
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
          reason: "device-not-eligible",
        };
      },
    },
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    secretValues: [],
  });

  await assert.rejects(
    () => service.activate(),
    /Apple system model activation blocked: provider unavailable\./,
  );
});

test("failed reactivation clears previously granted provider authority", async () => {
  const adapter = deterministicAdapter();
  let activationCount = 0;
  const service = createAgentHarnessService({
    helper: adapter.helper,
    provider: {
      ...adapter.provider,
      async activate() {
        activationCount += 1;
        if (activationCount === 1) {
          return {
            availability: "available" as const,
            providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
            osBuild: "25C56",
          };
        }
        return {
          availability: "unavailable" as const,
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
          reason: "provider-became-unavailable",
        };
      },
    },
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    secretValues: [],
  });

  await service.activate();
  await assert.rejects(() => service.activate(), /provider unavailable/);
  assert.throws(
    () => service.start({ prompt: "Must not use stale authority." }),
    /must be activated before starting a run/,
  );
});

test("an older activation cannot restore authority after a newer activation fails", async () => {
  const attempts: Array<(activation: {
    availability: "available" | "unavailable";
    providerIdentity: string;
    osBuild: string;
    reason?: string;
  }) => void> = [];
  const adapter = deterministicAdapter();
  const service = createAgentHarnessService({
    helper: adapter.helper,
    provider: {
      ...adapter.provider,
      activate: () => new Promise((resolve) => attempts.push(resolve)),
    },
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    secretValues: [],
  });

  const olderActivation = service.activate();
  const newerActivation = service.activate();
  attempts[1]?.({
    availability: "unavailable",
    providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
    osBuild: "25C56",
    reason: "provider-became-unavailable",
  });
  await assert.rejects(newerActivation, /provider unavailable/);
  attempts[0]?.({
    availability: "available",
    providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
    osBuild: "25C56",
  });
  await assert.rejects(olderActivation, /activation superseded/);

  assert.throws(
    () => service.start({ prompt: "Must not use superseded authority." }),
    /must be activated before starting a run/,
  );
});

test("host-owned harness blocks activation when the Apple system provider API is incompatible", async () => {
  const adapter = deterministicAdapter();
  const service = createAgentHarnessService({
    helper: adapter.helper,
    provider: {
      ...adapter.provider,
      async activate() {
        return {
          availability: "incompatible" as const,
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "26A100",
          reason: "unsupported-protocol",
        };
      },
    },
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    secretValues: [],
  });

  await assert.rejects(
    () => service.activate(),
    /Apple system model activation blocked: provider API incompatible\./,
  );
});

test("host-owned harness refuses to start a run before provider activation", () => {
  const adapter = deterministicAdapter();
  const service = createAgentHarnessService({
    helper: adapter.helper,
    provider: adapter.provider,
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    secretValues: [],
  });

  assert.throws(
    () => service.start({}),
    /Apple system model must be activated before starting a run\./,
  );
});

test("host-owned harness exposes streamed Apple system model output and completion", async () => {
  const providerRuns: Array<{
    onStream(content: string): void;
    onComplete(): void;
  }> = [];
  const provider = {
    async activate() {
      return {
        availability: "available" as const,
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      };
    },
    start(input: { onStream(content: string): void; onComplete(): void }) {
      providerRuns.push(input);
    },
    cancel(_runId: string) {},
  };
  const service = createAgentHarnessService({
    helper: {
      launch(input) {
        input.provider.start(input);
      },
      cancel(runId) {
        provider.cancel(runId);
      },
    },
    provider,
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    idFactory: () => "run-streamed-1",
    secretValues: [],
  });
  await service.activate();

  const started = service.start({ prompt: "Explain local model privacy." });
  const providerRun = providerRuns[0];
  assert.ok(providerRun);
  providerRun.onStream("First");
  assert.equal(service.status(started.runId).output, "First");
  providerRun.onStream("First response");
  assert.equal(service.status(started.runId).output, "First response");
  providerRun.onComplete();

  assert.equal(service.status(started.runId).phase, "completed");
});

test("stream callbacks use in-memory lifecycle state and ignore late chunks after terminalization", async () => {
  const adapter = deterministicAdapter();
  const baseStore = createInMemoryAgentRunStore();
  let getRunCalls = 0;
  const runStore = {
    createRun: baseStore.createRun,
    getRun(runId: string) {
      getRunCalls += 1;
      return baseStore.getRun(runId);
    },
    updateRun: baseStore.updateRun,
    appendLineage: baseStore.appendLineage,
    getLineage: baseStore.getLineage,
  };
  const service = createAgentHarnessService({
    helper: adapter.helper,
    provider: adapter.provider,
    runStore,
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    idFactory: () => "run-in-memory-stream-state",
  });

  await service.activate();
  const started = service.start({ prompt: "Use in-memory lifecycle state." });
  const callsAfterStart = getRunCalls;
  adapter.stream(started.runId, "first chunk");
  adapter.stream(started.runId, "second chunk");
  assert.equal(getRunCalls, callsAfterStart);
  assert.equal(service.status(started.runId).output, "second chunk");

  adapter.complete(started.runId);
  const callsAfterComplete = getRunCalls;
  adapter.stream(started.runId, "late chunk");
  assert.equal(getRunCalls, callsAfterComplete);
  assert.equal(service.status(started.runId).phase, "completed");
  assert.equal(service.status(started.runId).output, "second chunk");
});

test("host-owned harness records a bounded provider failure transition reason", async () => {
  const failure = {
    callback: null as ((error: Error) => void) | null,
  };
  const diagnostics: unknown[] = [];
  const provider: AgentProvider = {
    async activate() {
      return {
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      };
    },
    start({ onFailure }) {
      failure.callback = onFailure;
    },
    cancel() {},
  };
  const service = createAgentHarnessService({
    helper: {
      launch(input) {
        input.provider.start(input);
      },
      cancel() {},
    },
    provider,
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record: (event) => diagnostics.push(event) },
    secretValues: [],
  });
  await service.activate();

  const started = service.start({ prompt: "Explain rate limits." });
  failure.callback?.(new Error("provider-rate-limited"));

  assert.equal(service.status(started.runId).phase, "failed");
  assert.equal(
    service.lineage(started.runId).at(-1)?.transitionReason,
    "provider-rate-limited",
  );
  assert.equal(
    (diagnostics.at(-1) as { transitionReason?: string }).transitionReason,
    "provider-rate-limited",
  );
});

test("host-owned harness makes a failed Apple cancellation terminal before a retry", async () => {
  let listener: ((line: string) => void) | null = null;
  const helperProcess: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { type: string; requestId?: string };
      if (request.type === "activate") {
        queueMicrotask(() => listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: request.requestId,
          availability: "available",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
        })));
      }
      if (request.type === "cancel") throw new Error("write EPIPE");
    },
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => helperProcess,
    requestIdFactory: () => "activation-cancel-epipe",
  });
  let nextRun = 0;
  const service = createAgentHarnessService({
    helper: createInlineAgentHelper(),
    provider: createAppleSystemModelProvider({ client, hostOsBuild: () => "25C56" }),
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    idFactory: () => `run-cancel-epipe-${++nextRun}`,
    secretValues: [],
  });
  await service.activate();
  const started = service.start({ prompt: "Keep this run pending." });

  assert.throws(() => service.cancel(started.runId), /Agent cancellation failed/);
  assert.equal(service.status(started.runId).phase, "failed");
  assert.equal(service.lineage(started.runId).at(-1)?.transitionReason, "provider-failed");
  assert.throws(() => service.start({ prompt: "A retry must not pretend to start." }), /Agent helper launch failed/);
  assert.equal(service.status("run-cancel-epipe-2").phase, "failed");
});

test("lineage survives a run-store reopen through the public service", async () => {
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

    await service.activate();
    const started = service.start({ analysisId: "analysis-persisted-1" });
    adapter.stream(started.runId, "Persisted local model answer.");
    adapter.complete(started.runId);
    assert.deepEqual(service.lineage(started.runId).map((event) => event.kind), [
      "run.started",
      "run.completed",
    ]);
    assert.equal(
      service.lineage(started.runId)[0]?.providerIdentity,
      "deterministic.no-tool-provider",
    );
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
    assert.equal(
      reopenedService.status(started.runId).output,
      "Persisted local model answer.",
    );
    assert.deepEqual(reopenedService.lineage(started.runId).map((event) => event.kind), [
      "run.started",
      "run.completed",
    ]);
    assert.equal(
      reopenedService.lineage(started.runId)[0]?.providerIdentity,
      "deterministic.no-tool-provider",
    );
    assert.equal(reopenedService.lineage(started.runId)[0]?.analysisId, "analysis-persisted-1");
    reopenedStore.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret boundary fails closed before agent persistence and diagnostics", async () => {
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

  await service.activate();
  assert.throws(() => service.start({}), /SECRET_BOUNDARY_VIOLATION/);
  assert.equal(runStore.getRun(canary), null);
  assert.equal(JSON.stringify(diagnostics).includes(canary), false);
});

for (const [label, cancel] of [
  ["cancels the helper", () => {}],
  ["still fails closed when helper cancellation throws", () => { throw new Error("cancel failure"); }],
] as const) {
  test(`a secret-bearing stream ${label} without retaining the secret`, async () => {
    const canary = "agent-harness-stream-secret-canary";
    const runStore = createInMemoryAgentRunStore();
    const diagnostics: unknown[] = [];
    const adapter = deterministicAdapter();
    const cancelled: string[] = [];
    const service = createAgentHarnessService({
      helper: {
        launch: adapter.helper.launch,
        cancel(runId) {
          cancelled.push(runId);
          cancel();
        },
      },
      provider: adapter.provider,
      runStore,
      toolGateway: { execute: () => ({ status: "rejected" }) },
      clock: { now: () => "2026-08-03T00:00:00.000Z" },
      diagnosticsSink: { record: (event) => diagnostics.push(event) },
      idFactory: () => `run-stream-secret-${label}`,
      secretValues: [canary],
    });

    await service.activate();
    const started = service.start({ prompt: "Do not retain secret-bearing output." });
    adapter.stream(started.runId, `Generated output includes ${canary}.`);
    adapter.complete(started.runId);

    assert.deepEqual(cancelled, [started.runId]);
    assert.equal(service.status(started.runId).phase, "failed");
    assert.equal(service.status(started.runId).output.includes(canary), false);
    assert.equal(runStore.getRun(started.runId)?.output.includes(canary), false);
    assert.equal(service.lineage(started.runId).at(-1)?.transitionReason, "secret-boundary-violation");
    assert.equal(JSON.stringify(diagnostics).includes(canary), false);
  });
}

test("a secret-bearing stream remains failed when synchronous helper cancellation completes the run", async () => {
  const canary = "agent-harness-reentrant-stream-secret-canary";
  const runStore = createInMemoryAgentRunStore();
  const diagnostics: unknown[] = [];
  const adapter = deterministicAdapter();
  const cancelled: string[] = [];
  const service = createAgentHarnessService({
    helper: {
      launch: adapter.helper.launch,
      cancel(runId) {
        cancelled.push(runId);
        adapter.complete(runId);
      },
    },
    provider: adapter.provider,
    runStore,
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record: (event) => diagnostics.push(event) },
    idFactory: () => "run-reentrant-stream-secret",
    secretValues: [canary],
  });

  await service.activate();
  const started = service.start({ prompt: "Do not retain secret-bearing output." });
  adapter.stream(started.runId, `Generated output includes ${canary}.`);

  assert.deepEqual(cancelled, [started.runId]);
  assert.equal(service.status(started.runId).phase, "failed");
  assert.equal(service.status(started.runId).output.includes(canary), false);
  assert.equal(runStore.getRun(started.runId)?.output.includes(canary), false);
  assert.equal(service.lineage(started.runId).at(-1)?.transitionReason, "secret-boundary-violation");
  assert.equal(JSON.stringify(diagnostics).includes(canary), false);
});

test("secret boundary rejects an Authentication canary before provider prompt projection", async () => {
  const canary = "agent-provider-prompt-secret-canary";
  let providerStarts = 0;
  const adapter = deterministicAdapter();
  const service = createAgentHarnessService({
    helper: adapter.helper,
    provider: {
      ...adapter.provider,
      start() {
        providerStarts += 1;
      },
    },
    runStore: createInMemoryAgentRunStore(),
    toolGateway: { execute: () => ({ status: "rejected" }) },
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    secretValues: [canary],
  });

  await service.activate();
  assert.throws(
    () => service.start({ prompt: `Never forward ${canary}` }),
    /SECRET_BOUNDARY_VIOLATION/,
  );
  assert.equal(providerStarts, 0);
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
        output: "",
        failureReason: null,
      }),
      /SECRET_BOUNDARY_VIOLATION/,
    );
    assert.equal(store.getRun(canary), null);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
