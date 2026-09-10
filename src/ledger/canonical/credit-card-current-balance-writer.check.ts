import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitFubonCreditCardCapture,
  buildFubonCreditCardStatementEvidenceKey,
  commitFubonCreditCardCapture,
  FUBON_CREDIT_CARD_CAPTURE_CONTRACT,
} from "./fubon-credit-card.ts";
import { canonicalSqlitePath, createCanonicalSourceStore } from "./canonical-source-store.ts";
import {
  admitCreditCardCurrentBalanceCapture,
  canonicalCreditCardCurrentBalanceIdentity,
  commitCreditCardCurrentBalanceCapture,
  creditCardCurrentBalanceSourceRecord,
  creditCardCurrentUsedAmountFromLimitAndAvailable,
  type CreditCardCurrentBalanceCaptureInput,
  type CreditCardExactAmount,
} from "./credit-card-current-balance-writer.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import { createCanonicalOverviewQuery } from "./canonical-overview-query.ts";
import { loadLiabilities } from "../../lib/liabilities/server/load-liabilities.ts";

const route = FUBON_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion;
const sourceConnectionKey = "sha256:credit-writer-check-connection";
const identity = {
  sourceConnectionKey,
  identityEpochKey: "credit-writer-check-epoch",
  humanAttestedAccountKey: "credit-writer-check-account",
};

function fubonCapture() {
  const grids = [
    ...["p1", "p2", "p3", "p4", "p5", "p6"].map((period, index) => ({
      kind: "billed" as const,
      period,
      currentPage: 1,
      pageSize: 100,
      maximumPageSize: 100,
      capturedRowCount: index === 0 ? 1 : 0,
      sourceDeclaredRowCount: index === 0 ? 1 : 0,
      sourceDeclaredScopeRowCount: index === 0 ? 1 : 0,
      terminal: true as const,
      terminalEvidence: "source-declared-total" as const,
    })),
    {
      kind: "unbilled" as const,
      period: "unbilled",
      currentPage: 1,
      pageSize: 100,
      maximumPageSize: 100,
      capturedRowCount: 0,
      sourceDeclaredRowCount: 0,
      sourceDeclaredScopeRowCount: 0,
      terminal: true as const,
      terminalEvidence: "source-declared-total" as const,
    },
  ];
  const statement = {
    statementKey: "credit-writer-check-statement",
    cycleStart: "2026-07-01",
    cycleEnd: "2026-07-31",
  } as const;
  return admitFubonCreditCardCapture({
    captureId: "credit-writer-check-statement-capture",
    identity,
    observedAt: "2026-09-09T10:00:00.000Z",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-09-09",
      completeness: {
        billedPeriods: ["p1", "p2", "p3", "p4", "p5", "p6"],
        unbilledIncluded: true,
        unfiltered: true,
        terminalGrids: true,
        rowCountsMatch: true,
        periodRowCounts: [1, 0, 0, 0, 0, 0],
        unbilledRowCount: 0,
        recordCount: 1,
        settledSummaryEvidencePresent: true,
        grids,
      },
    },
    instruments: [{
      instrumentKey: "credit-writer-check-instrument",
      cardMask: "****4281",
      role: "primary",
      evidence: {
        kind: "explicit-instrument-role",
        sourceRecordKey: "credit-writer-check-transaction",
        contractVersion: route,
      },
    }],
    transactions: [{
      sourceRecordKey: "credit-writer-check-transaction",
      occurrenceIndex: 0,
      instrumentKey: "credit-writer-check-instrument",
      consumeDate: "2026-08-01",
      postingDate: "2026-08-02",
      direction: "outflow",
      bookedAmount: "1.00",
      bookedCurrency: "TWD",
      description: "synthetic credit usage",
      billingStatus: "billed",
      statementKey: statement.statementKey,
    }],
    statements: [{
      ...statement,
      revisionKey: "credit-writer-check-statement-revision",
      issueDate: "2026-08-01",
      dueDate: "2026-08-20",
      currency: "TWD",
      balance: "1.00",
      minimumPayment: "1.00",
      transactionSourceKeys: ["credit-writer-check-transaction"],
      evidence: {
        kind: "issuer-settled-cycle-summary",
        sourceRecordKey: buildFubonCreditCardStatementEvidenceKey(identity, statement),
        settled: true,
      },
    }],
    relations: [],
  });
}

function exact(coefficient: string, scale = 0): CreditCardExactAmount {
  return { coefficient, scale };
}

