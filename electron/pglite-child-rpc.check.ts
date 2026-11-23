import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { Worker } from "node:worker_threads";
import test from "node:test";
import {
  createPGliteChildRpcClient,
  createPGliteChildRpcServer,
  type PGliteChildProvider,
} from "./pglite-child-rpc.ts";
import { createPGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import { PGliteFinancialError } from "../src/lib/pglite-rpc/pglite-financial-rpc-client.ts";
import {
  PGLITE_OPERATIONAL_OPERATIONS,
  PGliteOperationalError,
  WORKFLOW_OPERATIONAL_OPERATIONS,
} from "../src/lib/pglite-rpc/pglite-operational-rpc.ts";
import { WORKFLOW_FINANCIAL_OPERATIONS } from "../src/lib/pglite-rpc/pglite-financial-contracts.ts";
import * as PGLITE_WORKFLOW_COMMANDS from "../src/ledger/pglite/workflow-commands.ts";

function providerForWorker(client: ReturnType<typeof createPGliteViewWorkerClient>): PGliteChildProvider {
  return {
    operational: {
      ...client.operationalProvider,
      exchangeRates: client.operationalProvider.exchangeRates,
    },
    financial: client.financial,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for child RPC fixture state.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("child RPC preserves UTF-8 characters split across socket chunks", async () => {
  const label = "全家便利商店";
  let received: string | undefined;
  const provider = {
    operational: { exchangeRates: { readExchangeRates: async (currencies: string[]) => {
      received = currencies[0];
      return [];
    } } },
    financial: {},
  } as unknown as PGliteChildProvider;
  const server = createPGliteChildRpcServer({ provider });
  await server.ready;
  const socket = createConnection(server.endpoint);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(JSON.stringify({
      kind: "pglite-child-auth", version: 1, token: server.token,
    }) + "\n");
    await new Promise<void>((resolve, reject) => {
      socket.once("data", () => resolve());
      socket.once("error", reject);
    });
    const frame = Buffer.from(JSON.stringify({
      kind: "pglite-operational-request", version: 1, id: 1,
      operation: "exchangeRates.readExchangeRates", args: [[label]],
    }) + "\n");
    const split = frame.indexOf(Buffer.from("家")) + 1;
    assert(split > 0);
    socket.write(frame.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.write(frame.subarray(split));
    await waitFor(() => received !== undefined);
    assert.equal(received, label);
  } finally {
    socket.destroy();
    await server.close();
  }

  const directory = await mkdtemp(join(tmpdir(), "octopus-beak-utf8-rpc-"));
  const endpoint = join(directory, "rpc.sock");
  const rawServer = createServer((peer) => {
    let buffer = "";
    peer.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline)) as { kind: string; id?: number };
        buffer = buffer.slice(newline + 1);
        if (frame.kind === "pglite-child-auth") {
          peer.write(JSON.stringify({ kind: "pglite-child-auth-response", version: 1, ok: true }) + "\n");
        } else {
          const reply = Buffer.from(JSON.stringify({
            kind: "pglite-operational-response", version: 1,
            id: frame.id, ok: true, value: { label },
          }) + "\n");
          const split = reply.indexOf(Buffer.from("家")) + 1;
          peer.write(reply.subarray(0, split));
          setTimeout(() => peer.write(reply.subarray(split)), 20);
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve) => rawServer.listen(endpoint, resolve));
  const child = createPGliteChildRpcClient({ endpoint, token: "A".repeat(43) });
  try {
    await child.ready;
    const value = await child.operationalProvider.automation.taskRunById("fixture");
    assert.equal((value as unknown as { label: string }).label, label);
  } finally {
    child.close();
    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("authenticated child RPC reaches the same worker named registries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-pglite-child-rpc-"));
  const worker = new Worker(new URL("./pglite-view-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: { dataDir, settingsPath: join(dataDir, "settings.json") },
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
    await child.operationalProvider.exchangeRates.upsertExchangeRates([{
      rateDate: "2026-09-22",
      currency: "USD",
      twdPerUnit: 32.5,
      source: "synthetic",
      fetchedAt: "2026-09-22T00:00:00.000Z",
    }]);
    assert.deepEqual(
      (await child.operationalProvider.exchangeRates.readExchangeRates(["USD"])).map((row) => row.twdPerUnit),
      [32.5],
    );
    assert.equal((await child.financial.request("financial.overview.current", [])).availability, "empty");
    const unresolvedFunding = await child.workflow.commit({
      kind: "financial.investmentRelations.resolve",
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

test("the child socket refuses every operation not marked for workflows", async () => {
  const reached: string[] = [];
  const operational = Object.fromEntries(
    [...new Set(PGLITE_OPERATIONAL_OPERATIONS.map((operation) => operation.split(".")[0]!))].map((domain) => [
      domain,
      new Proxy({}, {
        get: (_target, method) => async () => {
          reached.push(`${domain}.${String(method)}`);
          return null;
        },
      }),
    ]),
  );
  const provider = {
    operational,
    financial: {
      request: async (operation: string) => {
        reached.push(operation);
        return null;
      },
    },
  } as unknown as PGliteChildProvider;
  const server = createPGliteChildRpcServer({ provider, isCommitAdmissible: () => true });
  const child = createPGliteChildRpcClient({ endpoint: server.endpoint, token: server.token });
  try {
    await server.ready;
    await child.ready;
    const refusedFinancial = [
      ["financial.canonical.reset", []],
      ["financial.manualAssets.apply", [{ kind: "synthetic" }]],
      ["financial.pageAction", [{ kind: "synthetic" }]],
      ["financial.spending.current", []],
      ["financial.loanRelations.current", []],
    ] as const;
    for (const [operation, args] of refusedFinancial) {
      await assert.rejects(
        child.request(operation, args),
        (error: unknown) => error instanceof PGliteFinancialError && error.code === "not-allowed",
        `${operation} must not be open to workflows`,
      );
    }
    const refusedOperational = [
      ["automation.taskRunById", ["run"]],
      ["automation.transitionTaskRunToTerminal", ["run", { status: "succeeded" }]],
      ["automation.recordCommitAttempt", ["run", {}]],
      ["preview.deleteAll", []],
      ["preview.accounts", [{ visible: [] }]],
    ] as const;
    for (const [operation, args] of refusedOperational) {
      await assert.rejects(
        child.request(operation, args),
        (error: unknown) => error instanceof PGliteOperationalError && error.code === "not-allowed",
        `${operation} must not be open to workflows`,
      );
    }
    assert.deepEqual(reached, [], "a refused operation never reaches the worker");
    await child.request("financial.overview.current", []);
    await child.request("exchangeRates.readExchangeRates", []);
    assert.deepEqual(reached, ["financial.overview.current", "exchangeRates.readExchangeRates"]);
  } finally {
    child.close();
    await server.close();
  }
});

test("the workflow surface is exactly what workflows call", () => {
  assert.deepEqual([...WORKFLOW_FINANCIAL_OPERATIONS].sort(), [
    "financial.accountIdentity.continuity",
    "financial.balance.capture",
    "financial.creditCard.balance",
    "financial.creditCard.commit",
    "financial.deposit.commit",
    "financial.einvoice.commit",
    "financial.investment.commit",
    "financial.investmentRelations.resolve",
    "financial.loan.commit",
    "financial.loanRelations.resolve",
    "financial.overview.current",
    "financial.source.admit",
    "financial.source.commit",
    "financial.tdccFundAccounts.list",
  ]);
  assert.deepEqual([...WORKFLOW_OPERATIONAL_OPERATIONS].sort(), [
    "exchangeRates.readExchangeRates",
    "exchangeRates.upsertExchangeRates",
    "maicoin.appendSnapshots",
    "maicoin.appendStatementRows",
    "maicoin.finishRun",
    "maicoin.startRun",
    "preview.write",
  ]);
  for (const kind of Object.values(PGLITE_WORKFLOW_COMMANDS)) {
    assert.ok(WORKFLOW_FINANCIAL_OPERATIONS.has(kind), `workflow command ${kind} must be open to workflows`);
  }
});

test("child RPC retains a worker admission category across both hops", async () => {
  const provider = {
    operational: {},
    financial: {
      request: async () => { throw new PGliteFinancialError("operation-failed", "admission"); },
    },
  } as unknown as PGliteChildProvider;
  const server = createPGliteChildRpcServer({ provider });
  const child = createPGliteChildRpcClient({ endpoint: server.endpoint, token: server.token });
  try {
    await server.ready;
    await child.ready;
    await assert.rejects(
      child.financial.request("financial.overview.current", []),
      (error: unknown) => error instanceof PGliteFinancialError
        && error.code === "operation-failed" && error.category === "admission",
    );
  } finally {
    child.close();
    await server.close();
  }
});

test("child request sends every operational operation on the operational protocol", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octopus-beak-child-routing-"));
  const endpoint = join(directory, "rpc.sock");
  const kinds = new Map<string, string>();
  const rawServer = createServer((peer) => {
    let buffer = "";
    peer.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline)) as { kind: string; id?: number; operation?: string };
        buffer = buffer.slice(newline + 1);
        if (frame.kind === "pglite-child-auth") {
          peer.write(JSON.stringify({ kind: "pglite-child-auth-response", version: 1, ok: true }) + "\n");
        } else if (frame.operation) {
          kinds.set(frame.operation, frame.kind);
          const kind = frame.kind === "pglite-operational-request" ? "pglite-operational-response" : "pglite-financial-response";
          peer.write(JSON.stringify({ kind, version: 1, id: frame.id, ok: true, value: null }) + "\n");
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve) => rawServer.listen(endpoint, resolve));
  const child = createPGliteChildRpcClient({ endpoint, token: "A".repeat(43) });
  try {
    await child.ready;
    await Promise.allSettled(PGLITE_OPERATIONAL_OPERATIONS.map((operation) => child.request(operation, [])));
    assert.deepEqual(
      PGLITE_OPERATIONAL_OPERATIONS.filter((operation) => kinds.get(operation) !== "pglite-operational-request"),
      [],
    );
  } finally {
    child.close();
    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
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
      exchangeRates: {
        readExchangeRates: () => delayed,
      },
    },
    financial: {
      request: async (_operation: unknown, _args: unknown, options?: { signal?: AbortSignal }) => {
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
    const pending = child.operationalProvider.exchangeRates.readExchangeRates();
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
