import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerOptions } from "node:worker_threads";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import {
  createPGliteFinancialRpcClient,
  createPGliteFinancialLocalPort,
  createPGliteFinancialRpcServer,
  type PGliteFinancialRegistry,
} from "../../../../electron/pglite-financial-registry.ts";
import type { AppWorkflowWorkerHandle } from "./app-workflow-worker-supervisor.ts";
import type { AppWorkflowWorkerInboundFrame, AppWorkflowWorkerStart } from "./app-workflow-worker-protocol.ts";
import {
  collectionScopeAdmitsCommit,
  collectionScopeFingerprint,
  launchedCollectionScope,
} from "./collection-scope.ts";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";
import { createAutomationRunner } from "./runner.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import { automationConfigEnv } from "./config-files.ts";
import { CHECK_PGLITE_RPC, executeTaskRunForCheck } from "./task-run-check-support.ts";
import { taskById } from "./tasks.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { executePGliteWorkflowRun, type PGliteWorkflowRunItem } from "../../../ledger/pglite/workflow-run.ts";
import type { PGliteWorkflowClient, PGliteWorkflowCommand } from "../../../ledger/pglite/workflow-client.ts";
import { recordedFinancialCommitPort, type CommitAttemptReport } from "../commit-attempt.ts";

const fubon = taskById("fubon-all-statements")!;
const key = (...parts: string[]) => ["LIBRETTO", "CLOUD", "FUBON", ...parts].join("_");

const launchSettings = {
  [key("ENABLED")]: "true",
  [key("STATEMENT_TYPES")]: "deposit,credit_card",
  SYSTEM_TIMEZONE: "Asia/Taipei",
  EXCHANGE_RATE_UPDATE_TIME: "09:00",
};
const launchCredentials = {
  [key("USER_ID")]: "synthetic-user-id",
  [key("ACCOUNT")]: "synthetic-account",
  [key("PASSWORD")]: "synthetic-password",
};

test("the fingerprint ignores secrets, schedules, and presentation but tracks selection, enablement, and identity", () => {
  const launch = { ...launchSettings, ...launchCredentials };
  const fingerprint = collectionScopeFingerprint(fubon, launch);
  const same = (changes: Record<string, string>) =>
    collectionScopeFingerprint(fubon, { ...launch, ...changes }) === fingerprint;

  assert.ok(same({ [key("PASSWORD")]: "rotated-password" }));
  assert.ok(same({ [key("ACCOUNT")]: "rotated-account" }));
  assert.ok(same({ EXCHANGE_RATE_UPDATE_TIME: "18:30", SYSTEM_TIMEZONE: "UTC" }));
  assert.ok(same({ [key("STATEMENT_TYPES")]: "credit_card, deposit" }));
  assert.ok(!same({ [key("STATEMENT_TYPES")]: "deposit" }));
  assert.ok(!same({ [key("ENABLED")]: "false" }));
  assert.ok(!same({ [key("USER_ID")]: "another-user-id" }));
  assert.doesNotMatch(fingerprint, /synthetic/u);
});

test("commit admission goes through the runner's active run to its current execution's launched scope", async () => {
  const store = new PGliteStore(await createTestPGlite("operational"));
  const provider = { ...createPgliteOperationalProvider(store), pgliteWorkflow: CHECK_PGLITE_RPC };
  const runner = createAutomationRunner({ runtime: createAutomationRuntimeState() });
  const launch: Record<string, string> = { ...launchSettings, ...launchCredentials };
  const changed = { ...launch, [key("STATEMENT_TYPES")]: "deposit" };
  let current = launch;
  const admits = (taskRunId: string) => collectionScopeAdmitsCommit(runner.activeRun(taskRunId), () => current);
  const observed: Record<string, boolean> = {};
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  try {
    const { runId } = await runner.start("exchange-rates", provider, {
      onFinished: () => finished(),
      runExecution: async (_task, run) => {
        await run.transition("running");
        observed.beforeExecution = admits(run.taskRunId);
        const first = run.beginExecution("round-1", { collectionScope: launchedCollectionScope(fubon, launch) });
        observed.unchanged = admits(run.taskRunId);
        current = changed;
        observed.changed = admits(run.taskRunId);
        current = launch;
        observed.reverted = admits(run.taskRunId);
        first.end();
        observed.afterEnd = admits(run.taskRunId);
        assert.equal(first.collectionScope(), null);
        const second = run.beginExecution("round-2", { collectionScope: launchedCollectionScope(fubon, launch) });
        observed.secondExecution = admits(run.taskRunId);
        current = changed;
        observed.secondChanged = admits(run.taskRunId);
        second.end();
        return { summary: null, failure: null };
      },
    });
    await done;
    assert.deepEqual(observed, {
      beforeExecution: true,
      unchanged: true,
      changed: false,
      reverted: false,
      afterEnd: true,
      secondExecution: true,
      secondChanged: false,
    });
    assert.equal(runner.activeRun(runId), null, "a finished run is no longer active");
    assert.equal(admits(runId), true);
    assert.equal(runner.activeRun("no-such-run"), null);
    assert.equal(admits("no-such-run"), true);
  } finally {
    await store.close();
  }
});

