import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPGliteFinancialRpcClient,
  createPGliteFinancialRpcServer,
  type PGliteFinancialRegistry,
} from "./pglite-financial-registry.ts";
import {
  createPGliteOperationalRpcClient,
  createPGliteOperationalRpcServer,
} from "./pglite-operational-rpc.ts";
import type { AutomationPersistenceProvider } from "../src/lib/automation/server/store.ts";
import type { ExchangeRatePersistencePort } from "../src/ledger/exchange-rates.ts";
import type { PGliteMaicoinPersistencePort } from "../src/ledger/pglite/maicoin-operational.ts";
import {
  captureSafeWorkflowFailureError,
  workflowFailureDiagnosticRepoRoot,
  WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV,
  type WorkflowFailureCorrelation,
} from "../src/lib/automation/server/workflow-failure-diagnostics.ts";

type Listener = (value: unknown) => void;

class MemoryPort {
  peer: MemoryPort | undefined;
  readonly listeners = new Set<Listener>();

  on(_event: "message", listener: Listener): void {
    this.listeners.add(listener);
  }

  off(_event: "message", listener: Listener): void {
    this.listeners.delete(listener);
  }

  postMessage(value: unknown): void {
    const peer = this.peer;
    if (!peer) throw new Error("memory port is disconnected");
    const serialized = structuredClone(value);
    queueMicrotask(() => {
      for (const listener of peer.listeners) listener(serialized);
    });
  }
}

function memoryPair(): readonly [MemoryPort, MemoryPort] {
  const left = new MemoryPort();
  const right = new MemoryPort();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function sqlStateFailure(): Error {
  const error = new Error("duplicate key for account SECRET-ACCT; SQL: insert into private_ledger");
  Object.defineProperty(error, "code", { value: "23505" });
  return error;
}

test("main-side PGlite RPC failures record safe correlated original errors before serialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octopus-beak-workflow-diagnostic-rpc-"));
  const path = join(directory, "workflow-failures.jsonl");
  const previousPath = process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV];
  const previousRoot = process.env.OCTOPUSBEAK_APP_ROOT;
  process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV] = path;
  process.env.OCTOPUSBEAK_APP_ROOT = process.cwd();
  const correlation: WorkflowFailureCorrelation = {
    workflowId: "yuanta-all-statements",
    taskRunId: "task-run-secret-free-123",
  };
  const financialPorts = memoryPair();
  const financialError = sqlStateFailure();
  const financialServer = createPGliteFinancialRpcServer(financialPorts[1], {
    sourceAdmit: async () => { throw financialError; },
  } as unknown as PGliteFinancialRegistry);
  const financialClient = createPGliteFinancialRpcClient(financialPorts[0], undefined, correlation);
  const operationalPorts = memoryPair();
  const operationalError = sqlStateFailure();
  const operationalProvider = {
    automation: {},
    exchangeRates: {},
    maicoin: { finishRun: async () => { throw operationalError; } },
  } as unknown as AutomationPersistenceProvider & {
    exchangeRates: ExchangeRatePersistencePort;
    maicoin: PGliteMaicoinPersistencePort;
  };
  const operationalServer = createPGliteOperationalRpcServer(operationalPorts[1], operationalProvider);
  const operationalClient = createPGliteOperationalRpcClient(operationalPorts[0], undefined, correlation);

  try {
    await assert.rejects(
      financialClient.registry.sourceAdmit({
        captureId: "capture",
        integrationNamespace: "synthetic",
        sourceConnectionKey: "synthetic-connection",
        identityEpoch: "synthetic-epoch",
        stream: "synthetic-stream",
        recordKind: "synthetic-record",
        routeKey: "test",
        contractVersion: "synthetic-v1",
        subjectDigest: "synthetic-subject",
        observedAt: "2026-09-22T00:00:00.000Z",
        scope: {},
        pages: [],
        records: [],
      } as never),
      /PGlite financial operation failed/u,
    );
    await assert.rejects(
      operationalClient.provider.maicoin.finishRun({
        syncRunId: "run",
        finishedAt: "2026-09-22T00:00:00.000Z",
        record: {},
      } as never),
      /PGlite operational operation failed/u,
    );

    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((row) => row.operation), ["financial.source.admit", "maicoin.finishRun"]);
    for (const row of lines) {
      assert.equal(row.workflowId, correlation.workflowId);
      assert.equal(row.taskRunId, correlation.taskRunId);
      assert.equal(row.errorCode, "workflow-failed");
      const diagnosticError = row.error as { chain: Array<{ sqlState?: string }> };
      assert.equal(diagnosticError.chain[0]?.sqlState, "23505");
    }
    const content = lines.map((row) => JSON.stringify(row)).join("\n");
    assert.doesNotMatch(content, /SECRET-ACCT|private_ledger|duplicate key/u);
    assert.equal(workflowFailureDiagnosticRepoRoot().length > 0, true);
  } finally {
    financialClient.close();
    operationalClient.close();
    await Promise.all([financialServer.close(), operationalServer.close()]);
    if (previousPath === undefined) delete process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV];
    else process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV] = previousPath;
    if (previousRoot === undefined) delete process.env.OCTOPUSBEAK_APP_ROOT;
    else process.env.OCTOPUSBEAK_APP_ROOT = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
});


