import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { fixtureInvoice } from "../src/ledger/pglite/spending-test-fixture.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Worker } from "node:worker_threads";
import test from "node:test";
import {
  createPGliteFinancialRegistry,
  createPGliteFinancialLiveViews,
  createPGliteFinancialPageClient,
  PGliteFinancialError,
  PGLITE_FINANCIAL_OPERATIONS,
  type PGliteFinancialRpcClient,
  type PGliteFinancialRegistry,
  type PGliteFinancialOperation,
} from "./pglite-financial-registry.ts";
import { createPGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import { exchangeRateRequestFromOverview } from "../src/ledger/exchange-rate-requirements.ts";
import { applyPgliteBaseline } from "../src/ledger/pglite/baseline.ts";
import { applyPgliteOperationalBaseline, createPgliteOperationalProvider } from "../src/ledger/pglite/operational.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";

const token = (letter: string): string => `sha256:${letter.repeat(64)}`;

function sourceCommitRequest(
  captureId: string,
  sourceAccountKey = "synthetic-account-1",
): import("../src/ledger/pglite/canonical-source-store.ts").PGliteCanonicalFinancialCommitRequest {
  const occurrenceKey = token(`${captureId}-occurrence`);
  return {
    capture: {
      captureId,
      integrationNamespace: "cathay",
      sourceConnectionKey: token("a"),
      identityEpoch: token("b"),
      stream: "domestic-deposit",
      recordKind: "source-record",
      routeKey: "cathay/domestic-deposit/v1",
      contractVersion: "v1",
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
        ruleVersion: "cathay/domestic-deposit/v1",
        sourceAccountKey,
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
      sourceAccountKey,
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
      postingOrigin: "provider_booked_history",
      postingBasis: "query-status-success-with-accounting-date",
      postingRuleVersion: "cathay/domestic-deposit/v1",
      description: "worker RPC source fact",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "cathay/domestic-deposit/v1",
      effectiveOn: "2026-01-01",
      transactionDateTimeLocal: "2026-01-01T00:00:00+08:00",
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "accounting",
      effectiveTimeRuleVersion: "cathay/domestic-deposit/v1",
      utcInstantUtcUs: 1,
    }],
  };
}

