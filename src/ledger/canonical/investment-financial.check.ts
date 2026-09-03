import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositRecord,
} from "./canonical-financial-deposit-writer.ts";
import { admitForeignCurrencyDepositCapture } from "./foreign-currency-deposit.ts";
import {
  admitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCaptureBatch,
  createCanonicalInvestmentStore,
  deriveYuantaForeignSettlementLinkageKey,
  deriveInvestmentHoldingCorrectionProofKey,
  queryCanonicalInvestmentCurrent,
  queryCanonicalInvestmentHistorical,
  queryCanonicalInvestmentLineage,
  resolveCanonicalInvestmentFundingRelations,
  YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
  type InvestmentCaptureInput,
} from "./investment-financial.ts";
import { queryCanonicalLoanCurrent } from "./loan-financial.ts";
import { queryCanonicalSourceCurrent } from "./canonical-source-store.ts";

const token = (label: string) =>
  `sha256:${createHash("sha256").update(label).digest("base64url")}`;

const SYNTHETIC_SOURCE_LINKED_ACCOUNT = "9001" + "0020" + "0300" + "4005";
const SYNTHETIC_YUANTA_SETTLEMENT_ACCOUNT = "9001" + "0020" + "0300" + "4006";
const SYNTHETIC_YUANTA_NO_NOTE_ACCOUNT = "9001" + "0020" + "0300" + "4007";
const SYNTHETIC_YUANTA_OTHER_LOGIN_ACCOUNT = "9001" + "0020" + "0300" + "4008";
const YUANTA_SETTLEMENT_LINKAGE_KEY =
  deriveYuantaForeignSettlementLinkageKey("synthetic-yuanta-login", "USD");
const YUANTA_SETTLEMENT_MARKET_EVIDENCE = {
  sourceMarketCode: "52",
  settlementMarket: YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
  settlementMarketContractVersion:
    YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
} as const;

function fixture(
  captureId = "yuanta-trade-sanitized-1",
): InvestmentCaptureInput {
  return {
    captureId,
    sourceId: "yuanta-trade",
    authorityRoute: "yuanta-trade/investment/canonical-v1",
    contractVersion: "yuanta-trade/investment/canonical-v1",
    observedAt: "2026-08-31T12:00:00.000Z",
    identity: {
      sourceConnectionKey: token("a"),
      identityEpochKey: token("b"),
      accountKey: token("c"),
      accountType: "investment",
      reportingCurrency: "TWD",
    },
    scope: { effectiveOn: "2026-08-30", complete: true },
    securities: [
      {
        securityKey: "yuanta-trade:TWSE:2330",
        producerSecurityId: "TWSE:2330",
        name: "SANITIZED EQUITY",
        ticker: "2330",
        currency: "TWD",
        identityEvidence: {
          kind: "producer-security-id",
          contractVersion: "yuanta-trade/investment/canonical-v1",
        },
      },
    ],
    holdings: [
      {
        measurementKey: token("d"),
        measurementSubjectKey: token("s"),
        sourceRecordKey: token("e"),
        securityKey: "yuanta-trade:TWSE:2330",
        quantity: { coefficient: "1000", scale: 0 },
        valuation: { coefficient: "500000", scale: 0, currency: "TWD" },
        effectiveOn: "2026-08-30",
        observedAt: "2026-08-31T12:00:00.000Z",
        effectiveTimeEvidence: {
          kind: "source-reported-as-of",
          sourceRecordKey: token("e"),
          sourceField: "as_of_date",
          value: "2026-08-30",
          contractVersion: "yuanta-trade/investment/canonical-v1",
        },
        lineage: {
          page: 0,
          row: 0,
          contractVersion: "yuanta-trade/investment/canonical-v1",
        },
      },
    ],
    transactions: [
      {
        sourceRecordKey: token("f"),
        transactionKey: token("g"),
        securityKey: "yuanta-trade:TWSE:2330",
        action: "buy",
        quantity: { coefficient: "1000", scale: 0 },
        cashEffect: { coefficient: "500000", scale: 0, currency: "TWD" },
        effectiveOn: "2026-08-29",
        fundingEvidence: { kind: "unresolved", sourceRecordKey: token("f") },
      },
    ],
    margin: {
      kind: "embedded",
      amount: { coefficient: "25000", scale: 0, currency: "TWD" },
      effectiveOn: "2026-08-30",
      sourceRecordKey: token("h"),
    },
  };
}

function fundingEvidence(
  sourceRecordKey = token("f"),
  settlementGroupKey = token("l"),
) {
  return {
    kind: "source-linked-account" as const,
    sourceRecordKey,
    fundingAccountKey: token("p"),
    fundingAccountNumber: SYNTHETIC_SOURCE_LINKED_ACCOUNT,
    sourceLinkageKey: token("k"),
    settlementGroupKey,
    settlementEffectiveOn: "2026-08-31",
    settlementModel: "single-transaction" as const,
    contractVersion: "yuanta-trade/investment/canonical-v1",
  };
}

function depositCapture(
  label: string,
  amounts: readonly string[] = ["500000"],
  sourceIdentityLabel = label,
) {
  const records: CanonicalFinancialDepositRecord[] = amounts.map(
    (coefficient, index) => ({
      occurrenceKey: token(`${sourceIdentityLabel}:occurrence:${index}`),
      collisionKey: token(`${sourceIdentityLabel}:collision:${index}`),
      providerKey: token(`${sourceIdentityLabel}:provider:${index}`),
      contentHash: token(`${sourceIdentityLabel}:content:${index}`),
      sequenceLexeme: String(index),
      compactJson: JSON.stringify({ label: sourceIdentityLabel, index }),
      amount: { coefficient, scale: 0 },
      balanceAfter: { coefficient: "1000000", scale: 0 },
      currency: "TWD",
      direction: "outflow",
      sourceTime: {
        localDate: "2026-08-31",
        localTime: `09:00:${String(index).padStart(2, "0")}`,
        timeZone: "Asia/Taipei",
        epochMilliseconds: Date.parse(
          `2026-08-31T09:00:${String(index).padStart(2, "0")}+08:00`,
        ),
        precision: "second",
        timeOrigin: "source_reported",
      },
      effectiveOn: "2026-08-31",
      transactionDateTimeLocal: `2026-08-31T09:00:${String(index).padStart(2, "0")}`,
      description: "SANITIZED BROKER SETTLEMENT",
    }),
  );
  const route = "fubon/domestic-deposit/human-attested-v1";
  return admitCanonicalFinancialDepositCapture({
    captureId: token(`${label}:capture`),
    authorityRoute: route,
    contractVersion: route,
    identity: {
      integrationNamespace: "fubon",
      sourceConnectionKey: token("x"),
      identityEpochKey: token("y"),
      stream: "domestic-deposit",
      recordKind: "fubon-domestic-deposit",
      subjectDigest: token(`${sourceIdentityLabel}:subject`),
      accountNo: SYNTHETIC_SOURCE_LINKED_ACCOUNT,
      accountType: "depository",
      currency: "TWD",
    },
    observedAt: "2026-09-01T00:00:00.000Z",
    scope: {
      startDate: "2026-08-01",
      endDate: "2026-09-01",
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "source-terminal-statement-range",
      completenessRuleVersion: route,
      absenceAuthority: null,
      contractFingerprint: token(`${sourceIdentityLabel}:contract`),
      preflightFingerprint: token(`${sourceIdentityLabel}:preflight`),
      pageCount: 1,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: route,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: route,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: route,
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      requireBalance: true,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: records.length,
        responseDigest: token(`${sourceIdentityLabel}:page`),
        proofKind: "source-terminal-statement-range",
        contractFingerprint: token(`${sourceIdentityLabel}:contract`),
        preflightFingerprint: token(`${sourceIdentityLabel}:preflight`),
        metadataJson: "{}",
      },
    ],
    records,
  });
}

