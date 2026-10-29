import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { createPGliteChildRpcServer } from "../../../../electron/pglite-child-rpc.ts";
import {
  createPGliteFinancialLocalPort,
  createPGliteFinancialRegistry,
} from "../../../../electron/pglite-financial-registry.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { applyPgliteMaicoinOperationalSchema } from "../../../ledger/pglite/maicoin-operational.ts";
import { createPgliteOperationalProvider } from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { planForCheck } from "./task-run-check-support.ts";
import { runAppWorkflowWorker } from "./app-workflow-worker-runtime.ts";
import { APP_WORKFLOW_WORKER_PROTOCOL_VERSION, parseAppWorkflowWorkerOutboundFrame } from "./app-workflow-worker-protocol.ts";
import { taskById } from "./tasks.ts";
import type { WorkflowRunEvent } from "../run-event.ts";

function maxResponse(body: unknown, date = "Wed, 02 Sep 2026 04:05:06 GMT") {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { Date: date },
  });
}

test("MaiCoin worker uses injected financial commit and operational RPC without writing run artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "maicoin-app-execution-"));
  const previousDirectory = process.cwd();
  const database = await createTestPGlite("ledger+operational", { dataDir: join(root, "pglite") });
  const store = new PGliteStore(database);
  await applyPgliteMaicoinOperationalSchema(store);
  const operational = createPgliteOperationalProvider(store);
  const server = createPGliteChildRpcServer({
    provider: { operational, financial: createPGliteFinancialLocalPort(createPGliteFinancialRegistry(store)) },
  });
  const previousFetch = globalThis.fetch;
  const channel = new MessageChannel();
  try {
    await server.ready;
    globalThis.fetch = (async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/v3/info")
        return maxResponse({ email: "owner@example.test", m_wallet_enabled: true });
      if (/^\/api\/v3\/wallet\/(spot|m)\/accounts$/u.test(url.pathname))
        return maxResponse([], "Wed, 02 Sep 2026 04:05:06 GMT");
      if (url.pathname === "/api/v3/markets") return maxResponse([]);
      if (url.pathname.endsWith("/trades")
        || url.pathname.startsWith("/api/v3/fund_transactions/")
        || url.pathname === "/api/v3/rewards"
        || url.pathname === "/api/v3/converts") return maxResponse([]);
      throw new Error(`Unexpected MAX endpoint: ${url.pathname}`);
    }) as typeof fetch;

    const task = taskById("sync-maicoin");
    assert.ok(task);
    assert.equal(Object.hasOwn(task, "command"), false);
    const { taskRunId } = await operational.automation.createTaskRun({
      taskId: task.id,
      kind: task.kind,
      status: "preparing",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    // The runner resolves the plan before it executes a round, so the run never starts.
    assert.throws(() => planForCheck(task, { pgliteRpc: undefined, launchEnv: {} }), /PGlite workflow transport is unavailable/u);
    const unstarted = await operational.automation.taskRunById(taskRunId);
    assert.equal(unstarted?.status, "preparing", "missing transport refuses before the run starts");
    assert.deepEqual(unstarted?.events, []);
    const observedCodes: string[] = [];
    const terminal = new Promise<ReturnType<typeof parseAppWorkflowWorkerOutboundFrame>>((resolve) => {
      channel.port2.on("message", (value: unknown) => {
        const frame = parseAppWorkflowWorkerOutboundFrame(value);
        if (frame.kind === "call" && (frame.method === "event" || frame.method === "commitAttempt")) {
          if (frame.method === "event") observedCodes.push((frame.request as { event: WorkflowRunEvent }).event.code);
          channel.port2.postMessage({
            protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
            kind: "reply",
            callId: frame.callId,
            ok: true,
            result: null,
          });
        } else if (frame.kind === "completed" || frame.kind === "failed" || frame.kind === "cancelled") resolve(frame);
      });
    });
    await runAppWorkflowWorker({
      port: channel.port1,
      workerData: {
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        workflowId: "sync-maicoin",
        taskRunId: "maicoin-worker-run",
        input: {
          credentials: {
            accessKey: "test-access",
            secretKey: "test-secret",
            subAccount: "main",
          },
        },
        pgliteRpc: {
          endpoint: server.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT,
          token: server.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN,
        },
      },
    });
    const result = await terminal;
    assert.equal(result.kind, "completed", JSON.stringify(result));
    assert.deepEqual(observedCodes.slice(-1), ["run-completed"]);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_accounts")).rows[0]?.count, 2);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM maicoin_sync_runs")).rows[0]?.count, 1);
    assert.deepEqual(await readdir(root), ["pglite"], "only the test database remains under its temp root");
  } finally {
    process.chdir(previousDirectory);
    globalThis.fetch = previousFetch;
    channel.port1.close();
    channel.port2.close();
    await server.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