function balanceCaptureRequest(
  captureId: string,
  effectiveAt: string,
  coefficient: string,
  currency: string,
): import("../src/ledger/pglite/balance.ts").PGliteCanonicalBalanceCaptureRequest {
  const occurrenceKey = token(`${captureId}-occurrence`);
  const date = effectiveAt.slice(0, 10);
  return {
    capture: {
      captureId,
      integrationNamespace: "cathay",
      sourceConnectionKey: token("a"),
      identityEpoch: token("b"),
      stream: "domestic-deposit",
      recordKind: "synthetic-balance",
      routeKey: "cathay/domestic-deposit/current-balance-v1",
      contractVersion: "cathay/current-deposit-balance-v1",
      subjectDigest: token(`${captureId}-subject`),
      observedAt: effectiveAt,
      accountNumber: null,
      scope: {
        startDate: date,
        endDate: date,
        dateFormat: "YYYY-MM-DD",
        kind: "point-in-time",
        completeness: "single-page",
        ruleVersion: "cathay/current-deposit-balance-v1",
        sourceAccountKey: "123456",
        accountNo: "123456",
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: { provider: "synthetic" },
      }],
      records: [{
        occurrenceKey,
        collisionKey: token(`${captureId}-collision`),
        providerKey: token(`${captureId}-provider`),
        contentHash: token(`${captureId}-content`),
        compact: { balance: { coefficient, scale: 0 }, effectiveAt, currency },
      }],
    },
    account: {
      sourceAccountKey: "123456",
      accountType: "depository",
      currency: "TWD",
    },
    observations: [{
      observationKey: token("ledger-observation"),
      balanceKind: "ledger",
      balance: { coefficient, scale: 0 },
      currency,
      effectiveAt,
      effectiveTimeBasis: "provider-system-time",
      effectiveTimeRuleVersion: "cathay/current-deposit-balance-v1",
      evidenceSourceRecordKey: occurrenceKey,
      evidenceSourceField: "balance",
      evidenceSourceValue: coefficient,
      evidenceContractVersion: "cathay/current-deposit-balance-v1",
      sourceOccurrenceKey: occurrenceKey,
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

test("pairing prewarm checks the commit version without materializing Spending", async () => {
  let versionReads = 0;
  const page = createPGliteFinancialPageClient({
    registry: {
      spendingVersion: async () => { versionReads += 1; return 7; },
      spendingCurrent: async () => { throw new Error("full Spending read is not prewarm"); },
    },
  } as unknown as PGliteFinancialRpcClient);
  assert.deepEqual(await page.prewarmPairingCandidates({ dataVersion: 7 }), {
    status: "ready", dataVersion: 7, reused: false,
  });
  assert.deepEqual(await page.prewarmPairingCandidates({ dataVersion: 6 }), {
    status: "stale", dataVersion: 7, requestedVersion: 6,
  });
  assert.equal(versionReads, 2);
});

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
    assert.equal(await client.financial.registry.spendingVersion(), 0);
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
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-22T02:00:00.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(snapshots.length, afterRateUpdate, "automation task creation must not invalidate overview");
    await client.operationalProvider.automation.updateTaskRun(taskRun.taskRunId, {
      appWorkflowOutcome: {
        errorCode: null,
        summary: { status: "completed", counts: { count: 1 } },
      },
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

test("PGlite overview exposes observed daily balances to exchange-rate requirements", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  await applyPgliteBaseline(database);
  await applyPgliteOperationalBaseline(store);
  const operational = createPgliteOperationalProvider(store);
  const registry = createPGliteFinancialRegistry(store, operational.exchangeRates);
  try {
    await registry.sourceCommit(sourceCommitRequest("overview-history-source", "123456"));
    await registry.balanceCapture(balanceCaptureRequest(
      "overview-history-twd-1",
      "2026-09-22T04:00:00.000Z",
      "1000",
      "TWD",
    ));
    await registry.balanceCapture(balanceCaptureRequest(
      "overview-history-usd",
      "2026-09-22T06:00:00.000Z",
      "425",
      "USD",
    ));
    await registry.balanceCapture(balanceCaptureRequest(
      "overview-history-twd-2",
      "2026-09-24T04:00:00.000Z",
      "1300",
      "TWD",
    ));

    const overview = await registry.overviewCurrent();
    assert.equal(overview.historyAvailability, "available");
    assert.deepEqual(overview.dailyHistory.map((row) => row.date), ["2026-09-22", "2026-09-24"]);
    assert.deepEqual(exchangeRateRequestFromOverview(overview), {
      requiredFrom: "2026-09-22",
      currencies: ["USD"],
    });
  } finally {
    await store.close();
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
      };
      purchaseReport: {
        knowledgeAt: number;
        records: readonly unknown[];
        summary?: {
          recordCount: number;
          monthTotals: readonly Readonly<{ month: string; recordCount: number }>[];
        };
      };
    };
    assert.equal(overview.accounts.length, 1, "overview must expose the committed account");
    assert.notEqual(overview.availability, "empty", "overview must observe the committed fact");
    assert.equal(assets.accounts.length, 1, "assets must expose the committed account");
    const committedTransactionId = committed.transactions[0]?.transactionId;
    assert.ok(committedTransactionId, "the typed source commit must return a transaction identity");
    assert.deepEqual(spending.canonical.transactions, [], "the live Spending summary must stay compact");
    assert.deepEqual(spending.purchaseReport.records, [], "the live Spending summary must not materialize full report rows");
    assert.ok(spending.purchaseReport.summary, "the compact Spending page must include grouped totals and counts");
    assert.equal(spending.purchaseReport.summary.recordCount, 0, "an ineligible source fact must not become a purchase row");
    assert.deepEqual(spending.purchaseReport.summary.monthTotals, [], "the compact summary must omit months without eligible purchase rows");
    const committedPage = await page.loadSpendingRecordPage({
      knowledgeAt: spending.purchaseReport.knowledgeAt,
      month: "2026-01",
      day: "2026-01-01",
    });
    assert.equal(committedPage.knowledgeAt, spending.purchaseReport.knowledgeAt);
    const staleRequest = { knowledgeAt: spending.purchaseReport.knowledgeAt - 1, month: "2026-01" };
    const staleResult = { stale: true, knowledgeAt: spending.purchaseReport.knowledgeAt };
    assert.deepEqual(await page.loadSpendingRecordPage(staleRequest), staleResult);
    assert.deepEqual(await page.loadSpendingCandidatePage(staleRequest), staleResult);
    const knowledgeAt = spending.purchaseReport.knowledgeAt;
    assert.deepEqual(await page.loadSpendingPendingOverview({ knowledgeAt: knowledgeAt - 1 }), staleResult);
    assert.deepEqual(await page.loadSpendingMergeLog({ knowledgeAt: knowledgeAt - 1 }), staleResult);
    assert.deepEqual(await page.loadSpendingMonthInsight({ knowledgeAt: knowledgeAt - 1, month: "2026-01" }), staleResult);
    assert.deepEqual(await page.loadSpendingMerchantStats({ knowledgeAt: knowledgeAt - 1, purchaseId: "transaction:x" }), staleResult);
    assert.deepEqual(await page.loadSpendingPendingOverview({ knowledgeAt }), {
      schemaVersion: 1, knowledgeAt, pendingCount: 0, strongCount: 0, affectedByCurrency: [], strongPairs: [],
    });
    assert.deepEqual(await page.loadSpendingMergeLog({ knowledgeAt }), { schemaVersion: 1, knowledgeAt, entries: [], nextCursor: null });
    assert.deepEqual(await page.loadSpendingMonthInsight({ knowledgeAt, month: "2026-01" }), { schemaVersion: 1, knowledgeAt, month: "2026-01", largestByCurrency: [] });
    const unknownPair = { candidateId: "sha256:unknown", invoiceIdentityId: "00000000-0000-4000-8000-000000000001", transactionIdentityId: "00000000-0000-4000-8000-000000000002" };
    const conflict = await page.confirmSpendingStrongCandidates({ shownKnowledgeAt: knowledgeAt, pairs: [unknownPair] });
    assert.deepEqual(conflict, { status: "conflict", knowledgeAt, conflicts: [unknownPair], strongPairs: [] }, "the worker command rejects a pair that is not pending");

    assert.ok(!("stale" in committedPage));
    assert.deepEqual(committedPage.records, [], "the version-bound purchase page must omit this ineligible source fact");
    assert.ok(
      spending.canonical.knowledgePoint >= committed.commitSequence,
      "spending must observe at least the source commit knowledge point (projection may add a derived canonical commit)",
    );
    await Promise.all(stops.splice(0).map((stop) => stop()));
    await client.close();

    const persistedDatabase = await PGlite.create(dataDir);
    try {
      const persistedTransactions = await persistedDatabase.query<{ transaction_id: string }>(
        `SELECT encode(transaction_id, 'hex') AS transaction_id
           FROM current_transactions
          WHERE transaction_id = decode($1, 'hex')`,
        [committedTransactionId.replaceAll("-", "")],
      );
      assert.equal(
        persistedTransactions.rows.length,
        1,
        "the committed ineligible transaction fact must remain durable even though compact purchase pages omit it",
      );
    } finally {
      await persistedDatabase.close();
    }

    const reopenedWorker = start();
    const reopened = createPGliteViewWorkerClient(reopenedWorker);
    try {
      const persistedOverview = await reopened.financial.registry.overviewCurrent();
      const persistedSpending = await reopened.financial.registry.spendingCurrent();
      const reopenedPage = createPGliteFinancialPageClient(reopened.financial, reopened.subscribe);
      assert.equal(persistedOverview.accounts.length, 1, "canonical account must survive worker close/reopen");
      assert.deepEqual(persistedSpending.canonical.transactions, [], "reopened Spending remains a compact summary");
      assert.ok(persistedSpending.purchaseReport.summary, "reopened Spending retains its compact summary");
      assert.equal(persistedSpending.purchaseReport.summary.recordCount, 0);
      const persistedPage = await reopenedPage.loadSpendingRecordPage({
        knowledgeAt: persistedSpending.purchaseReport.knowledgeAt,
        month: "2026-01",
        day: "2026-01-01",
      });
      assert.ok(!("stale" in persistedPage));
      assert.deepEqual(persistedPage.records, [], "the empty eligible purchase page must survive worker close/reopen");
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
  const page = createPGliteFinancialPageClient(client.financial, client.subscribe);
  try {
    const result = await client.financial.registry.mixedCommit({
      steps: [
        { kind: "source", request: sourceCommitRequest("raw-rpc").capture },
        { kind: "financial", request: sourceCommitRequest("derived-rpc") },
      ],
    });
    assert.equal(result.admissions.length, 1);
    assert.equal(result.financial.length, 1);
    const spending = await client.financial.registry.spendingCurrent();
    assert.deepEqual(spending.canonical.transactions, [], "the live read returns a compact summary, not full transaction rows");
    assert.equal(spending.purchaseReport.summary?.recordCount, 0, "the unclassified source fact is outside the purchase row set");
    const committedPage = await page.loadSpendingRecordPage({
      knowledgeAt: spending.purchaseReport.knowledgeAt,
      month: "2026-01",
      day: "2026-01-01",
    });
    assert.ok(!("stale" in committedPage));
    assert.deepEqual(committedPage.records, [], "the mixed command's unclassified fact is not a purchase row");
    const invalid = sourceCommitRequest("invalid-rpc");
    await assert.rejects(client.financial.registry.mixedCommit({
      steps: [
        { kind: "source", request: sourceCommitRequest("rollback-rpc").capture },
        { kind: "financial", request: { ...invalid, account: { ...invalid.account, accountType: "invalid" as "depository" } } },
      ],
    }), /PGlite financial operation failed/u);
    const reopened = await client.financial.registry.spendingCurrent();
    assert.deepEqual(reopened.canonical.transactions, [], "a failed mixed command keeps the compact response shape");
    assert.equal(reopened.purchaseReport.summary?.recordCount, 0, "a failed mixed command must not add a purchase row");
    const afterRollbackPage = await page.loadSpendingRecordPage({
      knowledgeAt: reopened.purchaseReport.knowledgeAt,
      month: "2026-01",
      day: "2026-01-01",
    });
    assert.ok(!("stale" in afterRollbackPage));
    assert.deepEqual(afterRollbackPage.records, [], "rollback preserves the empty eligible purchase page");
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
    dailyHistoryByAccount: {},
    accounts: [],
    holdingPrices: [],
    exchangeRates: [],
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

test("failed live subscription releases started dependencies and permits retry", async () => {
  let failSetup = true;
  let failRead = false;
  let activeDependencies = 0;
  const database = {
    live: {
      query: async () => {
        if (failSetup) {
          failSetup = false;
          throw new Error("dependency setup failed");
        }
        activeDependencies += 1;
        return { unsubscribe: async () => { activeDependencies -= 1; } };
      },
    },
  } as unknown as import("@electric-sql/pglite/live").PGliteWithLive;
  const registry = {
    overviewCurrent: async () => {
      if (failRead) throw new Error("initial read failed");
      return { availability: "empty" };
    },
  } as unknown as PGliteFinancialRegistry;
  const views = createPGliteFinancialLiveViews(database, registry);
  await assert.rejects(views.subscribe("financial.overview.current", {}, () => {}), /dependency setup failed/u);
  assert.equal(activeDependencies, 0, "a partial dependency setup must be drained");
  failRead = true;
  await assert.rejects(views.subscribe("financial.overview.current", {}, () => {}), /initial read failed/u);
  assert.equal(activeDependencies, 0, "failed initial recompute must be drained");
  failRead = false;
  const stop = await views.subscribe("financial.overview.current", {}, () => {});
  assert.equal(activeDependencies, 2, "a later subscription must start both dependencies");
  await stop();
  assert.equal(activeDependencies, 0);
});

test("financial operation names stay allowlisted and transport failures are typed", () => {
  assert.equal(PGLITE_FINANCIAL_OPERATIONS.includes("financial.overview.current"), true);
  assert.equal(PGLITE_FINANCIAL_OPERATIONS.includes("financial.source.commit"), true);
  assert.equal(PGLITE_FINANCIAL_OPERATIONS.includes("SELECT 1" as PGliteFinancialOperation), false);
});

test("a purchase category change publishes a new Spending version that reads the user category", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-financial-category-check-"));
  const worker = new Worker(new URL("./pglite-view-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: { dataDir },
  });
  const client = createPGliteViewWorkerClient(worker);
  const page = createPGliteFinancialPageClient(client.financial, client.subscribe);
  const snapshots: Array<{ purchaseReport: { knowledgeAt: number; summary?: { monthTotals: readonly { month: string }[] } } }> = [];
  let stop: (() => Promise<void>) | null = null;
  try {
    stop = await client.subscribe("financial.spending.current", {}, (rows) => {
      snapshots.push(rows[0] as (typeof snapshots)[number]);
    });
    await waitFor(() => snapshots.length >= 1);
    await client.financial.registry.einvoiceCommit({
      captureId: "category-change-invoice",
      sourceConnectionKey: "sha256:category-change-connection",
      identityEpoch: "sha256:category-change-epoch",
      subjectDigest: "sha256:category-change-subject",
      observedAt: "2026-09-02T00:00:00Z",
      scope: {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        kind: "bounded-range",
        completeness: "complete-range",
        invoiceCompleteness: "complete",
        itemCompleteness: "complete",
        absenceAuthority: "comparable-complete-range",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: { fixture: "category-change" } }],
      invoices: [fixtureInvoice({ stableKey: "AB33333333:2026-09-03", sellerName: "全聯實業股份有限公司", items: [{ sequence: 1, name: "鮮奶", amount: "90" }] })],
    } as never);
    await waitFor(() => (snapshots.at(-1)?.purchaseReport.summary?.monthTotals.length ?? 0) > 0);
    const before = snapshots.at(-1)!.purchaseReport;
    const month = before.summary!.monthTotals[0]!.month;
    const recordsAt = async (knowledgeAt: number) => {
      const read = await page.loadSpendingRecordPage({ knowledgeAt, month, limit: 50 });
      assert.ok(!("stale" in read), "the record page must read the published version");
      return read.records;
    };
    const records = await recordsAt(before.knowledgeAt);
    const purchase = records.find((record) => record.basis === "invoice");
    assert.ok(purchase, "the committed e-invoice is an invoice-only purchase");
    const result = await page.setSpendingPurchaseCategory({ purchaseId: purchase.purchaseId, knowledgeAt: before.knowledgeAt, categoryCode: "dining" });
    assert.equal(result.knowledgeAt, before.knowledgeAt + 1);
    await waitFor(() => (snapshots.at(-1)?.purchaseReport.knowledgeAt ?? 0) >= result.knowledgeAt);
    const after = (await recordsAt(result.knowledgeAt)).find((record) => record.purchaseId === purchase.purchaseId);
    assert.equal(after?.category.mode, "single");
    assert.equal(after?.category.mode === "single" ? after.category.categoryCode : null, "dining");
  } finally {
    await stop?.();
    await worker.terminate();
    await rm(dataDir, { recursive: true, force: true });
  }
});