type Listener = (value: unknown) => void;

class MemoryPort {
  peer: MemoryPort | undefined;
  readonly listeners = new Set<Listener>();
  on(_event: "message", listener: Listener) { this.listeners.add(listener); }
  off(_event: "message", listener: Listener) { this.listeners.delete(listener); }
  postMessage(value: unknown) {
    const peer = this.peer!;
    const copy = structuredClone(value);
    queueMicrotask(() => { for (const listener of peer.listeners) listener(copy); });
  }
}

function memoryPair() {
  const left = new MemoryPort();
  const right = new MemoryPort();
  left.peer = right;
  right.peer = left;
  return [left, right] as const;
}

test("an admission check that throws fails the write without calling it refused", async () => {
  const ports = memoryPair();
  let reached = 0;
  const server = createPGliteFinancialRpcServer(
    ports[1],
    createPGliteFinancialLocalPort({
      "financial.deposit.commit": async () => { reached += 1; return { captureId: "capture", commitSequence: 1 }; },
    } as unknown as PGliteFinancialRegistry),
    () => { throw new SyntaxError("settings file is not JSON"); },
  );
  const client = createPGliteFinancialRpcClient(ports[0], undefined, { workflowId: "fubon-all-statements", taskRunId: "run-unreadable" });
  try {
    await assert.rejects(
      client.request("financial.deposit.commit", [{ capture: {} } as never]),
      (error: unknown) => (error as { category?: string }).category === "fatal",
    );
    assert.equal(reached, 0);
  } finally {
    client.close();
    await server.close();
  }
});

class CommittingFakeWorker extends EventEmitter implements AppWorkflowWorkerHandle {
  readonly stdout = null;
  readonly stderr = null;
  readonly workerData: WorkerOptions["workerData"];
  private readonly registry: PGliteFinancialRegistry;
  private readonly run: ActiveAutomationTaskRun;
  private readonly editSettings: () => Promise<void>;
  constructor(
    workerData: WorkerOptions["workerData"],
    registry: PGliteFinancialRegistry,
    run: ActiveAutomationTaskRun,
    editSettings: () => Promise<void>,
  ) {
    super();
    this.workerData = workerData;
    this.registry = registry;
    this.run = run;
    this.editSettings = editSettings;
    setImmediate(() => this.emit("online"));
    void this.work();
  }
  private readonly acks = new Map<string, () => void>();
  private nextEventId = 0;
  private async record(attempt: CommitAttemptReport) {
    const eventId = `attempt-event-${this.nextEventId += 1}`;
    const acked = new Promise<void>((resolve) => this.acks.set(eventId, resolve));
    this.emit("message", { protocolVersion: 2, kind: "commit-attempt", eventId, attempt });
    await acked;
  }
  private async work() {
    // Report nothing before the supervisor has seen the worker come online.
    await new Promise((resolve) => setImmediate(resolve));
    const start = this.workerData as AppWorkflowWorkerStart;
    const ports = memoryPair();
    const server = createPGliteFinancialRpcServer(
      ports[1],
      createPGliteFinancialLocalPort(this.registry),
      ({ taskRunId }) => collectionScopeAdmitsCommit(taskRunId === this.run.taskRunId ? this.run : null),
    );
    const client = createPGliteFinancialRpcClient(ports[0], undefined, {
      workflowId: start.workflowId,
      taskRunId: start.taskRunId,
    });
    const workflowClient = {
      commit: (command: PGliteWorkflowCommand) => client.request(command.kind as never, [command.request] as never),
    } as unknown as PGliteWorkflowClient;
    const port = recordedFinancialCommitPort({
      commit: { execute: (items) => executePGliteWorkflowRun({ client: workflowClient, items }) },
      attempts: { record: (attempt) => this.record(attempt) },
      event: async () => {},
    });
    const item = (product: string): PGliteWorkflowRunItem => ({
      provider: "fubon",
      product,
      itemKey: `${product}-item`,
      command: { kind: "financial.deposit.commit", request: { capture: {} } } as unknown as PGliteWorkflowCommand,
    });
    await port.execute([item("deposit")], { product: "deposit" });
    await this.editSettings();
    const second = (await port.execute([item("credit_card")], { product: "credit_card" })).status === "completed";
    client.close();
    await server.close();
    // The worker's own code is generic; only the refused Commit attempt can name the cause.
    this.emit("message", second
      ? {
        protocolVersion: 2,
        kind: "completed",
        taskRunId: start.taskRunId,
        summary: { status: "financial-admitted", counts: { committedCount: 2, itemCount: 2 } },
      }
      : {
        protocolVersion: 2,
        kind: "failed",
        taskRunId: start.taskRunId,
        errorCode: "workflow-failed",
        summary: { status: "partial", counts: { committedCount: 1, itemCount: 2 }, products: [
          { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 },
          { typeId: "credit_card", status: "failed", itemCount: 1, committedCount: 0, errorCode: "collection-scope-changed" },
        ] },
      });
    this.emit("exit", second ? 0 : 1);
  }
  postMessage(frame: AppWorkflowWorkerInboundFrame) {
    if (frame.kind !== "event-ack") return;
    this.acks.get(frame.eventId)?.();
    this.acks.delete(frame.eventId);
  }
  terminate() {
    setImmediate(() => this.emit("exit", 1));
    return Promise.resolve(1);
  }
}

