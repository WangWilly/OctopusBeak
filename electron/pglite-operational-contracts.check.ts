import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";
import { PREVIEW_PRODUCTS } from "../src/ledger/pglite/preview-financial-data.ts";
import {
  createPGliteOperationalRpcClient,
  createPGliteOperationalRpcServer,
  PGLITE_OPERATIONAL_OPERATIONS,
  type PGliteOperationalDomains,
  type PGliteOperationalOperation,
} from "./pglite-operational-rpc.ts";

const at = "2026-10-27T00:00:00.000Z";
const visibility = { visible: [{ sourceId: "preview-source", product: [...PREVIEW_PRODUCTS][0] }] };

/** One argument list each method accepts and one it refuses before reaching the store. */
const CASES: Record<PGliteOperationalOperation, Readonly<{ accepted: readonly unknown[]; refused: readonly unknown[] }>> = {
  "automation.createTaskRun": {
    accepted: [{ taskId: "task", kind: "sync", status: "running", attempt: 1, maxAttempts: 1, startedAt: at }],
    refused: [{ taskId: "task", kind: "sync", status: "running", attempt: 1, maxAttempts: 1, startedAt: at, script: "run" }],
  },
  "automation.updateTaskRun": { accepted: ["run", { attempt: 2 }], refused: ["run", { status: "completed" }] },
  "automation.transitionTaskRunToActive": { accepted: ["run", { status: "running" }], refused: ["run", { logPath: "x" }] },
  "automation.transitionTaskRunToTerminal": { accepted: ["run", { status: "completed", finishedAt: at }], refused: ["", {}] },
  "automation.updateHumanAssistanceContract": { accepted: ["run", {}], refused: ["run", []] },
  "automation.updateHumanAssistanceCompletion": { accepted: ["run", "done"], refused: ["run", 1] },
  "automation.taskRunById": { accepted: ["run"], refused: [] },
  "automation.activeTaskRuns": { accepted: [], refused: ["extra"] },
  "automation.latestTaskRuns": { accepted: [], refused: ["extra"] },
  "automation.todayTaskRunIds": { accepted: [{ startUtc: at, endUtc: at }], refused: [{ startUtc: "not a date", endUtc: at }] },
  "automation.hasSuccessfulTaskRunSince": { accepted: ["task", at], refused: ["task"] },
  "automation.hasOccurrenceBeenAttempted": { accepted: ["task", at], refused: ["task", null] },
  "automation.recentTaskRuns": { accepted: [5], refused: [-1] },
  "automation.appendRunEvent": {
    accepted: [{ runId: "run", stage: "commit", code: "ok", occurredAt: at }],
    refused: [{ runId: "run", stage: "unknown-stage", code: "ok", occurredAt: at }],
  },
  "automation.recordCommitAttempt": {
    accepted: ["run", { phase: "started", attemptId: "attempt-1", product: null, total: 1 }],
    refused: ["run", { phase: "started", attemptId: "attempt-1", product: null, total: 1, extra: true }],
  },
  "automation.commitAttempts": { accepted: ["run"], refused: [""] },
  "automation.pruneRunEvents": { accepted: [at], refused: ["not a date"] },
  "automation.upsertTaskPrerequisiteNotice": {
    accepted: [{ taskId: "task", prerequisiteId: "prerequisite", taskRunId: "run", detectedAt: at }],
    refused: [{ taskId: "task", prerequisiteId: "prerequisite", detectedAt: at }],
  },
  "automation.activeTaskPrerequisiteNotices": { accepted: [], refused: ["extra"] },
  "automation.allTaskPrerequisiteNotices": { accepted: [], refused: ["extra"] },
  "automation.resolveTaskPrerequisiteNotices": { accepted: ["task", "prerequisite", at], refused: ["task", "prerequisite"] },
  "exchangeRates.readExchangeRates": { accepted: [["USD"]], refused: [[1]] },
  "exchangeRates.upsertExchangeRates": {
    accepted: [[{ rateDate: "2026-10-27", currency: "USD", twdPerUnit: 32, source: "check", fetchedAt: at }]],
    refused: [[{ rateDate: "2026-10-27", currency: "USD", twdPerUnit: Number.NaN, source: "check", fetchedAt: at }]],
  },
  "maicoin.startRun": {
    accepted: [{ syncRunId: "sync", startedAt: at, subAccount: "main", walletTypes: ["spot"], statementLimit: 10, record: {} }],
    refused: [{ syncRunId: "sync", startedAt: at, subAccount: "main", walletTypes: ["spot"], statementLimit: 1.5, record: {} }],
  },
  "maicoin.appendSnapshots": {
    accepted: [[{
      snapshotId: "s", syncRunId: "sync", capturedAt: at, subAccount: "main", walletType: "spot", currency: "BTC", rawAccountJson: "{}",
    }]],
    refused: [Array.from({ length: 101 }, () => ({}))],
  },
  "maicoin.appendStatementRows": {
    accepted: [[{
      statementId: "s", syncRunId: "sync", capturedAt: at, endpoint: "e", rowType: "r", externalId: "x", rawPayloadJson: "{}",
    }]],
    refused: [[{ statementId: "s" }]],
  },
  "maicoin.finishRun": { accepted: [{ syncRunId: "sync", finishedAt: at, record: {} }], refused: [{ syncRunId: "sync", finishedAt: at }] },
  "preview.write": {
    accepted: [{ sourceId: "preview-source", institution: "bank", product: "deposit", collection: {} }],
    refused: [{ sourceId: "preview-source", institution: "bank", product: "deposit", collection: {}, sql: "DROP" }],
  },
  "preview.deleteAll": { accepted: [], refused: ["extra"] },
  "preview.accounts": { accepted: [visibility], refused: [{ visible: [{ sourceId: "preview-source", product: "unknown" }] }] },
  "preview.transactions": { accepted: [visibility, "account"], refused: [visibility] },
  "preview.creditAccounts": { accepted: [visibility], refused: [{ visible: "all" }] },
  "preview.purchases": { accepted: [visibility, "account"], refused: [visibility, ""] },
  "preview.statements": { accepted: [visibility, "account"], refused: [{}, "account"] },
};