function creditCapture(
  account: ReturnType<typeof fubonCapture>["identity"],
  values: Readonly<{
    captureId: string;
    httpDate: string;
    limit: CreditCardExactAmount;
    available: CreditCardExactAmount;
    endpoint?: string;
  }>,
) {
  const effectiveAt = new Date(Date.parse(values.httpDate)).toISOString();
  const estimate = {
    kind: "estimate" as const,
    basis: "credit-limit-minus-available" as const,
    formula: "正卡人信用額度-正卡人可用額度",
    limit: values.limit,
    available: values.available,
  };
  const sourceRecordKey = `sha256:${values.captureId}-source-record`;
  const source = creditCardCurrentBalanceSourceRecord({
    sourceRecordKey,
    providerKey: `sha256:${values.captureId}-provider`,
    sourceField: "正卡人信用額度-正卡人可用額度",
    balanceKind: "credit_used",
    currency: "TWD",
    value: creditCardCurrentUsedAmountFromLimitAndAvailable(values.limit, values.available),
    time: {
      effectiveAt,
      effectiveTimeBasis: "provider-http-date",
      effectiveTimeRuleVersion: "fubon/credit-card/current-used-credit-v1",
      sourceField: "HTTP Date",
      sourceValue: values.httpDate,
      contractVersion: "fubon/credit-card/current-used-credit-v1",
    },
    estimate,
    compact: {
      provider: "fubon",
      limitText: values.limit,
      availableText: values.available,
    },
  });
  const input: CreditCardCurrentBalanceCaptureInput = {
    captureId: values.captureId,
    authorityRoute: "fubon/credit-card/current-used-credit-v1",
    contractVersion: "fubon/credit-card/current-used-credit-v1",
    subjectDigest: account.accountNaturalKey,
    identity: canonicalCreditCardCurrentBalanceIdentity({
      integrationNamespace: "fubon",
      sourceConnectionKey: account.sourceConnectionKey,
      identityEpochKey: account.identityEpochKey,
      sourceAccountKey: account.accountNaturalKey,
    }),
    observedAt: "2026-09-09T10:30:00.000Z",
    scope: {
      startDate: effectiveAt.slice(0, 10),
      endDate: effectiveAt.slice(0, 10),
    },
    providerResponse: {
      endpoint:
        values.endpoint ??
        "https://ebank.taipeifubon.com.tw/B2C/cccqu/cccqu002/CCCQU002_Home.faces?showLogin=false&menuId=CCC0201",
      status: 200,
      cacheControl: "no-store, no-cache",
    },
    pages: [{
      pageOrdinal: 0,
      responseCode: "200",
      rowCount: 1,
      terminal: true,
      metadata: {
        sourceField: "正卡人信用額度-正卡人可用額度",
        httpDate: values.httpDate,
      },
    }],
    records: [source],
    observations: [{
      observationKey: "issuer-aggregate",
      balanceKind: "credit_used",
      balance: creditCardCurrentUsedAmountFromLimitAndAvailable(values.limit, values.available),
      currency: "TWD",
      time: {
        effectiveAt,
        effectiveTimeBasis: "provider-http-date",
        effectiveTimeRuleVersion: "fubon/credit-card/current-used-credit-v1",
        sourceField: "HTTP Date",
        sourceValue: values.httpDate,
        contractVersion: "fubon/credit-card/current-used-credit-v1",
      },
      sourceRecordKey,
      sourceField: "正卡人信用額度-正卡人可用額度",
      estimate,
    }],
  };
  return admitCreditCardCurrentBalanceCapture(input);
}

test("Fubon formula preserves exact positive and negative differences", () => {
  assert.deepEqual(
    creditCardCurrentUsedAmountFromLimitAndAvailable(exact("100000000", 2), exact("99999950", 2)),
    exact("5", 1),
  );
  assert.deepEqual(
    creditCardCurrentUsedAmountFromLimitAndAvailable(exact("500"), exact("700")),
    exact("-200"),
  );
});