function yuantaForeignSettlementCapture(
  label: string,
  effectiveOn: string,
  amount: string,
  direction: "inflow" | "outflow",
  options: {
    accountNo?: string;
    fixedNote?: boolean;
    linkageKey?: string;
    sourceConnectionKey?: string;
  } = {},
) {
  return yuantaForeignSettlementCaptureRows(label, [
    { effectiveOn, amount, direction },
  ], options);
}

function yuantaForeignSettlementCaptureRows(
  label: string,
  rows: ReadonlyArray<{
    effectiveOn: string;
    amount: string;
    direction: "inflow" | "outflow";
  }>,
  options: {
    accountNo?: string;
    fixedNote?: boolean;
    linkageKey?: string;
    sourceConnectionKey?: string;
  } = {},
) {
  const accountNo = options.accountNo ?? SYNTHETIC_YUANTA_SETTLEMENT_ACCOUNT;
  const fixedNote = options.fixedNote ?? true;
  return admitForeignCurrencyDepositCapture({
    source: "yuanta",
    accountNo,
    sourceConnectionKey:
      options.sourceConnectionKey ?? token("yuanta-bank-connection"),
    identityEpochKey: token("yuanta-bank-epoch"),
    observedAt: "2026-08-31T12:00:00.000Z",
    startDate: "2026-08-01",
    endDate: "2026-09-01",
    completeness: "complete-range",
    captureCurrencyScope: { kind: "currency", currency: "USD" },
    captureOccurrenceId: `yuanta-foreign-settlement-${label}`,
    accountType: "depository",
    records: rows.map(({ effectiveOn, amount, direction }, index) => ({
        sourceKey: `${label}:${index}:${effectiveOn}:${amount}`,
        amount,
        direction,
        currencyEvidence: { kind: "row" as const, currency: "USD" },
        balanceAfter: "10000.00",
        sourceTime: {
          localDate: effectiveOn,
          localTime: "09:00:00",
          precision: "second",
          timeOrigin: "source_reported",
        },
        description: fixedNote
          ? direction === "outflow"
            ? "複委託扣"
            : "複委託入"
          : direction === "outflow"
            ? "股票買入"
            : "股票賣出",
        sourcePayload: {
          transactionInfo: fixedNote
            ? direction === "outflow"
              ? "淨額扣"
              : "淨額入"
            : "行動互轉",
          settlementLinkageKey:
            options.linkageKey ?? YUANTA_SETTLEMENT_LINKAGE_KEY,
          settlementLinkageContractVersion:
            YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
        },
      })),
  });
}

test("Yuanta settlement linkage is stable for one normalized login and fenced between logins", () => {
  assert.equal(
    deriveYuantaForeignSettlementLinkageKey(" SYNTHETIC-YUANTA-LOGIN ", "usd"),
    YUANTA_SETTLEMENT_LINKAGE_KEY,
  );
  assert.notEqual(
    deriveYuantaForeignSettlementLinkageKey(
      "other-synthetic-yuanta-login",
      "USD",
    ),
    YUANTA_SETTLEMENT_LINKAGE_KEY,
  );
});

test("investment capture is atomic, restart-safe, and preserves independent measurements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canonical-investment-"));
  const path = join(dir, "canonical.sqlite");
  try {
    let store = createCanonicalInvestmentStore(path);
    await commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(fixture()),
    );
    await commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(fixture("yuanta-trade-sanitized-2")),
    );
    let current = queryCanonicalInvestmentCurrent(store, token("a"));
    assert.equal(current.accounts.length, 1);
    assert.equal(current.securities.length, 1);
    assert.equal(current.holdings.length, 1);
    assert.equal(
      queryCanonicalInvestmentHistorical(store, token("a")).holdings.length,
      2,
    );
    assert.equal(current.transactions[0]?.action, "buy");
    assert.equal(current.marginBalances[0]?.balanceKind, "margin_loan");
    assert.equal(current.transactions[0]?.fundingEvidence.kind, "unresolved");
    assert.equal(current.relations.length, 0);
    assert.deepEqual(
      {
        ...(store.db
          .prepare(
            "SELECT s.scope_start AS startDate,s.scope_end AS endDate FROM capture_scopes s JOIN source_captures c ON c.capture_id=s.capture_id WHERE c.capture_key=?",
          )
          .get("yuanta-trade-sanitized-1") as object),
      },
      { startDate: "2026-08-29", endDate: "2026-08-30" },
    );
    assert.deepEqual(
      store.db
        .prepare(
          "SELECT DISTINCT t.time_origin AS timeOrigin FROM transaction_time_observations t JOIN source_records r ON r.source_record_id=t.source_record_id JOIN source_captures c ON c.capture_id=r.capture_id WHERE c.capture_key=?",
        )
        .all("yuanta-trade-sanitized-1")
        .map((row) => ({ ...row })),
      [{ timeOrigin: "defaulted_local_midnight" }],
    );
    store.close();
    store = createCanonicalInvestmentStore(path);
    current = queryCanonicalInvestmentCurrent(store, token("a"));
    assert.equal(current.holdings.length, 1);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("investment admission fails closed for ambiguous actions and unstable security identity", () => {
  assert.throws(
    () =>
      admitCanonicalInvestmentCapture({
        ...fixture(),
        transactions: [
          { ...fixture().transactions[0]!, action: "unknown" as "buy" },
        ],
      }),
    /supported provider event/,
  );
  assert.throws(
    () =>
      admitCanonicalInvestmentCapture({
        ...fixture(),
        securities: [
          { ...fixture().securities[0]!, securityKey: "SANITIZED EQUITY" },
        ],
      }),
    /producer-scoped/,
  );
  assert.doesNotThrow(() =>
    admitCanonicalInvestmentCapture({
      ...fixture(),
      observedAt: "2026-08-30T12:00:00.000Z",
      holdings: [
        { ...fixture().holdings[0]!, observedAt: "2026-08-30T12:00:00.000Z" },
      ],
    }),
  );
  const offset = fixture();
  offset.observedAt = "2026-08-31T20:00:00+08:00";
  offset.holdings[0] = {
    ...offset.holdings[0]!,
    observedAt: offset.observedAt,
  };
  assert.equal(
    admitCanonicalInvestmentCapture(offset).observedAt,
    "2026-08-31T12:00:00.000Z",
  );
  assert.throws(
    () =>
      admitCanonicalInvestmentCapture({
        ...fixture(),
        observedAt: "2026-08-31 12:00:00",
      }),
    /RFC3339/,
  );
  assert.throws(
    () =>
      admitCanonicalInvestmentCapture({
        ...fixture(),
        observedAt: "2026-02-30T12:00:00Z",
      }),
    /RFC3339/,
  );
});