test("financial original failure survives the uncorrelated inner worker and correlated outer RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octopus-beak-multihop-"));
  const path = join(directory, "failures.jsonl");
  const previousPath = process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV];
  const previousRoot = process.env.OCTOPUSBEAK_APP_ROOT;
  process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV] = path;
  process.env.OCTOPUSBEAK_APP_ROOT = process.cwd();
  const innerPorts = memoryPair();
  const innerServer = createPGliteFinancialRpcServer(innerPorts[1], {
    spendingVersion: async () => { throw sqlStateFailure(); },
  } as unknown as PGliteFinancialRegistry);
  const innerClient = createPGliteFinancialRpcClient(innerPorts[0]);
  const outerPorts = memoryPair();
  const outerServer = createPGliteFinancialRpcServer(outerPorts[1], innerClient.registry);
  const outerClient = createPGliteFinancialRpcClient(outerPorts[0], undefined, {
    workflowId: "fubon-all-statements", taskRunId: "multihop-run",
  });
  const wire: unknown[] = [];
  innerPorts[0].on("message", (value) => wire.push(value));
  outerPorts[0].on("message", (value) => wire.push(value));
  try {
    await assert.rejects(outerClient.registry.spendingVersion(), /PGlite financial operation failed/u);
    const row = JSON.parse((await readFile(path, "utf8")).trim());
    assert.equal(row.error.chain[0]?.sqlState, "23505");
    assert.ok(row.error.chain[0]?.frames.some((frame: { file: string }) =>
      frame.file === "electron/workflow-failure-rpc-diagnostics.check.ts"));
    assert.doesNotMatch(JSON.stringify(wire), /SECRET-ACCT|private_ledger|duplicate key/u);
  } finally {
    outerClient.close(); innerClient.close();
    await Promise.all([outerServer.close(), innerServer.close()]);
    if (previousPath === undefined) delete process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV];
    else process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV] = previousPath;
    if (previousRoot === undefined) delete process.env.OCTOPUSBEAK_APP_ROOT;
    else process.env.OCTOPUSBEAK_APP_ROOT = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
});


test("financial diagnostics stay absent by default and ignore hostile optional fields", async () => {
  const previousPath = process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV];
  delete process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV];
  const ports = memoryPair();
  const wire: unknown[] = [];
  ports[0].on("message", (value) => wire.push(value));
  const server = createPGliteFinancialRpcServer(ports[1], {
    spendingVersion: async () => { throw sqlStateFailure(); },
  } as unknown as PGliteFinancialRegistry);
  const client = createPGliteFinancialRpcClient(ports[0]);
  try {
    await assert.rejects(client.registry.spendingVersion(), /PGlite financial operation failed/u);
    assert.equal(Object.hasOwn(wire[0] as object, "diagnosticError"), false);
    assert.doesNotMatch(JSON.stringify(wire), /SECRET-ACCT|private_ledger|23505/u);
    await server.close();
    process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV] = "/unused-test-sink";
    ports[1].on("message", (request) => {
      ports[1].postMessage({
        kind: "pglite-financial-response", version: 1, id: (request as { id: number }).id,
        ok: false, code: "operation-failed", diagnosticError: {
          chain: [{ type: "Error", sqlState: "23505", message: "SECRET", frames: [
            { file: "../../SECRET", line: 1, column: 1 },
            { file: "electron/test.ts", line: 1, column: 1 },
          ] }],
        },
      });
    });
    await assert.rejects(client.registry.spendingVersion(), (error: unknown) => {
      const snapshot = captureSafeWorkflowFailureError(error, process.cwd());
      assert.equal(snapshot.chain[0]?.sqlState, "23505");
      assert.deepEqual(snapshot.chain[0]?.frames, [{ file: "electron/test.ts", line: 1, column: 1 }]);
      assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|message/u);
      return true;
    });
  } finally {
    client.close(); await server.close();
    if (previousPath === undefined) delete process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV];
    else process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV] = previousPath;
  }
});
