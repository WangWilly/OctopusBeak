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
  createPGliteFinancialRpcServer,
  type PGliteFinancialRegistry,
} from "../../../../electron/pglite-financial-registry.ts";
import {
  PGLITE_CHILD_RPC_ENDPOINT_ENV,
  PGLITE_CHILD_RPC_TOKEN_ENV,
} from "../../../../electron/pglite-child-rpc-client.ts";
import type { AppWorkflowWorkerHandle } from "./app-workflow-worker-supervisor.ts";
import type { AppWorkflowWorkerInboundFrame, AppWorkflowWorkerStart } from "./app-workflow-worker-protocol.ts";
import {
  assertCollectionScopeCurrent,
  collectionScopeFingerprint,
  registerCollectionScope,
} from "./collection-scope.ts";
import { automationConfigEnv } from "./config-files.ts";
import { executeTaskRunForCheck } from "./task-run-check-support.ts";
import { taskById } from "./tasks.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";

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

test("a refused run stays refused after the setting is reverted, and a released run is no longer gated", () => {
  let current: Record<string, string> = { ...launchSettings, ...launchCredentials };
  const scope = registerCollectionScope("run-sticky", fubon, current);
  assert.doesNotThrow(() => assertCollectionScopeCurrent("run-sticky", () => current));
  current = { ...current, [key("STATEMENT_TYPES")]: "deposit" };
  assert.throws(() => assertCollectionScopeCurrent("run-sticky", () => current), { name: "CollectionScopeChangedError" });
  current = { ...current, [key("STATEMENT_TYPES")]: launchSettings[key("STATEMENT_TYPES")] };
  assert.throws(() => assertCollectionScopeCurrent("run-sticky", () => current), { name: "CollectionScopeChangedError" });
  assert.equal(scope.refused(), true);
  scope.release();
  assert.doesNotThrow(() => assertCollectionScopeCurrent("run-sticky", () => current));
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

class CommittingFakeWorker extends EventEmitter implements AppWorkflowWorkerHandle {
  readonly stdout = null;
  readonly stderr = null;
  readonly workerData: WorkerOptions["workerData"];
  private readonly registry: PGliteFinancialRegistry;
  private readonly editSettings: () => Promise<void>;
  constructor(
    workerData: WorkerOptions["workerData"],
    registry: PGliteFinancialRegistry,
    editSettings: () => Promise<void>,
  ) {
    super();
    this.workerData = workerData;
    this.registry = registry;
    this.editSettings = editSettings;
    setImmediate(() => this.emit("online"));
    void this.run();
  }
  private async run() {
    const start = this.workerData as AppWorkflowWorkerStart;
    const ports = memoryPair();
    const server = createPGliteFinancialRpcServer(
      ports[1],
      this.registry,
      ({ taskRunId }) => assertCollectionScopeCurrent(taskRunId),
    );
    const client = createPGliteFinancialRpcClient(ports[0], undefined, {
      workflowId: start.workflowId,
      taskRunId: start.taskRunId,
    });
    await client.registry.depositCommit({ capture: {} } as never);
    await this.editSettings();
    const second = await client.registry.depositCommit({ capture: {} } as never).then(() => true, () => false);
    client.close();
    await server.close();
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
        errorCode: "commit-outcome-unknown",
        summary: { status: "partial", counts: { committedCount: 1, itemCount: 2 }, products: [
          { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 },
          { typeId: "credit_card", status: "failed", itemCount: 1, committedCount: 0, errorCode: "commit-outcome-unknown" },
        ] },
      });
    this.emit("exit", second ? 0 : 1);
  }
  postMessage(_frame: AppWorkflowWorkerInboundFrame) {}
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
    depositCommit: async () => {
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
    const result = await executeTaskRunForCheck(fubon, provider.automation, {
      taskRunId,
      launchEnv: {
        ...automationConfigEnv({ baseEnv: {} }),
        [PGLITE_CHILD_RPC_ENDPOINT_ENV]: "http://127.0.0.1:43121/rpc",
        [PGLITE_CHILD_RPC_TOKEN_ENV]: "a".repeat(32),
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
        () => writeConfig(
          { ...launchSettings, ...edit.settings },
          { ...launchCredentials, ...edit.credentials },
        ),
      ),
    });
    const run = await provider.automation.taskRunById(taskRunId);
    return { result, run, commits };
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("changing the Statement Selection mid-run refuses the next commit and ends the run as collection-scope-changed", async () => {
  const { result, run, commits } = await runWithMidRunEdit({
    settings: { [key("STATEMENT_TYPES")]: "deposit" },
  });
  assert.equal(commits, 1, "the commit after the edit never reached the registry");
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