test("Fubon normal menu endpoint may omit only the reviewed showLogin parameter", () => {
  const statementCapture = fubonCapture();
  const admitted = creditCapture(statementCapture.identity, {
    captureId: "credit-writer-check-fubon-menu-endpoint",
    httpDate: "Wed, 09 Sep 2026 02:26:43 GMT",
    limit: exact("100000000", 2),
    available: exact("99999950", 2),
    endpoint:
      "https://ebank.taipeifubon.com.tw/B2C/cccqu/cccqu002/CCCQU002_Home.faces?menuId=CCC0201",
  });
  assert.equal(admitted.observations.length, 1);
  assert.throws(
    () =>
      creditCapture(statementCapture.identity, {
        captureId: "credit-writer-check-fubon-unreviewed-query",
        httpDate: "Wed, 09 Sep 2026 02:26:43 GMT",
        limit: exact("100000000", 2),
        available: exact("99999950", 2),
        endpoint:
          "https://ebank.taipeifubon.com.tw/B2C/cccqu/cccqu002/CCCQU002_Home.faces?menuId=CCC0201&session=unexpected",
      }),
    /endpoint query .*not contract-approved/u,
  );
});

test("E.SUN current credit admits issuer query-time evidence and reviewed cache policy", () => {
  const queryTime = "2026/09/09 10:22:05";
  const effectiveAt = "2026-09-09T02:22:05.000Z";
  const identity = canonicalCreditCardCurrentBalanceIdentity({
    integrationNamespace: "esun",
    sourceConnectionKey: "sha256:esun-writer-check-connection",
    identityEpochKey: "sha256:esun-writer-check-epoch",
    sourceAccountKey: "sha256:esun-writer-check-account",
  });
  const estimate = {
    kind: "estimate" as const,
    basis: "provider-used-credit" as const,
    formula: "provider-reported-used-credit",
  };
  const time = {
    effectiveAt,
    effectiveTimeBasis: "provider-query-time" as const,
    effectiveTimeRuleVersion: "esun/credit-card/current-used-credit-v1",
    sourceField: "查詢時間" as const,
    sourceValue: queryTime,
    contractVersion: "esun/credit-card/current-used-credit-v1",
  };
  const value = exact("12345");
  const sourceRecordKey = "sha256:esun-writer-check-source-record";
  const source = creditCardCurrentBalanceSourceRecord({
    sourceRecordKey,
    providerKey: "sha256:esun-writer-check-provider",
    sourceField: "已用額度",
    balanceKind: "credit_used",
    currency: "TWD",
    value,
    time,
    estimate,
    compact: { provider: "esun", aggregate: "歸戶", queryTime, usedCredit: "12345" },
  });
  const admitted = admitCreditCardCurrentBalanceCapture({
    captureId: "esun-writer-check-capture",
    authorityRoute: "esun/credit-card/current-used-credit-v1",
    contractVersion: "esun/credit-card/current-used-credit-v1",
    subjectDigest: "sha256:esun-writer-check-subject",
    identity,
    observedAt: "2026-09-09T02:23:00.000Z",
    scope: { startDate: "2026-09-09", endDate: "2026-09-09" },
    providerResponse: {
      endpoint: "https://ebank.esunbank.com.tw/l1/l2/dispatcher?clean=true&taskId=FCM01006&appId=FCM&menuId=MFCM0204",
      status: 200,
      cacheControl: 'no-cache="set-cookie, set-cookie2"',
    },
    pages: [{
      pageOrdinal: 0,
      responseCode: "200",
      rowCount: 1,
      terminal: true,
      metadata: { sourceField: "已用額度", aggregate: "歸戶", queryTime },
    }],
    records: [source],
    observations: [{
      observationKey: "issuer-aggregate",
      balanceKind: "credit_used",
      balance: value,
      currency: "TWD",
      time,
      sourceRecordKey,
      sourceField: "已用額度",
      estimate,
    }],
  });
  assert.equal(admitted.observations[0]?.time.effectiveTimeBasis, "provider-query-time");
  assert.equal(admitted.observations[0]?.time.sourceValue, queryTime);
});

