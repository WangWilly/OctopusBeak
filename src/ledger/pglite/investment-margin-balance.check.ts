import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { assignOccurrenceSlots } from "../canonical/occurrence-groups.ts";
import { applyPgliteBaseline } from "./baseline.ts";
import {
  commitPGliteCanonicalFinancialCapture,
  type PGliteCanonicalFinancialCommitRequest,
} from "./canonical-source-store.ts";
import {
  commitPGliteCanonicalInvestmentCapture,
  type PGliteCanonicalInvestmentCommitRequest,
} from "./investment.ts";
import {
  queryPGliteCurrentInvestmentFundingRelations,
  resolvePGliteCanonicalInvestmentFundingRelations,
} from "./relations.ts";
import { PGliteStore } from "./transaction.ts";

const token = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("base64url")}`;

function fundingDepositRequest(captureId: string): PGliteCanonicalFinancialCommitRequest {
  const occurrenceKey = token("margin-balance-funding-record");
  return {
    capture: {
      captureId,
      integrationNamespace: "cathay",
      sourceConnectionKey: token("margin-balance-funding-connection"),
      identityEpoch: token("margin-balance-funding-epoch"),
      stream: "domestic-deposit",
      recordKind: "source-record",
      routeKey: "cathay/domestic-deposit/v1",
      contractVersion: "v1",
      subjectDigest: token("margin-balance-funding-subject"),
      observedAt: "2026-09-22T00:00:00.000Z",
      accountNumber: {
        value: "123456",
        kind: "depository-account",
        evidenceVersion: "synthetic-v1",
        sourceField: "accountNumber",
      },
      scope: {
        startDate: "20260922",
        endDate: "20260922",
        kind: "point-in-time",
        completeness: "single-page",
        ruleVersion: "cathay/domestic-deposit/v1",
        sourceAccountKey: "margin-test-funding-account",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: {} }],
      records: [{
        occurrenceKey,
        providerKey: token("margin-balance-funding-provider"),
        contentHash: token("margin-balance-funding-content"),
        compact: { amount: { coefficient: "10000", scale: 0 } },
      }],
    },
    account: {
      sourceAccountKey: "margin-test-funding-account",
      accountNo: "123456",
      accountType: "depository",
      currency: "TWD",
    },
    transactions: [{
      sourceOccurrenceKey: occurrenceKey,
      sourceSequence: "margin-test-funding",
      amount: { coefficient: "10000", scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "query-status-success-with-accounting-date",
      postingRuleVersion: "cathay/domestic-deposit/v1",
      description: "investment funding",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "cathay/domestic-deposit/v1",
      effectiveOn: "2026-09-22",
      transactionDateTimeLocal: "2026-09-22T00:00:00+08:00",
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "accounting",
      effectiveTimeRuleVersion: "cathay/domestic-deposit/v1",
      utcInstantUtcUs: 1,
    }],
  };
}

function investmentRequest(
  captureId: string,
  marginAccountType: "loan" | "credit",
): PGliteCanonicalInvestmentCommitRequest {
  const contractVersion = "yuanta-fund/investment/canonical-v1";
  const effectiveOn = "2026-09-22";
  const scopeKey = token("margin-test-investment-history-bucket");
  const fingerprint = token("margin-test-buy-transaction");
  const slot = assignOccurrenceSlots({
    rows: [{ effectiveOn, fingerprint }],
    complete: true,
    scopeKey: () => scopeKey,
    fingerprint: (row) => row.fingerprint,
    partitionDate: (row) => row.effectiveOn,
  })[0]!;
  const sourceRecordKey = slot.occurrenceKey;
  const securityKey = "yuanta-fund:MARGIN-TEST";
  const marginAccountKey = token(`margin-test-${marginAccountType}-account`);
  return {
    capture: {
      captureId,
      sourceId: "yuanta-fund",
      authorityRoute: contractVersion,
      contractVersion,
      observedAt: "2026-09-22T01:00:00.000Z",
      identity: {
        sourceConnectionKey: token("margin-test-investment-connection"),
        identityEpochKey: token("margin-test-investment-epoch"),
        accountKey: token("margin-test-investment-account"),
        accountType: "investment",
        reportingCurrency: "TWD",
      },
      scope: {
        effectiveOn,
        complete: true,
        transactionHistory: { startDate: effectiveOn, endDate: effectiveOn, complete: true },
      },
      occurrenceGroupCoverage: [{
        scopeKey,
        startDate: effectiveOn,
        endDate: effectiveOn,
        contractVersion,
      }],
      securities: [{
        securityKey,
        producerSecurityId: "MARGIN-TEST",
        name: "Margin test security",
        currency: "TWD",
        securityType: "equity",
        identityEvidence: { kind: "producer-security-id", contractVersion },
      }],
      holdings: [],
      transactions: [{
        sourceRecordKey,
        occurrenceGroup: slot.group,
        transactionKey: token("margin-test-investment-transaction"),
        securityKey,
        action: "buy",
        quantity: { coefficient: "1", scale: 0 },
        cashEffect: { coefficient: "10000", scale: 0, currency: "TWD" },
        effectiveOn,
        description: "margin test security buy",
        fundingEvidence: {
          kind: "source-linked-account",
          sourceRecordKey,
          fundingAccountKey: token("margin-test-funding-account"),
          fundingAccountNumber: "123456",
          sourceLinkageKey: token("margin-test-funding-linkage"),
          settlementGroupKey: token("margin-test-funding-group"),
          settlementEffectiveOn: effectiveOn,
          settlementModel: "single-transaction",
          contractVersion,
        },
      }],
      margin: {
        kind: "independent-account",
        accountKey: marginAccountKey,
        accountType: marginAccountType,
        amount: { coefficient: marginAccountType === "loan" ? "300" : "150", scale: 0, currency: "TWD" },
        effectiveOn,
        sourceRecordKey: token(`margin-test-${marginAccountType}-balance-record`),
        identityEvidence: {
          kind: "producer-margin-account-id",
          producerAccountId: `MARGIN-${marginAccountType.toUpperCase()}-001`,
          contractVersion: `${"yuanta-fund"}/investment/margin-credit-canonical-v1`,
        },
        sourceEventCode: "LOAN-DISBURSEMENT",
      },
    },
  };
}

test("independent margin accounts persist as balances without transaction slots and preserve funding relations", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const funding = await commitPGliteCanonicalFinancialCapture(store, fundingDepositRequest("margin-test-funding"));
    const first = await commitPGliteCanonicalInvestmentCapture(
      store,
      investmentRequest("margin-test-loan", "loan"),
      { clock: () => 100 },
    );
    const resolved = await resolvePGliteCanonicalInvestmentFundingRelations(store, {
      sourceConnectionKey: token("margin-test-investment-connection"),
      observedAt: "2026-09-22T02:00:00.000Z",
    }, { clock: () => 101 });
    assert.equal(resolved.resolved, 1);
    const currentRelations = await queryPGliteCurrentInvestmentFundingRelations(store);
    assert.equal(currentRelations.length, 1);
    assert.equal(currentRelations[0]?.fundingTransactionId, funding.transactions[0]?.transactionId);

    const eventCount = Number((await store.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM investment_funding_relation_events",
    )).rows[0]?.count);
    const second = await commitPGliteCanonicalInvestmentCapture(
      store,
      investmentRequest("margin-test-credit", "credit"),
      { clock: () => 102 },
    );
    assert.equal(first.investmentTransactionCount, 1);
    assert.equal(first.marginObservationCount, 1);
    assert.equal(second.investmentTransactionCount, 1);
    assert.equal(second.marginObservationCount, 1);

    const transactions = await store.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM financial_transactions transaction_row
        JOIN financial_accounts account ON account.account_id = transaction_row.account_id
       WHERE account.stream = 'investment-margin'`,
    );
    assert.equal(Number(transactions.rows[0]?.count), 0);
    const loanFacts = await store.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM loan_transaction_facts",
    );
    assert.equal(Number(loanFacts.rows[0]?.count), 0);
    const marginRevisions = await store.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM transaction_revisions WHERE posting_rule_version = 'yuanta-fund/investment/margin-credit-canonical-v1'",
    );
    assert.equal(Number(marginRevisions.rows[0]?.count), 0);
    const marginGroups = await store.query<{ records: number | string; grouped: number | string }>(
      `SELECT COUNT(*) AS records, COUNT(source_record.occurrence_group_ordinal) AS grouped
         FROM source_records source_record
         JOIN source_captures source_capture ON source_capture.capture_id = source_record.capture_id
        WHERE source_capture.stream = 'investment-margin'`,
    );
    assert.deepEqual({
      records: Number(marginGroups.rows[0]?.records),
      grouped: Number(marginGroups.rows[0]?.grouped),
    }, { records: 2, grouped: 0 });
    const balances = await store.query<{ balance_kind: string; balance_coefficient: string }>(
      `SELECT observation.balance_kind, revision.balance_coefficient
         FROM balance_observations observation
         JOIN balance_observation_revisions revision USING (observation_id)
         JOIN financial_accounts account ON account.account_id = observation.account_id
        WHERE account.stream = 'investment-margin'
        ORDER BY observation.balance_kind`,
    );
    assert.deepEqual(balances.rows, [
      { balance_kind: "credit_used", balance_coefficient: "150" },
      { balance_kind: "loan_outstanding", balance_coefficient: "300" },
    ]);
    assert.equal(Number((await store.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM investment_funding_relation_events",
    )).rows[0]?.count), eventCount);
    assert.deepEqual(await queryPGliteCurrentInvestmentFundingRelations(store), currentRelations);
  } finally {
    await store.close();
  }
});