test("investment admission preserves source-proven corporate actions and dividends without funding relations", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("source-proven-non-trade-events");
  const base = input.transactions[0]!;
  input.transactions = [
    {
      ...base,
      sourceRecordKey: token("corporate-action-in-record"),
      transactionKey: token("corporate-action-in-transaction"),
      action: "corporate_action_in",
      quantity: { coefficient: "5", scale: 0 },
      cashEffect: { coefficient: "0", scale: 0, currency: "USD" },
      fundingEvidence: {
        kind: "unresolved",
        sourceRecordKey: token("corporate-action-in-record"),
      },
    },
    {
      ...base,
      sourceRecordKey: token("corporate-action-out-record"),
      transactionKey: token("corporate-action-out-transaction"),
      action: "corporate_action_out",
      quantity: { coefficient: "5", scale: 0 },
      cashEffect: { coefficient: "0", scale: 0, currency: "USD" },
      fundingEvidence: {
        kind: "unresolved",
        sourceRecordKey: token("corporate-action-out-record"),
      },
    },
    {
      ...base,
      sourceRecordKey: token("dividend-record"),
      transactionKey: token("dividend-transaction"),
      action: "dividend",
      quantity: { coefficient: "0", scale: 0 },
      cashEffect: { coefficient: "125", scale: 2, currency: "USD" },
      fundingEvidence: {
        kind: "unresolved",
        sourceRecordKey: token("dividend-record"),
      },
    },
  ];
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  const current = queryCanonicalInvestmentCurrent(store, token("a"));
  assert.deepEqual(
    current.transactions.map(({ action }) => action),
    ["corporate_action_in", "corporate_action_out", "dividend"],
  );
  assert.equal(current.relations.length, 0);
  store.close();
});

test("a correction target is resolved against prior canonical measurements", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture();
  input.holdings[0] = {
    ...input.holdings[0]!,
    correction: {
      ofMeasurementKey: token("z"),
      stableCorrectionKey: deriveInvestmentHoldingCorrectionProofKey({
        contractVersion: input.contractVersion,
        sourceRecordKey: token("e"),
        targetSourceRecordKey: token("k"),
        measurementSubjectKey: token("s"),
        effectiveOn: "2026-08-30",
      }),
      sourceRecordKey: token("e"),
      targetSourceRecordKey: token("k"),
      proofKind: "source-stable-correction-key",
      contractVersion: input.contractVersion,
      priorEffectiveOn: "2026-08-30",
    },
  };
  await assert.rejects(
    commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(input),
    ),
    /correction target/,
  );
  store.close();
});

test("a contract-proven correction revises current selection and preserves history", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(fixture("base")),
  );
  const corrected = fixture("correction");
  corrected.observedAt = "2026-09-01T12:00:00.000Z";
  corrected.holdings[0] = {
    ...corrected.holdings[0]!,
    measurementKey: token("i"),
    correction: {
      ofMeasurementKey: token("d"),
      stableCorrectionKey: deriveInvestmentHoldingCorrectionProofKey({
        contractVersion: corrected.contractVersion,
        sourceRecordKey: token("j"),
        targetSourceRecordKey: token("e"),
        measurementSubjectKey: token("s"),
        effectiveOn: "2026-08-30",
      }),
      sourceRecordKey: token("j"),
      targetSourceRecordKey: token("e"),
      proofKind: "source-stable-correction-key",
      contractVersion: corrected.contractVersion,
      priorEffectiveOn: "2026-08-30",
    },
    sourceRecordKey: token("j"),
    observedAt: corrected.observedAt,
    valuation: { coefficient: "510000", scale: 0, currency: "TWD" },
    effectiveTimeEvidence: {
      ...corrected.holdings[0]!.effectiveTimeEvidence,
      sourceRecordKey: token("j"),
    },
  };
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(corrected),
  );
  assert.equal(
    queryCanonicalInvestmentCurrent(store, token("a")).holdings.length,
    1,
  );
  assert.equal(
    queryCanonicalInvestmentHistorical(store, token("a")).holdings.length,
    2,
  );
  assert.equal(
    queryCanonicalInvestmentLineage(store, token("a"), token("d")).holdings
      .length,
    2,
  );
  store.close();
});

test("a correction cannot cross Security or measurement-subject identity", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(fixture("subject-base")),
  );
  const correction = fixture("wrong-subject");
  correction.holdings[0] = {
    ...correction.holdings[0]!,
    measurementKey: token("i"),
    measurementSubjectKey: token("x"),
    sourceRecordKey: token("j"),
    effectiveTimeEvidence: {
      ...correction.holdings[0]!.effectiveTimeEvidence,
      sourceRecordKey: token("j"),
    },
    correction: {
      ofMeasurementKey: token("d"),
      stableCorrectionKey: deriveInvestmentHoldingCorrectionProofKey({
        contractVersion: correction.contractVersion,
        sourceRecordKey: token("j"),
        targetSourceRecordKey: token("e"),
        measurementSubjectKey: token("x"),
        effectiveOn: "2026-08-30",
      }),
      sourceRecordKey: token("j"),
      targetSourceRecordKey: token("e"),
      proofKind: "source-stable-correction-key",
      contractVersion: correction.contractVersion,
      priorEffectiveOn: "2026-08-30",
    },
  };
  await assert.rejects(
    commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(correction),
    ),
    /same account, Security, measurement subject/,
  );
  store.close();
});

test("transaction-only Securities remain queryable", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("transaction-only");
  input.holdings = [];
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  const current = queryCanonicalInvestmentCurrent(store, token("a"));
  assert.equal(current.holdings.length, 0);
  assert.equal(current.securities.length, 1);
  assert.equal(current.transactions.length, 1);
  store.close();
});

