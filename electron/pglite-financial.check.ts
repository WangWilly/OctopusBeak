import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import {
  createPGliteFinancialLiveViews,
  createPGliteFinancialPageClient,
  PGliteFinancialError,
  PGLITE_FINANCIAL_OPERATIONS,
  type PGliteFinancialRegistry,
  type PGliteFinancialOperation,
} from "./pglite-financial-registry.ts";
import { createPGliteViewWorkerClient } from "./pglite-view-worker-client.ts";

const token = (letter: string): string => `sha256:${letter.repeat(64)}`;

function sourceCommitRequest(captureId: string): import("../src/ledger/pglite/canonical-source-store.ts").PGliteCanonicalFinancialCommitRequest {
  const occurrenceKey = token(`${captureId}-occurrence`);
  return {
    capture: {
      captureId,
      integrationNamespace: "synthetic",
      sourceConnectionKey: token("a"),
      identityEpoch: token("b"),
      stream: "domestic-deposit",
      recordKind: "source-record",
      routeKey: "synthetic/domestic-deposit/v8",
      contractVersion: "synthetic-v8",
      subjectDigest: token("c"),
      observedAt: "2026-09-22T00:00:00.000Z",
      accountNumber: {
        value: "123456",
        kind: "depository-account",
        evidenceVersion: "synthetic-v1",
        sourceField: "accountNumber",
      },
      scope: {
        startDate: "20260101",
        endDate: "20260102",
        kind: "point-in-time",
        completeness: "single-page",
        ruleVersion: "synthetic-completeness-v1",
        sourceAccountKey: "synthetic-account-1",
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: { pageCount: 1 },
      }],
      records: [{
        occurrenceKey,
        collisionKey: token(`${captureId}-collision`),
        providerKey: token(`${captureId}-provider`),
        contentHash: token(`${captureId}-content`),
        compact: { amount: { coefficient: "100", scale: 0 } },
      }],
    },
    account: {
      sourceAccountKey: "synthetic-account-1",
      accountNo: "123456",
      accountType: "depository",
      currency: "TWD",
    },
    transactions: [{
      sourceOccurrenceKey: occurrenceKey,
      sourceSequence: "sequence-1",
      amount: { coefficient: "100", scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "synthetic_origin",
      postingBasis: "synthetic_basis",
      postingRuleVersion: "synthetic-v1",
      description: "worker RPC source fact",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "synthetic-v1",
      effectiveOn: "2026-01-01",
      transactionDateTimeLocal: "2026-01-01T00:00:00+08:00",
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "accounting",
      effectiveTimeRuleVersion: "synthetic-v1",
      utcInstantUtcUs: 1,
    }],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for PGlite financial live update.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("one worker exposes named financial reads/writes and complete live snapshots", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-financial-rpc-check-"));
  const worker = new Worker(new URL("./pglite-view-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: { dataDir },
  });
  const client = createPGliteViewWorkerClient(worker);
  const page = createPGliteFinancialPageClient(client.financial, client.subscribe);
  const snapshots: unknown[] = [];
  let stop: (() => Promise<void>) | undefined;
  try {
    const initial = await page.load("overview");
    assert.equal(initial.availability, "empty");
    assert.ok(PGLITE_FINANCIAL_OPERATIONS.includes("financial.overview.current"));
    assert.deepEqual(await client.financial.registry.currentLoanRelations(), []);
    assert.deepEqual(await client.financial.registry.currentLoanSettlementGroups(), []);
    assert.deepEqual(await client.financial.registry.currentInvestmentRelations(), []);
    stop = await client.subscribe("financial.overview.current", {}, (rows) => {
      snapshots.push(rows[0]);
    });
    await waitFor(() => snapshots.length >= 1);

    await client.financial.registry.upsertExchangeRates([{
      rateDate: "2026-09-22",
      currency: "USD",
      twdPerUnit: 31.5,
      source: "financial-rpc-check",
      fetchedAt: "2026-09-22T00:00:00.000Z",
    }]);
    await waitFor(() => snapshots.length >= 2);
    assert.equal((snapshots.at(-1) as { availability: string }).availability, "empty");
    const afterInsert = snapshots.length;
    await client.financial.registry.upsertExchangeRates([{
      rateDate: "2026-09-22",
      currency: "USD",
      twdPerUnit: 31.6,
      source: "financial-rpc-check-update",
      fetchedAt: "2026-09-22T01:00:00.000Z",
    }]);
    await waitFor(() => snapshots.length > afterInsert);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterRateUpdate = snapshots.length;

    // Automation progress has its own runtime stream.  Updating a task row
    // must not force a complete financial DTO recomputation.
    const taskRun = await client.operationalProvider.automation.createTaskRun({
      taskId: "exchange-rates",
      script: "run:exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-22T02:00:00.000Z",
      logPath: "data/automation/logs/pglite-financial-check.log",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(snapshots.length, afterRateUpdate, "automation task creation must not invalidate overview");
    await client.operationalProvider.automation.updateTaskRun(taskRun.taskRunId, {
      logTail: "same dependency row, newer task state",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(snapshots.length, afterRateUpdate, "automation task updates must not invalidate overview");

    const beforeFailure = snapshots.length;
    await assert.rejects(
      client.financial.request("financial.source.commit", [{}]),
      (error: unknown) => error instanceof PGliteFinancialError
        && error.code === "invalid-request",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(snapshots.length, beforeFailure, "a rolled-back/failed command must not publish a new page snapshot");

    await assert.rejects(
      client.financial.request("SELECT 1" as PGliteFinancialOperation, []),
      /Invalid PGlite financial request/u,
      "renderer cannot submit arbitrary SQL as a financial operation",
    );
    await stop();
    stop = undefined;
    const beforeUnsubscribe = snapshots.length;
    await client.financial.registry.upsertExchangeRates([{
      rateDate: "2026-09-23",
      currency: "USD",
      twdPerUnit: 31.6,
      source: "financial-rpc-check",
      fetchedAt: "2026-09-23T00:00:00.000Z",
    }]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(snapshots.length, beforeUnsubscribe, "unsubscribe must stop result publication");
  } finally {
    await stop?.();
    await client.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("worker RPC commits one typed canonical fact, publishes all financial pages, and reopens it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-financial-rpc-capture-check-"));
  const start = () => new Worker(new URL("./pglite-view-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: { dataDir },
  });
  const worker = start();
  const client = createPGliteViewWorkerClient(worker);
  const page = createPGliteFinancialPageClient(client.financial, client.subscribe);
  const snapshots: Record<string, unknown[]> = { overview: [], assets: [], spending: [] };
  const stops: Array<() => Promise<void>> = [];
  try {
    for (const view of ["overview", "assets", "spending"] as const) {
      stops.push(await client.subscribe(`financial.${view}.current`, {}, (rows) => {
        snapshots[view]!.push(rows[0]);
      }));
    }
    await waitFor(() => Object.values(snapshots).every((rows) => rows.length >= 1));
    const committed = await client.financial.registry.sourceCommit(sourceCommitRequest("rpc-capture"));
    assert.equal(committed.transactions[0]?.amount.coefficient, "100");
    const unresolved = await client.financial.registry.resolveLoanRelations({
      sourceConnectionKey: token("a"),
      requiredCoverage: { complete: false },
      observedAt: "2026-09-22T00:00:00.000Z",
    });
    assert.equal(unresolved.outcome, "no-admission");
    const repeated = await client.financial.registry.resolveLoanRelations({
      sourceConnectionKey: token("a"),
      requiredCoverage: { complete: false },
      observedAt: "2026-09-22T00:00:00.000Z",
    });
    assert.equal(repeated.outcome, "unchanged");
    assert.equal(repeated.resolutionId, unresolved.resolutionId);
    const funding = await client.financial.registry.resolveInvestmentRelations({
      sourceConnectionKey: token("a"),
      observedAt: "2026-09-22T00:00:00.000Z",
    });
    assert.equal(funding.outcome, "unchanged");
    assert.equal(funding.resolved, 0);
    await waitFor(() => Object.values(snapshots).every((rows) => rows.length >= 2));

    const overview = snapshots.overview.at(-1) as { accounts: readonly unknown[]; availability: string };
    const assets = snapshots.assets.at(-1) as { accounts: readonly unknown[] };
    const spending = snapshots.spending.at(-1) as {
      canonical: {
        knowledgePoint: number;
        transactions: readonly unknown[];
        includedTransactions: readonly unknown[];
      }
    };
    assert.equal(overview.accounts.length, 1, "overview must expose the committed account");
    assert.notEqual(overview.availability, "empty", "overview must observe the committed fact");
    assert.equal(assets.accounts.length, 1, "assets must expose the committed account");
    const committedTransactionId = committed.transactions[0]?.transactionId;
    assert.ok(committedTransactionId, "the typed source commit must return a transaction identity");
    assert.ok(
      spending.canonical.transactions.some((row) =>
        (row as { transactionId?: unknown }).transactionId === committedTransactionId,
      ),
      "spending must expose the committed transaction row, even when classification is an explicit eligibility gap",
    );
    assert.ok(
      spending.canonical.knowledgePoint >= committed.commitSequence,
      "spending must observe at least the source commit knowledge point (projection may add a derived canonical commit)",
    );
    await Promise.all(stops.splice(0).map((stop) => stop()));
    await client.close();

    const reopenedWorker = start();
    const reopened = createPGliteViewWorkerClient(reopenedWorker);
    try {
      const persistedOverview = await reopened.financial.registry.overviewCurrent();
      const persistedSpending = await reopened.financial.registry.spendingCurrent();
      assert.equal(persistedOverview.accounts.length, 1, "canonical account must survive worker close/reopen");
      assert.ok(
        persistedSpending.canonical.transactions.some((row) =>
          (row as { transactionId?: unknown }).transactionId === committedTransactionId,
        ),
        "the current Spending transaction projection must survive worker close/reopen",
      );
      assert.ok(
        persistedSpending.canonical.knowledgePoint >= committed.commitSequence,
        "spending knowledge point must survive worker close/reopen",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await Promise.all(stops.splice(0).map((stop) => stop()));
    await client.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("worker named mixed command keeps raw and derived source captures atomic", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-financial-mixed-rpc-"));
  const worker = new Worker(new URL("./pglite-view-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: { dataDir },
  });
  const client = createPGliteViewWorkerClient(worker);
  try {
    const result = await client.financial.registry.mixedCommit({
      steps: [
        { kind: "source", request: sourceCommitRequest("raw-rpc").capture },
        { kind: "financial", request: sourceCommitRequest("derived-rpc") },
      ],
    });
    assert.equal(result.admissions.length, 1);
    assert.equal(result.financial.length, 1);
    assert.equal((await client.financial.registry.spendingCurrent()).canonical.transactions.length, 1);
    const invalid = sourceCommitRequest("invalid-rpc");
    await assert.rejects(client.financial.registry.mixedCommit({
      steps: [
        { kind: "source", request: sourceCommitRequest("rollback-rpc").capture },
        { kind: "financial", request: { ...invalid, account: { ...invalid.account, accountType: "invalid" as "depository" } } },
      ],
    }), /PGlite financial operation failed/u);
    const reopened = await client.financial.registry.spendingCurrent();
    assert.equal(reopened.canonical.transactions.length, 1);
  } finally {
    await client.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("financial live views recover after a transient read failure and stop during a read", async () => {
  const triggers: Array<() => void> = [];
  let unsubscribeCount = 0;
  const database = {
    live: {
      query: async (
        _sql: string,
        _args: readonly unknown[],
        onChange: () => void,
      ) => {
        triggers.push(onChange);
        return { unsubscribe: async () => { unsubscribeCount += 1; } };
      },
    },
  } as unknown as import("@electric-sql/pglite/live").PGliteWithLive;
  const page = {
    availability: "empty" as const,
    coverage: "complete" as const,
    historyAvailability: "unavailable" as const,
    sourceGaps: [],
    importedAt: null,
    summary: [],
    dailyHistory: [],
    accounts: [],
    sankey: null,
    sankeyExchangeRates: [],
    sankeyLatestExchangeRateDate: null,
    exchangeRates: [],
    latestExchangeRateDate: null,
  };
  let failNext = false;
  let blocked: Promise<typeof page> | null = null;
  let readCount = 0;
  const registry = {
    overviewCurrent: async () => {
      readCount += 1;
      if (failNext) {
        failNext = false;
        throw new Error("transient read failure");
      }
      if (blocked) return blocked;
      return page;
    },
  } as unknown as PGliteFinancialRegistry;
  const views = createPGliteFinancialLiveViews(database, registry);
  const rows: unknown[] = [];
  const errors: unknown[] = [];
  const stop = await views.subscribe(
    "financial.overview.current",
    {},
    (next) => rows.push(next[0]),
    (error) => errors.push(error),
  );
  assert.equal(rows.length, 1);
  failNext = true;
  triggers[0]!();
  await waitFor(() => errors.length === 1);
  triggers[0]!();
  await waitFor(() => rows.length === 2);
  assert.ok(readCount >= 3, "a later dependency event must retry after a failed read");

  let resolveBlocked!: (value: typeof page) => void;
  blocked = new Promise((resolve) => { resolveBlocked = resolve; });
  const rowCountBeforeStop = rows.length;
  triggers[0]!();
  await waitFor(() => readCount >= 4);
  await stop();
  resolveBlocked(page);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(rows.length, rowCountBeforeStop, "unsubscribe during a read must suppress its eventual result");
  assert.equal(unsubscribeCount, 2, "all overview dependencies must drain on stop");
});

test("financial operation names stay allowlisted and transport failures are typed", () => {
  assert.equal(PGLITE_FINANCIAL_OPERATIONS.includes("financial.overview.current"), true);
  assert.equal(PGLITE_FINANCIAL_OPERATIONS.includes("financial.source.commit"), true);
  assert.equal(PGLITE_FINANCIAL_OPERATIONS.includes("SELECT 1" as PGliteFinancialOperation), false);
});
