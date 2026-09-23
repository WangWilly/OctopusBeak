import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import {
  createPGliteChildRpcClient,
  createPGliteChildRpcServer,
  type PGliteChildProvider,
} from "./pglite-child-rpc.ts";
import { createPGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import { PGliteFinancialError } from "./pglite-financial-registry.ts";

function providerForWorker(client: ReturnType<typeof createPGliteViewWorkerClient>): PGliteChildProvider {
  return {
    operational: {
      ...client.operationalProvider,
      exchangeRates: client.operationalProvider.exchangeRates,
    },
    financial: client.financial.registry,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for child RPC fixture state.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("authenticated child RPC reaches the same worker named registries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-pglite-child-rpc-"));
  const worker = new Worker(new URL("./pglite-view-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: { dataDir },
  });
  const workerClient = createPGliteViewWorkerClient(worker);
  const server = createPGliteChildRpcServer({ provider: providerForWorker(workerClient) });
  const child = createPGliteChildRpcClient({ endpoint: server.endpoint, token: server.token });
  const badToken = `${server.token.slice(0, -1)}${server.token.endsWith("A") ? "B" : "A"}`;
  const bad = createPGliteChildRpcClient({ endpoint: server.endpoint, token: badToken });
  try {
    await server.ready;
    await child.ready;
    assert.equal(typeof child.workflow.commit, "function");
    const created = await child.operationalProvider.automation.createTaskRun({
      taskId: "exchange-rates",
      script: "run:exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-22T00:00:00.000Z",
      logPath: "data/automation/logs/child-rpc.log",
    });
    assert.equal(
      (await child.operationalProvider.automation.taskRunById(created.taskRunId))?.status,
      "running",
    );
    assert.equal((await child.financial.overviewCurrent()).availability, "empty");
    assert.deepEqual(await child.financial.currentLoanRelations(), []);
    const unresolvedFunding = await child.workflow.commit({
      kind: "canonical.investment-funding-relations.resolve",
      request: {},
    });
    assert.equal(unresolvedFunding.outcome, "unchanged");
    await assert.rejects(
      child.request("SELECT 1" as never, []),
      /Invalid PGlite financial request/u,
    );
    await assert.rejects(bad.ready, /authentication failed|could not connect/u);
  } finally {
    bad.close();
    child.close();
    await server.close();
    await workerClient.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("child RPC retains a worker admission category across both hops", async () => {
  const provider = {
    operational: {},
    financial: {
      overviewCurrent: async () => { throw new PGliteFinancialError("operation-failed", "admission"); },
    },
  } as unknown as PGliteChildProvider;
  const server = createPGliteChildRpcServer({ provider });
  const child = createPGliteChildRpcClient({ endpoint: server.endpoint, token: server.token });
  try {
    await server.ready;
    await child.ready;
    await assert.rejects(
      child.financial.overviewCurrent(),
      (error: unknown) => error instanceof PGliteFinancialError
        && error.code === "operation-failed" && error.category === "admission",
    );
  } finally {
    child.close();
    await server.close();
  }
});

test("missing owner endpoint and child disconnect fail explicitly", async () => {
  assert.throws(
    () => createPGliteChildRpcClient({ environment: {} }),
    /requires the parent worker endpoint/u,
  );

  let release!: () => void;
  const delayed = new Promise<unknown[]>((resolve) => { release = () => resolve([]); });
  let entered = false;
  let cancelled = false;
  const provider = {
    operational: {
      automation: {
        activeTaskRuns: () => delayed,
      },
    },
    financial: {
      sourceCommit: async (_request: unknown, options?: { signal?: AbortSignal }) => {
        entered = true;
        await new Promise<void>((resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            cancelled = true;
            reject(new Error("cancelled"));
          }, { once: true });
        });
        return { captureId: "never", commitSequence: 0, transactions: [] };
      },
    },
  } as unknown as PGliteChildProvider;
  const server = createPGliteChildRpcServer({ provider });
  const child = createPGliteChildRpcClient({ endpoint: server.endpoint, token: server.token });
  try {
    await server.ready;
    await child.ready;
    const controller = new AbortController();
    const pendingWrite = child.request(
      "financial.source.commit",
      [{
        capture: {
          captureId: "cancelled-capture",
          integrationNamespace: "synthetic",
          sourceConnectionKey: "source",
          identityEpoch: "epoch",
          stream: "stream",
          recordKind: "record",
          routeKey: "route",
          contractVersion: "v1",
          subjectDigest: "subject",
          observedAt: "2026-09-22T00:00:00.000Z",
          scope: {},
          pages: [],
          records: [],
        },
        account: {},
        transactions: [],
      }],
      { signal: controller.signal },
    );
    await waitFor(() => entered);
    controller.abort();
    await assert.rejects(pendingWrite, /cancelled/u);
    await waitFor(() => cancelled);
    assert.equal(cancelled, true, "socket cancellation must reach the in-flight worker command");
    const pending = child.operationalProvider.automation.activeTaskRuns();
    child.close();
    await assert.rejects(pending, /closed/u);
    release();
  } finally {
    // The operational fixture deliberately blocks until released.  Always
    // release it before closing the server, including assertion failures, so
    // the server's active-request drain cannot keep the test process alive.
    release();
    child.close();
    await server.close();
  }
});