test("independent margin borrowing creates a canonical liability account", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("independent-margin");
  input.margin = {
    kind: "independent-account",
    accountKey: token("m"),
    accountType: "loan",
    amount: { coefficient: "25000", scale: 0, currency: "TWD" },
    effectiveOn: "2026-08-30",
    sourceRecordKey: token("n"),
    identityEvidence: {
      kind: "producer-margin-account-id",
      producerAccountId: "SANITIZED-MARGIN-ACCOUNT",
      contractVersion: "loan/canonical/v1.yuanta",
    },
    sourceEventCode: "LOAN-DISBURSEMENT",
  };
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  const liability = store.db
    .prepare(
      "SELECT account_type AS accountType FROM financial_accounts WHERE stream='loan'",
    )
    .get() as { accountType: string };
  assert.equal(liability.accountType, "loan");
  assert.equal(
    Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM source_captures WHERE stream='loan'",
          )
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  const loan = queryCanonicalLoanCurrent(store, { sourceId: "yuanta" });
  assert.equal(loan.accounts.length, 1);
  assert.equal(loan.balanceObservations.length, 1);
  store.close();
});

test("independent margin credit uses the canonical credit liability path", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("independent-margin-credit");
  input.margin = {
    kind: "independent-account",
    accountKey: token("u"),
    accountType: "credit",
    amount: { coefficient: "15000", scale: 0, currency: "TWD" },
    effectiveOn: "2026-08-30",
    sourceRecordKey: token("v"),
    identityEvidence: {
      kind: "producer-margin-account-id",
      producerAccountId: "SANITIZED-MARGIN-CREDIT",
      contractVersion: "yuanta-trade/investment/margin-credit-canonical-v1",
    },
    sourceEventCode: "LOAN-DISBURSEMENT",
  };
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  assert.deepEqual(
    queryCanonicalInvestmentCurrent(
      store,
      token("a"),
    ).independentMarginAccounts.map((row) => ({ ...row })),
    [{ accountType: "credit", currency: "TWD" }],
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM source_captures WHERE stream='investment-margin'",
          )
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  store.close();
});

test("identity epoch participates in account identity and Security drift rolls back atomically", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(fixture("epoch-1")),
  );
  const nextEpoch = fixture("epoch-2");
  nextEpoch.identity.identityEpochKey = token("q");
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(nextEpoch),
  );
  assert.equal(
    queryCanonicalInvestmentCurrent(store, token("a")).accounts.length,
    2,
  );
  const drift = fixture("security-drift");
  drift.securities[0] = { ...drift.securities[0]!, name: "CHANGED LABEL" };
  await assert.rejects(
    commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(drift),
    ),
    /Immutable Security/,
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM source_captures WHERE capture_key='security-drift'",
          )
          .get() as { count: number }
      ).count,
    ),
    0,
  );
  store.close();
});

test("a multi-account investment batch has one atomic visibility boundary", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const first = fixture("batch-first");
  const conflicting = fixture("batch-conflicting");
  conflicting.identity.accountKey = token("r");
  conflicting.securities[0] = {
    ...conflicting.securities[0]!,
    name: "CONFLICTING LABEL",
  };
  await assert.rejects(
    commitCanonicalInvestmentCaptureBatch(store, [
      admitCanonicalInvestmentCapture(first),
      admitCanonicalInvestmentCapture(conflicting),
    ]),
    /Immutable Security/,
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM canonical_commits")
          .get() as {
          count: number;
        }
      ).count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM investment_accounts")
          .get() as {
          count: number;
        }
      ).count,
    ),
    0,
  );
  store.close();
});

test("verified settlement account evidence resolves a single investment funding relation", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("verified-settlement");
  input.transactions[0] = {
    ...input.transactions[0]!,
    fundingEvidence: fundingEvidence(),
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    depositCapture("verified-settlement"),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 1,
    noAdmission: 0,
    reasons: [],
  });
  const resolutionCommitCount = Number(
    (
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM canonical_commits WHERE commit_kind='relation_resolution'",
        )
        .get() as { count: number }
    ).count,
  );
  assert.equal(
    (await resolveCanonicalInvestmentFundingRelations(store)).resolved,
    1,
    "resolution is idempotent",
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM canonical_commits WHERE commit_kind='relation_resolution'",
          )
          .get() as { count: number }
      ).count,
    ),
    resolutionCommitCount,
    "an unchanged resolution does not create another commit",
  );
  const relation = queryCanonicalInvestmentCurrent(store, token("a"))
    .relations[0] as Record<string, unknown>;
  assert.equal(relation.settlementModel, "single-transaction");
  assert.equal(relation.investmentTransactionCount, 1);
  assert.equal(relation.coefficient, "500000");
  assert.equal(relation.direction, "outflow");
  store.close();
});

test("a complete source-linked zero-net settlement withdraws a stale relation", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("source-linked-zero-net-base");
  input.transactions[0] = {
    ...input.transactions[0]!,
    action: "buy",
    cashEffect: { coefficient: "500000", scale: 0, currency: "TWD" },
    fundingEvidence: {
      ...fundingEvidence(token("source-linked-zero-net-base-record"), token("source-linked-zero-net-group")),
      settlementModel: "account-currency-date-net",
    },
    sourceRecordKey: token("source-linked-zero-net-base-record"),
    transactionKey: token("source-linked-zero-net-base-transaction"),
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    depositCapture("source-linked-zero-net-base"),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  assert.equal(queryCanonicalInvestmentCurrent(store, token("a")).relations.length, 1);

  const offset = fixture("source-linked-zero-net-offset");
  offset.holdings = [];
  offset.margin = undefined;
  offset.scope.effectiveOn = "2026-08-31";
  offset.transactions[0] = {
    ...offset.transactions[0]!,
    sourceRecordKey: token("source-linked-zero-net-offset-record"),
    transactionKey: token("source-linked-zero-net-offset-transaction"),
    action: "sell",
    cashEffect: { coefficient: "500000", scale: 0, currency: "TWD" },
    effectiveOn: "2026-08-31",
    fundingEvidence: {
      ...fundingEvidence(token("source-linked-zero-net-offset-record"), token("source-linked-zero-net-group")),
      settlementModel: "account-currency-date-net",
    },
  };
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(offset),
  );

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["zero-net-settlement"],
  });
  assert.equal(queryCanonicalInvestmentCurrent(store, token("a")).relations.length, 0);
  store.close();
});