async function runWithMidRunEdit(edit: { settings?: Record<string, string>; credentials?: Record<string, string> }) {
  const root = await mkdtemp(join(tmpdir(), "collection-scope-"));
  const previousDirectory = process.cwd();
  const store = new PGliteStore(await createTestPGlite("operational"));
  const writeConfig = async (settings: Record<string, string>, credentials: Record<string, string>) => {
    await writeFile(join(root, "settings.json"), JSON.stringify(settings));
    await writeFile(join(root, "credentials.json"), JSON.stringify(credentials));
  };
  let commits = 0;
  const registry = {
    "financial.deposit.commit": async () => {
      commits += 1;
      return { captureId: `capture-${commits}`, commitSequence: commits };
    },
  } as unknown as PGliteFinancialRegistry;
  try {
    process.chdir(root);
    await writeConfig(launchSettings, launchCredentials);
    const provider = createPgliteOperationalProvider(store);
    const { taskRunId } = await provider.automation.createTaskRun({
      taskId: fubon.id,
      kind: fubon.kind,
      status: "preparing",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    let activeRun: ActiveAutomationTaskRun | undefined;
    const result = await executeTaskRunForCheck(fubon, provider.automation, {
      taskRunId,
      onRunOpened: (run) => { activeRun = run; },
      pgliteRpc: CHECK_PGLITE_RPC,
      launchEnv: {
        ...automationConfigEnv({ baseEnv: {} }),
      },
      workflowBrowserPortFactory: () => ({
        async withPage(run) { return await run({} as never); },
      }),
      appWorkflowBrowserConnectionForRun: (runId) => ({
        endpoint: "http://127.0.0.1:43121",
        targetId: `host-page-${runId}`,
      }),
      appWorkflowWorkerFactory: (_path, options) => new CommittingFakeWorker(
        options.workerData,
        registry,
        activeRun!,
        () => writeConfig(
          { ...launchSettings, ...edit.settings },
          { ...launchCredentials, ...edit.credentials },
        ),
      ),
    });
    const run = await provider.automation.taskRunById(taskRunId);
    const attempts = (await provider.automation.commitAttempts(taskRunId)).map((attempt) => attempt.outcome);
    return { result, run, commits, attempts };
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("changing the Statement Selection mid-run refuses the next commit and ends the run as collection-scope-changed", async () => {
  const { result, run, commits, attempts } = await runWithMidRunEdit({
    settings: { [key("STATEMENT_TYPES")]: "deposit" },
  });
  assert.equal(commits, 1, "the commit after the edit never reached the registry");
  assert.deepEqual(attempts, ["completed", "refused"]);
  assert.equal(result.status, "failed");
  assert.equal(run?.appWorkflowOutcome?.errorCode, "collection-scope-changed");
  assert.deepEqual(
    run?.appWorkflowOutcome?.summary?.products?.map((product) => [product.typeId, product.status, product.errorCode]),
    [["deposit", "success", undefined], ["credit_card", "failed", "collection-scope-changed"]],
  );
});

test("changing only the password mid-run commits normally", async () => {
  const { result, run, commits } = await runWithMidRunEdit({
    credentials: { [key("PASSWORD")]: "rotated-password" },
  });
  assert.equal(commits, 2);
  assert.equal(result.status, "completed");
  assert.equal(run?.appWorkflowOutcome?.errorCode, null);
});

test("unchanged settings commit normally", async () => {
  const { result, run, commits } = await runWithMidRunEdit({});
  assert.equal(commits, 2);
  assert.equal(result.status, "completed");
  assert.equal(run?.appWorkflowOutcome?.errorCode, null);
});
