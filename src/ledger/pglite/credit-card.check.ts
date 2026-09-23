import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { applyPgliteBaseline } from "./baseline.ts";
import {
  commitPGliteCanonicalCreditCardBalanceCapture,
  commitPGliteCanonicalCreditCardCapture,
  type PGliteCanonicalCreditCardCaptureRequest,
} from "./credit-card.ts";
import { PGliteStore } from "./transaction.ts";

const route = "esun/credit-card/human-attested-v1";
const connection = "sha256:pglite-credit-card-check-connection";
const epoch = "sha256:pglite-credit-card-check-epoch";
const subject = "sha256:pglite-credit-card-check-subject";
const accountKey = "credit-portfolio-1";
const token = (value: string): string => `sha256:${createHash("sha256").update(value).digest("base64url")}`;

function capture(captureId: string, identityKey = token("opaque-card-account"), balanceAt = "2026-09-22T00:00:00.000Z"): PGliteCanonicalCreditCardCaptureRequest {
  const instrument = token("instrument-occurrence");
  const transaction = token("transaction-occurrence");
  const statement = token("statement-occurrence");
  const balance = token(`balance-occurrence:${balanceAt}`);
  const records = [
    { occurrenceKey: instrument, providerKey: token("instrument-provider"), contentHash: token("instrument-content"), compact: { kind: "instrument", instrumentKey: "opaque-primary" } },
    { occurrenceKey: transaction, providerKey: token("transaction-provider"), contentHash: token("transaction-content"), compact: { kind: "transaction", sourceSequence: "transaction-1", amount: "1000" }, description: "Card purchase" },
    { occurrenceKey: statement, providerKey: token("statement-provider"), contentHash: token("statement-content"), compact: { kind: "statement", statementKey: "statement-1" }, description: "Statement" },
    { occurrenceKey: balance, providerKey: token(`balance-provider:${balanceAt}`), contentHash: token(`balance-content:${balanceAt}`), compact: { kind: "balance", balanceAt }, description: "Used credit" },
  ];
  return {
    capture: {
      captureId,
      integrationNamespace: "esun",
      sourceConnectionKey: connection,
      identityEpoch: epoch,
      stream: "credit-card",
      recordKind: "credit-card-capture",
      routeKey: route,
      contractVersion: route,
      subjectDigest: subject,
      observedAt: "2026-09-22T01:00:00.000Z",
      scope: {
        startDate: "2026-09-22",
        endDate: "2026-09-22",
        dateFormat: "YYYY-MM-DD",
        kind: "bounded-range",
        completeness: "complete-range",
        ruleVersion: route,
        completenessBasis: "credit-card-check",
        sourceAccountKey: accountKey,
        absenceAuthority: "comparable-complete-range",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: { fixture: "credit-card-check" } }],
      records,
    },
    account: { sourceAccountKey: accountKey, accountType: "credit", currency: "TWD" },
    identity: { accountNaturalKey: identityKey, identityMethod: "opaque-provider-account" },
    instruments: [{ instrumentKey: "opaque-primary", cardMask: "****4281", role: "primary", lifecycle: "active", evidenceSourceOccurrenceKey: instrument }],
    transactions: [{
      sourceOccurrenceKey: transaction,
      sourceSequence: "transaction-1",
      amount: { coefficient: "1000", scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      postingRuleVersion: route,
      description: "Card purchase",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: route,
      effectiveOn: "2026-09-22",
      transactionDateTimeLocal: "2026-09-22T10:00:00",
      timeZone: "Asia/Taipei",
      timePrecision: "minute",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: route,
      utcInstantUtcUs: Date.parse("2026-09-22T02:00:00Z") * 1000,
      instrumentKey: "opaque-primary",
      billingStatus: "billed",
      consumeDate: "2026-09-22",
      postingDate: "2026-09-22",
      effectiveDateBasis: "consume-date",
      statementKey: "statement-1",
    }],
    statements: [{
      statementKey: "statement-1",
      revisionKey: "statement-revision-1",
      cycleStart: "2026-09-01",
      cycleEnd: "2026-09-30",
      issueDate: "2026-10-01",
      dueDate: "2026-10-20",
      currency: "TWD",
      balance: { coefficient: "1000", scale: 0 },
      minimumPayment: { coefficient: "100", scale: 0 },
      transactionSourceOccurrenceKeys: [transaction],
      evidenceSourceOccurrenceKey: statement,
    }],
    relations: [],
    balance: {
      observation: {
        observationKey: "issuer-aggregate",
        balanceKind: "credit_used",
        balance: { coefficient: "500", scale: 0 },
        currency: "TWD",
        effectiveAt: balanceAt,
        effectiveTimeBasis: "provider-http-date",
        effectiveTimeRuleVersion: route,
        evidenceSourceRecordKey: balance,
        evidenceSourceField: "usedCredit",
        evidenceSourceValue: "500",
        evidenceContractVersion: route,
        sourceOccurrenceKey: balance,
        evidenceEndpoint: "https://issuer.example/current-used-credit",
        evidenceResponseStatus: 200,
        evidenceCachePolicy: "no-store",
      },
      estimate: {
        kind: "estimate",
        basis: "credit-limit-minus-available",
        formula: "credit-limit-available",
        limit: { coefficient: "2000", scale: 0 },
        available: { coefficient: "1500", scale: 0 },
      },
    },
  };
}