test("a new supporting source capture records provenance without duplicating a relation", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("source-linked-support-provenance");
  input.transactions[0] = {
    ...input.transactions[0]!,
    sourceRecordKey: token("source-linked-support-provenance-record"),
    transactionKey: token("source-linked-support-provenance-transaction"),
    fundingEvidence: fundingEvidence(
      token("source-linked-support-provenance-record"),
      token("source-linked-support-provenance-group"),
    ),
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    depositCapture("source-linked-support-provenance-base"),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  const relationCount = Number(
    (
      store.db
        .prepare("SELECT COUNT(*) AS count FROM investment_funding_relations")
        .get() as { count: number }
    ).count,
  );
  const resolutionCommitCount = Number(
    (
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM canonical_commits WHERE commit_kind='relation_resolution'",
        )
        .get() as { count: number }
    ).count,
  );
  const repeated = depositCapture(
    "source-linked-support-provenance-repeat",
    ["500000"],
    "source-linked-support-provenance-base",
  );
  await commitCanonicalFinancialDepositCapture(store, repeated);

  assert.equal((await resolveCanonicalInvestmentFundingRelations(store)).resolved, 1);
  assert.equal(
    Number(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM investment_funding_relations")
          .get() as { count: number }
      ).count,
    ),
    relationCount,
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM canonical_commits WHERE commit_kind='relation_resolution'",
          )
          .get() as { count: number }
      ).count,
    ),
    resolutionCommitCount + 1,
  );
  const supportReasons = store.db
    .prepare(
      `SELECT reason FROM investment_funding_relation_events
        WHERE event_kind='observed' ORDER BY rowid`,
    )
    .all() as Array<{ reason: string }>;
  assert.equal(supportReasons.length, 2);
  assert.match(supportReasons[1]!.reason, /^verified-settlement-account:sha256:/);

  const unchangedCommitCount = Number(
    (
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM canonical_commits WHERE commit_kind='relation_resolution'",
        )
        .get() as { count: number }
    ).count,
  );
  await resolveCanonicalInvestmentFundingRelations(store);
  assert.equal(
    Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM canonical_commits WHERE commit_kind='relation_resolution'",
          )
          .get() as { count: number }
      ).count,
    ),
    unchangedCommitCount,
  );
  store.close();
});

test("an incomplete source-linked zero-net capture preserves the current relation", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("source-linked-zero-net-incomplete-base");
  input.transactions[0] = {
    ...input.transactions[0]!,
    action: "buy",
    cashEffect: { coefficient: "500000", scale: 0, currency: "TWD" },
    sourceRecordKey: token("source-linked-zero-net-incomplete-base-record"),
    transactionKey: token("source-linked-zero-net-incomplete-base-transaction"),
    fundingEvidence: {
      ...fundingEvidence(
        token("source-linked-zero-net-incomplete-base-record"),
        token("source-linked-zero-net-incomplete-group"),
      ),
      settlementModel: "account-currency-date-net",
    },
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    depositCapture("source-linked-zero-net-incomplete-base"),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  assert.equal(queryCanonicalInvestmentCurrent(store, token("a")).relations.length, 1);
  store.db.prepare("UPDATE capture_scopes SET terminal=0").run();

  const offset = fixture("source-linked-zero-net-incomplete-offset");
  offset.holdings = [];
  offset.margin = undefined;
  offset.scope.effectiveOn = "2026-08-31";
  offset.transactions[0] = {
    ...offset.transactions[0]!,
    sourceRecordKey: token("source-linked-zero-net-incomplete-offset-record"),
    transactionKey: token("source-linked-zero-net-incomplete-offset-transaction"),
    action: "sell",
    cashEffect: { coefficient: "500000", scale: 0, currency: "TWD" },
    effectiveOn: "2026-08-31",
    fundingEvidence: {
      ...fundingEvidence(
        token("source-linked-zero-net-incomplete-offset-record"),
        token("source-linked-zero-net-incomplete-group"),
      ),
      settlementModel: "account-currency-date-net",
    },
  };
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(offset),
  );

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["zero-net-settlement"],
  });
  assert.equal(queryCanonicalInvestmentCurrent(store, token("a")).relations.length, 1);
  store.close();
});

test("net settlement relates several trades to one bank debit", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("net-settlement");
  input.transactions = [
    {
      ...input.transactions[0]!,
      sourceRecordKey: token("net-buy-a"),
      transactionKey: token("net-transaction-a"),
      cashEffect: { coefficient: "400000", scale: 0, currency: "TWD" },
      fundingEvidence: {
        ...fundingEvidence(token("net-buy-a"), token("net-group")),
        settlementModel: "account-currency-date-net",
      },
    },
    {
      ...input.transactions[0]!,
      sourceRecordKey: token("net-buy-b"),
      transactionKey: token("net-transaction-b"),
      cashEffect: { coefficient: "100000", scale: 0, currency: "TWD" },
      fundingEvidence: {
        ...fundingEvidence(token("net-buy-b"), token("net-group")),
        settlementModel: "account-currency-date-net",
      },
    },
    {
      ...input.transactions[0]!,
      sourceRecordKey: token("net-sell"),
      transactionKey: token("net-transaction-c"),
      action: "sell",
      cashEffect: { coefficient: "50000", scale: 0, currency: "TWD" },
      fundingEvidence: {
        ...fundingEvidence(token("net-sell"), token("net-group")),
        settlementModel: "account-currency-date-net",
      },
    },
  ];
  await commitCanonicalFinancialDepositCapture(
    store,
    depositCapture("net-settlement", ["450000"]),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  assert.equal((await resolveCanonicalInvestmentFundingRelations(store)).resolved, 1);
  const relation = queryCanonicalInvestmentCurrent(store, token("a"))
    .relations[0] as Record<string, unknown>;
  assert.equal(relation.settlementModel, "account-currency-date-net");
  assert.equal(relation.investmentTransactionCount, 3);
  assert.equal(relation.coefficient, "450000");
  store.close();
});

test("Yuanta brokerage settlement uses the bank's fixed note and actual settlement date", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-single-settlement");
  input.transactions[0] = {
    ...input.transactions[0]!,
    action: "buy",
    cashEffect: { coefficient: "460352", scale: 2, currency: "USD" },
    effectiveOn: "2026-08-13",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: input.transactions[0]!.sourceRecordKey,
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "single-buy",
      "2026-08-14",
      "4603.52",
      "outflow",
    ),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );

  assert.equal((await resolveCanonicalInvestmentFundingRelations(store)).resolved, 1);
  const relation = queryCanonicalInvestmentCurrent(store, token("a"))
    .relations[0] as Record<string, unknown>;
  assert.equal(relation.settlementEffectiveOn, "2026-08-14");
  assert.equal(relation.currency, "USD");
  assert.equal(relation.coefficient, "460352");
  assert.deepEqual(
    {
      ...(store.db
        .prepare(
          `SELECT commit_kind AS commitKind
             FROM canonical_commits
            WHERE commit_id=(SELECT created_commit_id
                               FROM investment_funding_relations
                              WHERE relation_key=?)`,
        )
        .get(String(relation.relationKey)) as object),
    },
    { commitKind: "relation_resolution" },
  );
  store.close();
});

