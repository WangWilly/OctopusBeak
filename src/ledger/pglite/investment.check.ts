import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { applyPgliteBaseline } from "./baseline.ts";
import {
  commitPGliteCanonicalInvestmentCapture,
  type PGliteCanonicalInvestmentCommitRequest,
} from "./investment.ts";
import { PGliteStore } from "./transaction.ts";
import {
  commitPGliteCanonicalFinancialCapture,
  type PGliteCanonicalFinancialCommitRequest,
} from "./canonical-source-store.ts";
import {
  resolvePGliteCanonicalInvestmentFundingRelations,
  queryPGliteCurrentInvestmentFundingRelations,
} from "./relations.ts";

const token = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("base64url")}`;

function investmentRequest(captureId: string, valuation = "12500"): PGliteCanonicalInvestmentCommitRequest {
  const contractVersion = "yuanta-fund/investment/canonical-v1";
  const securityKey = "yuanta-fund:ACME";
  const holdingSourceRecordKey = token("holding-source");
  const transactionSourceRecordKey = token("investment-transaction-source");
  const marginSourceRecordKey = token("investment-margin-source");
  return {
    capture: {
      captureId,
      sourceId: "yuanta-fund",
      authorityRoute: contractVersion,
      contractVersion,
      observedAt: "2026-09-22T01:00:00.000Z",
      identity: {
        sourceConnectionKey: token("investment-connection"),
        identityEpochKey: token("investment-epoch"),
        accountKey: token("investment-account"),
        accountNumber: {
          value: "7654321",
          kind: "brokerage-account",
          evidenceVersion: "yuanta-fund/account-v1",
          sourceField: "accountNo",
        },
        accountType: "investment",
        reportingCurrency: "TWD",
      },
      scope: { effectiveOn: "2026-09-22", complete: true },
      securities: [{
        securityKey,
        producerSecurityId: "ACME",
        name: "Acme Equity",
        ticker: "ACME",
        currency: "TWD",
        securityType: "equity",
        identityEvidence: { kind: "producer-security-id", contractVersion },
        nameEvidence: { contractVersion: "yuanta-fund/security-name/source-reported-v1", sourceRecordKey: holdingSourceRecordKey },
      }],
      holdings: [{
        measurementKey: token("holding-measurement"),
        measurementSubjectKey: token("holding-subject"),
        sourceRecordKey: holdingSourceRecordKey,
        securityKey,
        quantity: { coefficient: "5", scale: 0 },
        valuation: { coefficient: valuation, scale: 0, currency: "TWD" },
        cost: { coefficient: "10000", scale: 0, currency: "TWD" },
        effectiveOn: "2026-09-22",
        observedAt: "2026-09-22T01:00:00.000Z",
        effectiveTimeEvidence: {
          kind: "source-reported-as-of",
          sourceRecordKey: holdingSourceRecordKey,
          sourceField: "asOfDate",
          value: "2026-09-22",
          contractVersion,
        },
        lineage: { page: 1, row: 1, contractVersion },
      }],
      transactions: [{
        sourceRecordKey: transactionSourceRecordKey,
        transactionKey: token("investment-transaction"),
        securityKey,
        action: "buy",
        quantity: { coefficient: "5", scale: 0 },
        cashEffect: { coefficient: "10000", scale: 0, currency: "TWD" },
        effectiveOn: "2026-09-22",
        description: "buy ACME",
        fundingEvidence: { kind: "unresolved", sourceRecordKey: transactionSourceRecordKey },
      }],
      margin: {
        kind: "embedded",
        amount: { coefficient: "200", scale: 0, currency: "TWD" },
        effectiveOn: "2026-09-22",
        sourceRecordKey: marginSourceRecordKey,
      },
    },
  };
}

function fundingDepositRequest(captureId: string): PGliteCanonicalFinancialCommitRequest {
  const occurrenceKey = token(`${captureId}:record`);
  return {
    capture: {
      captureId,
      integrationNamespace: "synthetic",
      sourceConnectionKey: token("funding-connection"),
      identityEpoch: token("funding-epoch"),
      stream: "domestic-deposit",
      recordKind: "source-record",
      routeKey: "synthetic/domestic-deposit/v8",
      contractVersion: "synthetic-v8",
      subjectDigest: token("funding-subject"),
      observedAt: "2026-09-22T00:00:00.000Z",
      accountNumber: { value: "123456", kind: "depository-account", evidenceVersion: "synthetic-v1", sourceField: "accountNumber" },
      scope: { startDate: "20260922", endDate: "20260922", kind: "point-in-time", completeness: "single-page", ruleVersion: "synthetic-v8", sourceAccountKey: "funding-account" },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: { pageCount: 1 } }],
      records: [{ occurrenceKey, collisionKey: token(`${captureId}:collision`), providerKey: token(`${captureId}:provider`), contentHash: token(`${captureId}:content`), compact: { amount: { coefficient: "10000", scale: 0 } } }],
    },
    account: { sourceAccountKey: "funding-account", accountNo: "123456", accountType: "depository", currency: "TWD" },
    transactions: [{
      sourceOccurrenceKey: occurrenceKey,
      sourceSequence: captureId,
      amount: { coefficient: "10000", scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "synthetic_origin",
      postingBasis: "synthetic_basis",
      postingRuleVersion: "synthetic-v1",
      description: "funding transfer",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "synthetic-v1",
      effectiveOn: "2026-09-22",
      transactionDateTimeLocal: "2026-09-22T00:00:00+08:00",
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "accounting",
      effectiveTimeRuleVersion: "synthetic-v1",
      utcInstantUtcUs: 1,
    }],
  };
}

test("source-linked investment funding resolves exactly one retained bank fact", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const funding = await commitPGliteCanonicalFinancialCapture(store, fundingDepositRequest("funding-1"));
    const base = investmentRequest("investment-linked-1");
    const transaction = base.capture.transactions[0]!;
    await commitPGliteCanonicalInvestmentCapture(store, {
      ...base,
      capture: {
        ...base.capture,
        transactions: [{
          ...transaction,
          fundingEvidence: {
            kind: "source-linked-account",
            sourceRecordKey: transaction.sourceRecordKey,
            fundingAccountKey: token("funding-account"),
            fundingAccountNumber: "123456",
            sourceLinkageKey: token("funding-linkage"),
            settlementGroupKey: token("funding-group"),
            settlementEffectiveOn: "2026-09-22",
            settlementModel: "single-transaction",
            contractVersion: base.capture.contractVersion,
          },
        }],
      },
    });
    const resolution = await resolvePGliteCanonicalInvestmentFundingRelations(store, {
      sourceConnectionKey: token("investment-connection"),
      observedAt: "2026-09-22T02:00:00.000Z",
    });
    assert.equal(resolution.outcome, "changed");
    assert.equal(resolution.resolved, 1);
    const current = await queryPGliteCurrentInvestmentFundingRelations(store);
    assert.equal(current.length, 1);
    assert.equal(current[0]?.fundingTransactionId, funding.transactions[0]?.transactionId);
    const repeated = await resolvePGliteCanonicalInvestmentFundingRelations(store, {
      sourceConnectionKey: token("investment-connection"),
      observedAt: "2026-09-22T02:00:00.000Z",
    });
    assert.equal(repeated.outcome, "unchanged");
    assert.deepEqual(await queryPGliteCurrentInvestmentFundingRelations(store), current);
    const secondFunding = await commitPGliteCanonicalFinancialCapture(store, fundingDepositRequest("funding-2"));
    assert.notEqual(secondFunding.transactions[0]?.transactionId, funding.transactions[0]?.transactionId);
    const ambiguous = await resolvePGliteCanonicalInvestmentFundingRelations(store, {
      sourceConnectionKey: token("investment-connection"),
      observedAt: "2026-09-22T03:00:00.000Z",
    });
    assert.equal(ambiguous.noAdmission, 1);
    assert.ok(ambiguous.reasons.includes("ambiguous-funding-candidate"));
    assert.deepEqual(await queryPGliteCurrentInvestmentFundingRelations(store), []);
  } finally {
    await store.close();
  }
});

test("PGlite investment command preserves holdings, valuation, cost, transactions, and margin recurrence", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const first = await commitPGliteCanonicalInvestmentCapture(store, investmentRequest("investment-capture-1"), { clock: () => 100 });
    assert.equal(first.holdingCount, 1);
    assert.equal(first.investmentTransactionCount, 1);
    assert.equal(first.marginObservationCount, 1);
    const repeat = await commitPGliteCanonicalInvestmentCapture(store, investmentRequest("investment-capture-2"), { clock: () => 100 });
    assert.equal(repeat.transactions[0]?.revisionCreated, false);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM investment_holding_observations")).rows[0]?.count, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM investment_transactions")).rows[0]?.count, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM investment_margin_balance_observations")).rows[0]?.count, 1);
    assert.deepEqual((await store.query<{ valuation_coefficient: string; cost_coefficient: string; currency: string }>("SELECT valuation_coefficient, cost_coefficient, valuation_currency AS currency FROM investment_holding_observations")).rows, [{ valuation_coefficient: "12500", cost_coefficient: "10000", currency: "TWD" }]);
    const funding = await resolvePGliteCanonicalInvestmentFundingRelations(store, {
      sourceConnectionKey: token("investment-connection"),
      observedAt: "2026-09-22T01:00:00.000Z",
    }, { clock: () => 101 });
    assert.equal(funding.resolved, 0);
    assert.equal(funding.noAdmission, 1);
    assert.deepEqual(await queryPGliteCurrentInvestmentFundingRelations(store), []);
  } finally {
    await store.close();
  }
});

test("PGlite investment command rolls back changed source evidence", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalInvestmentCapture(store, investmentRequest("investment-capture-1"), { clock: () => 100 });
    await assert.rejects(
      commitPGliteCanonicalInvestmentCapture(store, investmentRequest("investment-capture-conflict", "13000"), { clock: () => 100 }),
      /occurrence|overwrite/iu,
    );
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM investment_holding_observations")).rows[0]?.count, 1);
  } finally {
    await store.close();
  }
});

test("PGlite investment command preserves independent margin loan as a loan spine", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const base = investmentRequest("investment-independent-margin-1");
    const request: PGliteCanonicalInvestmentCommitRequest = {
      ...base,
      capture: {
        ...base.capture,
        margin: {
          kind: "independent-account",
          accountKey: token("independent-margin-account"),
          accountType: "loan",
          amount: { coefficient: "300", scale: 0, currency: "TWD" },
          effectiveOn: "2026-09-22",
          sourceRecordKey: token("independent-margin-source"),
          identityEvidence: {
            kind: "producer-margin-account-id",
            producerAccountId: "MARGIN-LOAN-001",
            contractVersion: "loan/canonical/v1.yuanta",
          },
          sourceEventCode: "LOAN-DISBURSEMENT",
        },
      },
    };
    const result = await commitPGliteCanonicalInvestmentCapture(store, request, { clock: () => 200 });
    assert.equal(result.marginObservationCount, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_accounts WHERE stream = 'loan'")).rows[0]?.count, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM loan_transaction_facts")).rows[0]?.count, 1);
    assert.deepEqual((await store.query<{ balance_coefficient: string; balance_kind: string }>("SELECT balance_coefficient, balance_kind FROM balance_observation_revisions JOIN balance_observations USING (observation_id) WHERE balance_kind = 'loan_outstanding'")).rows, [{ balance_coefficient: "300", balance_kind: "loan_outstanding" }]);
  } finally {
    await store.close();
  }
});

test("PGlite investment command preserves independent margin credit as a named source spine", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const base = investmentRequest("investment-independent-credit-1");
    const request: PGliteCanonicalInvestmentCommitRequest = {
      ...base,
      capture: {
        ...base.capture,
        margin: {
          kind: "independent-account",
          accountKey: token("independent-margin-credit-account"),
          accountType: "credit",
          amount: { coefficient: "150", scale: 0, currency: "TWD" },
          effectiveOn: "2026-09-22",
          sourceRecordKey: token("independent-margin-credit-source"),
          identityEvidence: {
            kind: "producer-margin-account-id",
            producerAccountId: "MARGIN-CREDIT-001",
            contractVersion: "yuanta-fund/investment/margin-credit-canonical-v1",
          },
          sourceEventCode: "LOAN-DISBURSEMENT",
        },
      },
    };
    const result = await commitPGliteCanonicalInvestmentCapture(store, request, { clock: () => 300 });
    assert.equal(result.marginObservationCount, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_accounts WHERE stream = 'investment-margin' AND account_type = 'credit'")).rows[0]?.count, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM transaction_revisions WHERE posting_rule_version = 'yuanta-fund/investment/margin-credit-canonical-v1'")).rows[0]?.count, 1);
  } finally {
    await store.close();
  }
});