test("credit-card estimates attach to one issuer account, retain formula evidence, deduplicate, and select by as-of", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    const statementCapture = fubonCapture();
    await commitFubonCreditCardCapture(store, statementCapture);
    const first = creditCapture(statementCapture.identity, {
      captureId: "credit-writer-check-current-a",
      httpDate: "Wed, 09 Sep 2026 02:26:43 GMT",
      limit: exact("100000000", 2),
      available: exact("99999950", 2),
    });
    const firstResult = await commitCreditCardCurrentBalanceCapture(store, first);
    assert.equal(firstResult.revisionCount, 1);
    assert.equal(firstResult.deduplicatedRevisionCount, 0);

    const repeated = await commitCreditCardCurrentBalanceCapture(store, creditCapture(statementCapture.identity, {
      captureId: "credit-writer-check-current-a-repeat",
      httpDate: "Wed, 09 Sep 2026 02:26:43 GMT",
      limit: exact("100000000", 2),
      available: exact("99999950", 2),
    }));
    assert.equal(repeated.revisionCount, 0);
    assert.equal(repeated.deduplicatedRevisionCount, 1);

    await assert.rejects(
      () =>
        commitCreditCardCurrentBalanceCapture(
          store,
          creditCapture(statementCapture.identity, {
            captureId: "credit-writer-check-current-a-conflicting-components",
            httpDate: "Wed, 09 Sep 2026 02:26:43 GMT",
            // The difference remains 50.00, while both source operands change.
            limit: exact("100000100", 2),
            available: exact("100000050", 2),
          }),
        ),
      /conflicting formula components/u,
    );

    const second = creditCapture(statementCapture.identity, {
      captureId: "credit-writer-check-current-b",
      httpDate: "Thu, 10 Sep 2026 02:26:43 GMT",
      limit: exact("100000000", 2),
      available: exact("99999800", 2),
    });
    const secondResult = await commitCreditCardCurrentBalanceCapture(store, second);
    assert.equal(secondResult.revisionCount, 1);
    const runtime = createCanonicalProjectionRuntime(store.db);
    const scope = { sourceConnectionKey };
    const current = runtime.read({
      kind: "current",
      families: ["credit-card-balances"],
      scope,
    }).families["credit-card-balances"];
    assert.equal(current.length, 1, "supplementary card evidence cannot double-count the issuer account");
    assert.deepEqual(current[0], {
      ...current[0],
      estimateKind: "estimate",
      estimateBasis: "credit-limit-minus-available",
      estimateFormula: "正卡人信用額度-正卡人可用額度",
      componentLimitCoefficient: "100000000",
      componentLimitScale: 2,
      componentAvailableCoefficient: "99999800",
      componentAvailableScale: 2,
      coefficient: "2",
      scale: 0,
    });
    const firstSequence = firstResult.commitSequence;
    const historical = runtime.read({
      kind: "historical",
      families: ["overview-credit-card-balances"],
      scope,
      cutoff: { financialAt: "2026-09-09", knowledgeAt: firstSequence },
    }).families["overview-credit-card-balances"];
    assert.equal(historical.length, 1);
    assert.equal(historical[0]?.coefficient, "5");
    assert.equal(historical[0]?.scale, 1);
    assert.equal(historical[0]?.projectionCommitId, null);
    assert.equal(historical[0]?.estimateKind, "estimate");
    assert.throws(
      () => store.db.prepare("UPDATE credit_card_balance_estimate_details SET formula = 'fake'").run(),
      /immutable/u,
    );
  } finally {
    store.close();
  }
});

test("overview liability totals include the estimate with explicit lineage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "credit-card-overview-estimate-"));
  const store = createCanonicalSourceStore(canonicalSqlitePath(directory));
  try {
    const statementCapture = fubonCapture();
    await commitFubonCreditCardCapture(store, statementCapture);
    await commitCreditCardCurrentBalanceCapture(store, creditCapture(statementCapture.identity, {
      captureId: "credit-writer-check-overview",
      httpDate: "Wed, 09 Sep 2026 02:26:43 GMT",
      limit: exact("100000000", 2),
      available: exact("99999950", 2),
    }));
    store.close();

    const overview = await createCanonicalOverviewQuery(directory).current();
    const account = overview.projection.accounts.find((row) => row.kind === "credit-card");
    assert.ok(account);
    assert.deepEqual(account.amounts.map((amount) => amount.exact), [{ coefficient: "5", scale: 1 }]);
    assert.equal(account.amounts[0]?.traces[0]?.kind, "credit-card-used-credit-estimate");
    assert.equal(account.amounts[0]?.traces[0]?.estimateKind, "estimate");
    assert.equal(account.creditCard?.currentUsedCredit?.estimateBasis, "credit-limit-minus-available");

    const liabilities = await loadLiabilities(directory);
    assert.deepEqual(liabilities.accounts[0]?.amountLines[0]?.exact, { coefficient: "5", scale: 1 });
    assert.deepEqual(liabilities.accounts[0]?.amountLines[0]?.traces?.[0]?.estimateBasis, "credit-limit-minus-available");
  } finally {
    try {
      store.close();
    } catch {
      // The successful path closes before opening the read-only overview.
    }
    await rm(directory, { recursive: true, force: true });
  }
});