test("Yuanta overseas buys and sells share one cross-day net settlement group", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-net-settlement");
  const base = input.transactions[0]!;
  const row = (
    sourceRecordKey: string,
    transactionKey: string,
    action: "buy" | "sell",
    effectiveOn: string,
    coefficient: string,
  ) => ({
    ...base,
    sourceRecordKey: token(sourceRecordKey),
    transactionKey: token(transactionKey),
    action,
    cashEffect: { coefficient, scale: 2, currency: "USD" },
    effectiveOn,
    fundingEvidence: {
      kind: "source-settlement-contract" as const,
      sourceRecordKey: token(sourceRecordKey),
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net" as const,
      contractVersion: "yuanta/foreign-settlement/human-attested-v1" as const,
    },
  });
  input.transactions = [
    row("yuanta-net-sell", "yuanta-net-sell-transaction", "sell", "2026-08-14", "1142352"),
    row("yuanta-net-buy-a", "yuanta-net-buy-a-transaction", "buy", "2026-08-17", "310647"),
    row("yuanta-net-buy-b", "yuanta-net-buy-b-transaction", "buy", "2026-08-17", "514893"),
    row("yuanta-net-buy-c", "yuanta-net-buy-c-transaction", "buy", "2026-08-17", "304174"),
  ];
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "yuanta-live-net-settlement",
      "2026-08-18",
      "126.38",
      "inflow",
    ),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );

  assert.equal((await resolveCanonicalInvestmentFundingRelations(store)).resolved, 1);
  const relation = queryCanonicalInvestmentCurrent(store, token("a"))
    .relations[0] as Record<string, unknown>;
  assert.equal(relation.settlementEffectiveOn, "2026-08-18");
  assert.equal(relation.settlementModel, "account-currency-date-net");
  assert.equal(relation.investmentTransactionCount, 4);
  assert.equal(relation.coefficient, "12638");
  assert.equal(relation.direction, "inflow");
  store.close();
});

test("a same-amount Yuanta bank row without the fixed settlement note is excluded", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-second-account");
  input.transactions[0] = {
    ...input.transactions[0]!,
    cashEffect: { coefficient: "460352", scale: 2, currency: "USD" },
    effectiveOn: "2026-08-13",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: input.transactions[0]!.sourceRecordKey,
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "second-account-same-amount",
      "2026-08-14",
      "4603.52",
      "outflow",
      { accountNo: SYNTHETIC_YUANTA_NO_NOTE_ACCOUNT, fixedNote: false },
    ),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["no-complete-funding-candidate"],
  });
  assert.equal(queryCanonicalInvestmentCurrent(store, token("a")).relations.length, 0);
  store.close();
});

test("a fixed-note bank row from a different Yuanta login is excluded", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-unlinked-bank");
  input.transactions[0] = {
    ...input.transactions[0]!,
    action: "buy",
    cashEffect: { coefficient: "460352", scale: 2, currency: "USD" },
    effectiveOn: "2026-08-13",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: input.transactions[0]!.sourceRecordKey,
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "unlinked-bank-same-amount",
      "2026-08-14",
      "4603.52",
      "outflow",
      {
        linkageKey: deriveYuantaForeignSettlementLinkageKey(
          "other-synthetic-yuanta-login",
          "USD",
        ),
      },
    ),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["no-complete-funding-candidate"],
  });
  store.close();
});

test("Yuanta settlement resolution refuses a bank scope that is not terminal-complete", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-incomplete-settlement");
  input.transactions[0] = {
    ...input.transactions[0]!,
    cashEffect: { coefficient: "460352", scale: 2, currency: "USD" },
    effectiveOn: "2026-08-13",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: input.transactions[0]!.sourceRecordKey,
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "incomplete-settlement",
      "2026-08-14",
      "4603.52",
      "outflow",
    ),
  );
  store.db.prepare("UPDATE capture_scopes SET terminal=0").run();
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["no-complete-funding-candidate"],
  });
  store.close();
});

test("Yuanta settlement resolution requires investment coverage through settlement", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-investment-scope-boundary");
  input.transactions[0] = {
    ...input.transactions[0]!,
    action: "buy",
    cashEffect: { coefficient: "460352", scale: 2, currency: "USD" },
    effectiveOn: "2026-08-13",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: input.transactions[0]!.sourceRecordKey,
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  store.db
    .prepare(
      `UPDATE capture_scopes SET scope_end='2026-08-13'
         WHERE account_id IN (
           SELECT account_id FROM financial_accounts WHERE stream='investment'
         )`,
    )
    .run();
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "investment-scope-boundary",
      "2026-08-14",
      "4603.52",
      "outflow",
    ),
  );

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["incomplete-investment-coverage"],
  });
  store.close();
});

test("two fixed-note bank rows with the same amount remain ambiguous", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-ambiguous-settlement");
  input.transactions[0] = {
    ...input.transactions[0]!,
    cashEffect: { coefficient: "460352", scale: 2, currency: "USD" },
    effectiveOn: "2026-08-13",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: input.transactions[0]!.sourceRecordKey,
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "ambiguous-settlement-a",
      "2026-08-14",
      "4603.52",
      "outflow",
    ),
  );
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "ambiguous-settlement-b",
      "2026-08-14",
      "4603.52",
      "outflow",
    ),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["ambiguous-funding-candidate"],
  });
  assert.equal(queryCanonicalInvestmentCurrent(store, token("a")).relations.length, 0);
  store.close();
});

test("a later complete ambiguity withdraws a stale Yuanta settlement relation", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-stale-ambiguity");
  input.transactions[0] = {
    ...input.transactions[0]!,
    action: "buy",
    cashEffect: { coefficient: "460352", scale: 2, currency: "USD" },
    effectiveOn: "2026-08-13",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: input.transactions[0]!.sourceRecordKey,
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "stale-ambiguity-a",
      "2026-08-14",
      "4603.52",
      "outflow",
    ),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  assert.equal((await resolveCanonicalInvestmentFundingRelations(store)).resolved, 1);
  assert.equal(queryCanonicalInvestmentCurrent(store, token("a")).relations.length, 1);

  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "stale-ambiguity-b",
      "2026-08-14",
      "4603.52",
      "outflow",
    ),
  );
  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["ambiguous-funding-candidate"],
  });
  assert.equal(queryCanonicalInvestmentCurrent(store, token("a")).relations.length, 0);
  store.close();
});

test("an incomplete later Yuanta funding capture preserves the current relation", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-incomplete-later-settlement");
  input.transactions[0] = {
    ...input.transactions[0]!,
    action: "buy",
    cashEffect: { coefficient: "460352", scale: 2, currency: "USD" },
    effectiveOn: "2026-08-13",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: input.transactions[0]!.sourceRecordKey,
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "incomplete-later-settlement-complete",
      "2026-08-14",
      "4603.52",
      "outflow",
    ),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  assert.equal(queryCanonicalInvestmentCurrent(store, token("a")).relations.length, 1);

  const incompleteCapture = yuantaForeignSettlementCapture(
    "incomplete-later-settlement-incomplete",
    "2026-08-14",
    "4603.52",
    "outflow",
  );
  await commitCanonicalFinancialDepositCapture(store, incompleteCapture);
  store.db
    .prepare(
      `UPDATE capture_scopes SET terminal=0
         WHERE capture_id=(SELECT capture_id FROM source_captures WHERE capture_key=?)`,
    )
    .run(incompleteCapture.captureId);

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["no-complete-funding-candidate"],
  });
  assert.equal(
    queryCanonicalInvestmentCurrent(store, token("a")).relations.length,
    1,
  );
  store.close();
});