type RecordedCall = Readonly<{ operation: string; args: readonly unknown[] }>;

function recordingProvider(calls: RecordedCall[]): PGliteOperationalDomains {
  const domain = (name: string) => {
    const port: object = new Proxy({}, {
      get: (_target, method) => function (this: unknown, ...args: unknown[]) {
        assert.equal(this, port, `${name}.${String(method)} is called on its port`);
        calls.push({ operation: `${name}.${String(method)}`, args });
        return Promise.resolve(`${name}.${String(method)}`);
      },
    });
    return port;
  };
  return {
    automation: domain("automation"),
    exchangeRates: domain("exchangeRates"),
    maicoin: domain("maicoin"),
    preview: domain("preview"),
  } as unknown as PGliteOperationalDomains;
}

test("each operational method reaches its own port method through the derived proxy and refuses bad arguments", async () => {
  const calls: RecordedCall[] = [];
  const channel = new MessageChannel();
  const server = createPGliteOperationalRpcServer(channel.port1, recordingProvider(calls));
  const client = createPGliteOperationalRpcClient(channel.port2);
  try {
    assert.deepEqual([...PGLITE_OPERATIONAL_OPERATIONS].sort(), Object.keys(CASES).sort());
    for (const operation of PGLITE_OPERATIONAL_OPERATIONS) {
      const [domain, method] = operation.split(".") as [keyof PGliteOperationalDomains, string];
      const port = client.provider[domain] as unknown as Record<string, (...args: readonly unknown[]) => Promise<unknown>>;
      assert.equal(await port[method]!(...CASES[operation].accepted), operation, `${operation} dispatches to its own method`);
      if (operation === "automation.todayTaskRunIds") {
        const [range] = calls.at(-1)!.args as [{ startUtc: unknown; endUtc: unknown }];
        assert.ok(range.startUtc instanceof Date && range.endUtc instanceof Date, "the store receives Date bounds");
      }
      calls.length = 0;
      await assert.rejects(
        client.request(operation, CASES[operation].refused),
        (error: unknown) => (error as { code?: string }).code === "invalid-request"
          && (error as Error).message === "Invalid PGlite operational request.",
        `${operation} refuses its bad arguments`,
      );
      assert.deepEqual(calls, [], `${operation} never reaches the store with refused arguments`);
    }
    for (const name of ["automation.constructor", "constructor", "toString", "__proto__"]) {
      await assert.rejects(
        Promise.race([
          client.request(name as PGliteOperationalOperation, []),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${name} got no response`)), 1_000).unref()),
        ]),
        /Invalid PGlite operational request/u,
        `${name} is not an operation`,
      );
    }
    assert.deepEqual(calls, []);
  } finally {
    client.close();
    await server.close();
    channel.port1.close();
    channel.port2.close();
  }
});