test("PGlite credit-card command keeps identity, instrument, statements, lifecycle, balances, and recurrence", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const first = await commitPGliteCanonicalCreditCardCapture(store, capture("credit-card-capture-a"));
    assert.equal(first.transactionCount, 1);
    assert.equal(first.instrumentCount, 1);
    assert.equal(first.statementCount, 1);
    assert.equal(first.balanceRevisionCreated, true);
    const repeated = await commitPGliteCanonicalCreditCardCapture(store, capture("credit-card-capture-b"));
    assert.equal(repeated.accountId, first.accountId);
    assert.equal(repeated.balanceRevisionCreated, false);
    const nextBalance = await commitPGliteCanonicalCreditCardBalanceCapture(store, {
      capture: capture("credit-card-balance-c", undefined, "2026-09-23T00:00:00.000Z").capture,
      account: { sourceAccountKey: accountKey, accountType: "credit", currency: "TWD" },
      identity: { accountNaturalKey: token("opaque-card-account"), identityMethod: "opaque-provider-account" },
      balance: capture("credit-card-balance-template", undefined, "2026-09-23T00:00:00.000Z").balance!,
    });
    assert.equal(nextBalance.balanceRevisionCreated, true);
    const counts = await store.query<{ table_name: string; count: number }>(`SELECT table_name, count FROM (
      SELECT 'canonical_credit_card_account_identities' AS table_name, COUNT(*)::int AS count FROM canonical_credit_card_account_identities
      UNION ALL SELECT 'canonical_credit_card_instruments', COUNT(*)::int FROM canonical_credit_card_instruments
      UNION ALL SELECT 'canonical_credit_card_instrument_evidence', COUNT(*)::int FROM canonical_credit_card_instrument_evidence
      UNION ALL SELECT 'canonical_credit_card_transaction_details', COUNT(*)::int FROM canonical_credit_card_transaction_details
      UNION ALL SELECT 'canonical_credit_card_transaction_lifecycle', COUNT(*)::int FROM canonical_credit_card_transaction_lifecycle
      UNION ALL SELECT 'canonical_credit_card_statement_revisions', COUNT(*)::int FROM canonical_credit_card_statement_revisions
      UNION ALL SELECT 'canonical_credit_card_statement_memberships', COUNT(*)::int FROM canonical_credit_card_statement_memberships
      UNION ALL SELECT 'credit_card_balance_estimate_details', COUNT(*)::int FROM credit_card_balance_estimate_details
    ) counts ORDER BY table_name`);
    assert.deepEqual(Object.fromEntries(counts.rows.map((row) => [row.table_name, Number(row.count)])), {
      canonical_credit_card_account_identities: 1,
      canonical_credit_card_instrument_evidence: 2,
      canonical_credit_card_instruments: 1,
      canonical_credit_card_statement_memberships: 1,
      canonical_credit_card_statement_revisions: 1,
      canonical_credit_card_transaction_details: 2,
      canonical_credit_card_transaction_lifecycle: 2,
      credit_card_balance_estimate_details: 2,
    });
    const balanceRows = await store.query<{ balance_coefficient: string; effective_at: string }>(`SELECT revision.balance_coefficient, revision.effective_at
      FROM balance_observation_revisions revision
      JOIN balance_observations observation ON observation.observation_id = revision.observation_id
      WHERE observation.balance_kind = 'credit_used' ORDER BY revision.effective_at`);
    assert.deepEqual(balanceRows.rows.map((row) => ({ coefficient: row.balance_coefficient, effectiveAt: row.effective_at })), [
      { coefficient: "500", effectiveAt: "2026-09-22T00:00:00.000000000Z" },
      { coefficient: "500", effectiveAt: "2026-09-23T00:00:00.000000000Z" },
    ]);
  } finally {
    await store.close();
  }
});

test("PGlite credit-card extension conflict rolls back source capture and typed rows", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalCreditCardCapture(store, capture("credit-card-rollback-seed"));
    const conflicting = capture("credit-card-rollback-conflict", token("changed-identity"));
    await assert.rejects(commitPGliteCanonicalCreditCardCapture(store, conflicting), /identity changed|identity-conflict/iu);
    assert.equal(Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count), 1);
    assert.equal(Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM canonical_credit_card_account_identities")).rows[0]?.count), 1);
  } finally {
    await store.close();
  }
});