test("complete coverage from a different Yuanta login preserves the current relation", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-different-login-coverage");
  input.transactions[0] = {
    ...input.transactions[0]!,
    action: "buy",
    cashEffect: { coefficient: "460352", scale: 2, currency: "USD" },
    effectiveOn: "2026-08-13",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: input.transactions[0]!.sourceRecordKey,
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  const original = yuantaForeignSettlementCapture(
    "different-login-coverage-original",
    "2026-08-14",
    "4603.52",
    "outflow",
  );
  await commitCanonicalFinancialDepositCapture(store, original);
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  assert.equal(queryCanonicalInvestmentCurrent(store, token("a")).relations.length, 1);

  store.db
    .prepare(
      `UPDATE capture_scopes SET scope_end='2026-08-13'
         WHERE capture_id=(SELECT capture_id FROM source_captures WHERE capture_key=?)`,
    )
    .run(original.captureId);
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "different-login-coverage-other",
      "2026-08-14",
      "4603.52",
      "outflow",
      {
        accountNo: SYNTHETIC_YUANTA_OTHER_LOGIN_ACCOUNT,
        linkageKey: deriveYuantaForeignSettlementLinkageKey(
          "other-synthetic-yuanta-login",
          "USD",
        ),
        sourceConnectionKey: token("other-yuanta-bank-connection"),
      },
    ),
  );

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["no-complete-funding-candidate"],
  });
  assert.equal(
    queryCanonicalInvestmentCurrent(store, token("a")).relations.length,
    1,
  );
  store.close();
});

test("a changed unique Yuanta settlement candidate supersedes the current relation", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-changed-settlement");
  input.transactions[0] = {
    ...input.transactions[0]!,
    action: "buy",
    cashEffect: { coefficient: "460352", scale: 2, currency: "USD" },
    effectiveOn: "2026-08-13",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: input.transactions[0]!.sourceRecordKey,
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "changed-settlement-old",
      "2026-08-14",
      "4603.52",
      "outflow",
    ),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  const oldRelation = queryCanonicalInvestmentCurrent(store, token("a"))
    .relations[0] as Record<string, unknown>;

  const changed = fixture("yuanta-live-changed-settlement-addition");
  changed.holdings = [];
  changed.margin = undefined;
  changed.scope.effectiveOn = "2026-08-14";
  changed.transactions[0] = {
    ...changed.transactions[0]!,
    sourceRecordKey: token("yuanta-live-changed-settlement-addition-record"),
    transactionKey: token("yuanta-live-changed-settlement-addition-transaction"),
    action: "buy",
    cashEffect: { coefficient: "10000", scale: 2, currency: "USD" },
    effectiveOn: "2026-08-13",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: token("yuanta-live-changed-settlement-addition-record"),
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(changed),
  );
  assert.equal(queryCanonicalInvestmentCurrent(store, token("a")).relations.length, 0);

  await commitCanonicalFinancialDepositCapture(
    store,
    yuantaForeignSettlementCapture(
      "changed-settlement-new",
      "2026-08-14",
      "4703.52",
      "outflow",
    ),
  );
  assert.equal((await resolveCanonicalInvestmentFundingRelations(store)).resolved, 1);
  const current = queryCanonicalInvestmentCurrent(store, token("a"))
    .relations[0] as Record<string, unknown>;
  assert.equal(current.coefficient, "470352");
  assert.notEqual(current.relationKey, oldRelation.relationKey);
  assert.equal(
    Number(
      (
        store.db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM investment_funding_relation_events
              WHERE event_kind='withdrawn'`,
          )
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  store.close();
});

test("Yuanta settlement resolution fails closed outside the versioned calendar", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-live-calendar-boundary");
  input.transactions[0] = {
    ...input.transactions[0]!,
    action: "buy",
    cashEffect: { coefficient: "460352", scale: 2, currency: "USD" },
    effectiveOn: "2027-01-04",
    fundingEvidence: {
      kind: "source-settlement-contract",
      sourceRecordKey: input.transactions[0]!.sourceRecordKey,
      sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
      linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as never,
  };
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["unsupported-settlement-calendar"],
  });
  store.close();
});

test("amount coincidence, ambiguous debits, and incomplete coverage do not admit relations", async () => {
  const coincidence = createCanonicalInvestmentStore(":memory:");
  await commitCanonicalFinancialDepositCapture(
    coincidence,
    depositCapture("amount-only"),
  );
  await commitCanonicalInvestmentCapture(
    coincidence,
    admitCanonicalInvestmentCapture(fixture("amount-only")),
  );
  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(coincidence), {
    resolved: 0,
    noAdmission: 0,
    reasons: [],
  });
  coincidence.close();

  const ambiguous = createCanonicalInvestmentStore(":memory:");
  const ambiguousInput = fixture("ambiguous-settlement");
  ambiguousInput.transactions[0] = {
    ...ambiguousInput.transactions[0]!,
    fundingEvidence: fundingEvidence(),
  };
  await commitCanonicalFinancialDepositCapture(
    ambiguous,
    depositCapture("ambiguous-settlement", ["500000", "500000"]),
  );
  await commitCanonicalInvestmentCapture(
    ambiguous,
    admitCanonicalInvestmentCapture(ambiguousInput),
  );
  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(ambiguous), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["ambiguous-funding-candidate"],
  });
  ambiguous.close();

  const incomplete = createCanonicalInvestmentStore(":memory:");
  const incompleteInput = fixture("incomplete-settlement");
  incompleteInput.transactions[0] = {
    ...incompleteInput.transactions[0]!,
    fundingEvidence: fundingEvidence(),
  };
  await commitCanonicalFinancialDepositCapture(
    incomplete,
    depositCapture("incomplete-settlement"),
  );
  incomplete.db.prepare("UPDATE capture_scopes SET terminal=0").run();
  await commitCanonicalInvestmentCapture(
    incomplete,
    admitCanonicalInvestmentCapture(incompleteInput),
  );
  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(incomplete), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["no-complete-funding-candidate"],
  });
  incomplete.close();
});

test("source-linked resolution compares the complete account number", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("linked-account-number-mismatch");
  input.transactions[0] = {
    ...input.transactions[0]!,
    fundingEvidence: {
      ...fundingEvidence(),
      fundingAccountNumber: SYNTHETIC_YUANTA_SETTLEMENT_ACCOUNT,
    },
  };
  await commitCanonicalFinancialDepositCapture(
    store,
    depositCapture("linked-account-number-mismatch"),
  );
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );

  assert.deepEqual(await resolveCanonicalInvestmentFundingRelations(store), {
    resolved: 0,
    noAdmission: 1,
    reasons: ["no-complete-funding-candidate"],
  });
  store.close();
});

test("linked funding evidence requires a complete account and capture contract", () => {
  const masked = fixture("masked-funding-account");
  masked.transactions[0] = {
    ...masked.transactions[0]!,
    fundingEvidence: {
      ...fundingEvidence(),
      fundingAccountNumber: "******1100",
    },
  };
  assert.throws(
    () => admitCanonicalInvestmentCapture(masked),
    /complete source-reported account number/,
  );
  const wrongContract = fixture("wrong-funding-contract");
  wrongContract.transactions[0] = {
    ...wrongContract.transactions[0]!,
    fundingEvidence: {
      ...fundingEvidence(),
      contractVersion: "unverified-contract",
    },
  };
  assert.throws(
    () => admitCanonicalInvestmentCapture(wrongContract),
    /outside the capture contract/,
  );
});

test("Yuanta settlement evidence is not accepted from the fund source", () => {
  const fundCapture = fixture("fund-settlement-contract");
  fundCapture.sourceId = "yuanta-fund";
  fundCapture.authorityRoute = "yuanta-fund/investment/canonical-v1";
  fundCapture.contractVersion = "yuanta-fund/investment/canonical-v1";
  fundCapture.securities[0]!.securityKey = "yuanta-fund:TWSE:2330";
  fundCapture.securities[0]!.identityEvidence.contractVersion =
    fundCapture.contractVersion;
  fundCapture.holdings[0]!.securityKey = "yuanta-fund:TWSE:2330";
  fundCapture.holdings[0]!.effectiveTimeEvidence.contractVersion =
    fundCapture.contractVersion;
  fundCapture.holdings[0]!.lineage.contractVersion = fundCapture.contractVersion;
  fundCapture.transactions[0]!.securityKey = "yuanta-fund:TWSE:2330";
  fundCapture.transactions[0]!.fundingEvidence = {
    kind: "source-settlement-contract",
    sourceRecordKey: fundCapture.transactions[0]!.sourceRecordKey,
    sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
    linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
    ...YUANTA_SETTLEMENT_MARKET_EVIDENCE,
    settlementModel: "account-currency-date-net",
    contractVersion: "yuanta/foreign-settlement/human-attested-v1",
  };
  assert.throws(
    () => admitCanonicalInvestmentCapture(fundCapture),
    /only supported for Yuanta trade captures/,
  );
});

test("Yuanta settlement evidence requires an explicitly supported market contract", () => {
  const missingMarket = fixture("missing-settlement-market");
  missingMarket.transactions[0]!.fundingEvidence = {
    kind: "source-settlement-contract",
    sourceRecordKey: missingMarket.transactions[0]!.sourceRecordKey,
    sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
    linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
    settlementMarket: YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
    settlementMarketContractVersion:
      YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
    settlementModel: "account-currency-date-net",
    contractVersion: "yuanta/foreign-settlement/human-attested-v1",
  } as never;
  assert.throws(
    () => admitCanonicalInvestmentCapture(missingMarket),
    /outside the versioned mapping contract/,
  );

  const unsupportedMarket = fixture("unsupported-settlement-market");
  unsupportedMarket.transactions[0]!.fundingEvidence = {
    kind: "source-settlement-contract",
    sourceRecordKey: unsupportedMarket.transactions[0]!.sourceRecordKey,
    sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
    linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
    settlementMarket: "HK",
    settlementMarketContractVersion:
      YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
    settlementModel: "account-currency-date-net",
    contractVersion: "yuanta/foreign-settlement/human-attested-v1",
  } as never;
  assert.throws(
    () => admitCanonicalInvestmentCapture(unsupportedMarket),
    /outside the live-verified contract/,
  );
});

test("Yuanta market-v2 evidence retains and validates the exact source MarketNo", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("yuanta-market-code-provenance");
  input.transactions[0]!.fundingEvidence = {
    kind: "source-settlement-contract",
    sourceRecordKey: input.transactions[0]!.sourceRecordKey,
    sourceLinkageKey: YUANTA_SETTLEMENT_LINKAGE_KEY,
    linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
    sourceMarketCode: "52",
    settlementMarket: YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
    settlementMarketContractVersion:
      YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
    settlementModel: "account-currency-date-net",
    contractVersion: "yuanta/foreign-settlement/human-attested-v1",
  };
  const admitted = admitCanonicalInvestmentCapture(input);
  assert.equal(
    admitted.transactions[0]!.fundingEvidence.kind,
    "source-settlement-contract",
  );
  if (admitted.transactions[0]!.fundingEvidence.kind !== "source-settlement-contract")
    throw new Error("Expected source-settlement contract evidence.");
  assert.equal(admitted.transactions[0]!.fundingEvidence.sourceMarketCode, "52");
  await commitCanonicalInvestmentCapture(store, admitted);
  const retained = queryCanonicalSourceCurrent(store).records.find(
    (record) => record.compact.kind === "investment-transaction",
  );
  assert.equal(
    (retained?.compact.fundingEvidence as { sourceMarketCode?: string })
      ?.sourceMarketCode,
    "52",
  );
  store.close();

  const mismatchedCode = fixture("yuanta-market-code-mismatch");
  mismatchedCode.transactions[0]!.fundingEvidence = {
    ...input.transactions[0]!.fundingEvidence,
    sourceMarketCode: "51",
  } as never;
  assert.throws(
    () => admitCanonicalInvestmentCapture(mismatchedCode),
    /outside the versioned mapping contract/,
  );

  const mismatchedVersion = fixture("yuanta-market-version-mismatch");
  mismatchedVersion.transactions[0]!.fundingEvidence = {
    ...input.transactions[0]!.fundingEvidence,
    settlementMarketContractVersion: "yuanta/foreign-settlement/market-v1",
  } as never;
  assert.throws(
    () => admitCanonicalInvestmentCapture(mismatchedVersion),
    /outside the (live-verified|versioned mapping) contract/,
  );
});

test("a v15 database migrates and reopens with investment funding relations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canonical-investment-v16-"));
  const path = join(dir, "canonical.sqlite");
  try {
    const initial = createCanonicalInvestmentStore(path);
    initial.db.exec(`
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      DELETE FROM schema_migrations WHERE version>15;
      DROP TABLE investment_funding_relation_events;
      DROP TABLE investment_funding_relation_members;
      DROP TABLE investment_funding_relations;
      DELETE FROM schema_migrations WHERE version=16;
      PRAGMA user_version=15;
    `);
    initial.close();

    const migrated = createCanonicalInvestmentStore(path);
    assert.equal(
      Number(
        (
          migrated.db.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
      20,
    );
    assert.deepEqual(
      migrated.db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type='table' AND name LIKE 'investment_funding_relation%'
            ORDER BY name`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { name: "investment_funding_relation_events" },
        { name: "investment_funding_relation_members" },
        { name: "investment_funding_relations" },
      ],
    );
    migrated.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
