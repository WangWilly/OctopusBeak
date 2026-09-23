import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { applyPgliteBaseline } from "./baseline.ts";
import {
  commitPGliteCanonicalLoanCapture,
  type PGliteCanonicalLoanCommitRequest,
} from "./loan.ts";
import { PGliteStore } from "./transaction.ts";
import {
  resolvePGliteCanonicalLoanRepaymentRelations,
  queryPGliteCurrentLoanRepaymentRelations,
} from "./relations.ts";

const token = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("base64url")}`;

function loanRequest(captureId: string, amount = "1000"): PGliteCanonicalLoanCommitRequest {
  const sourceRecordKey = token("loan-payment");
  const accountKey = token("loan-account");
  const balanceEvidence = {
    kind: "source-reported-balance" as const,
    balanceKind: "loan_outstanding" as const,
    balanceField: "balance-after-transaction" as const,
    balance: { coefficient: amount, scale: 0 },
    effectiveAtField: "transaction-date" as const,
    effectiveAt: "2026-09-21",
    effectiveAtPrecision: "date" as const,
    effectiveAtTimeOrigin: "source_reported" as const,
    storageAnchor: "effective-at-date-only" as const,
    contractVersion: "loan/canonical/v2.fubon",
  };
  return {
    capture: {
      captureId,
      sourceId: "fubon",
      authorityRoute: "fubon/loan/canonical-v2",
      contractVersion: "loan/canonical/v2.fubon",
      identity: {
        sourceConnectionKey: token("fubon-connection"),
        identityEpochKey: token("fubon-epoch"),
        accountKey,
        subjectDigest: token("fubon-loan-subject"),
        accountType: "loan",
        accountNo: token("loan-display-identity"),
        accountNumber: {
          value: "123456",
          kind: "loan-account",
          evidenceVersion: "fubon/loan-number-v1",
          sourceField: "accountNo",
        },
        stream: "loan",
        recordKind: "fubon-loan-transaction",
        currency: "TWD",
      },
      observedAt: "2026-09-22T01:00:00.000Z",
      scope: {
        startDate: "2026-09-21",
        endDate: "2026-09-21",
        completeness: "complete-range",
        completenessBasis: "source-declared-terminal-range",
        completenessRuleVersion: "loan/canonical/v2.fubon",
        pageCount: 1,
        terminal: true,
      },
      semantics: {
        status: "posted",
        effectiveTimeBasis: "source-reported",
        effectiveTimeRuleVersion: "loan/canonical/v2.fubon",
        timeZone: "Asia/Taipei",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", terminal: true, rowCount: 1, proofKind: "source-declared-terminal-range" }],
      records: [{
        sourceRecordKey,
        occurrenceIndex: 1,
        effectiveOn: "2026-09-21",
        sourceTime: { localTime: "12:00:00", precision: "second", timeOrigin: "source_reported" },
        postingStatus: "posted",
        eventKind: "payment",
        eventEvidence: { kind: "source-coded-loan-event", sourceRecordKey, sourceCode: "LOAN-PAYMENT", contractVersion: "loan/canonical/v2.fubon" },
        direction: "inflow",
        amount: { coefficient: amount, scale: 0 },
        currency: "TWD",
        description: "payment",
        balanceSourceEvidence: [balanceEvidence],
      }],
      counterpartTransactions: [],
      balanceObservations: [{
        observationKey: token("loan-balance"),
        sourceRecordKey,
        balanceKind: "loan_outstanding",
        balance: { coefficient: amount, scale: 0 },
        currency: "TWD",
        effectiveAt: "2026-09-21",
        effectiveAtPrecision: "date",
        effectiveAtTimeOrigin: "source_reported",
        effectiveTimeBasis: "source-reported",
        effectiveTimeRuleVersion: "loan/canonical/v2.fubon",
        effectiveTimeEvidence: {
          kind: "source-reported-balance-effective-time",
          sourceRecordKey,
          sourceField: "statement-as-of",
          sourceFieldRole: "transaction-date",
          value: "2026-09-21",
          precision: "date",
          timeOrigin: "source_reported",
          storageAnchor: "effective-at-date-only",
          contractVersion: "loan/canonical/v2.fubon",
        },
      }],
      relations: [],
      relationCoverage: "not-asserted",
    },
  };
}

test("PGlite loan command writes typed facts and deduplicates recurring observations", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const first = await commitPGliteCanonicalLoanCapture(store, loanRequest("loan-capture-1"), { clock: () => 100 });
    assert.equal(first.transactions.length, 1);
    assert.equal(first.balanceObservationCount, 1);
    const repeat = await commitPGliteCanonicalLoanCapture(store, loanRequest("loan-capture-2"), { clock: () => 100 });
    assert.equal(repeat.transactions[0]?.revisionCreated, false);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM loan_transaction_facts")).rows[0]?.count, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM balance_observation_revisions")).rows[0]?.count, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count, 2);
  } finally {
    await store.close();
  }
});

test("PGlite loan command rolls back a changed occurrence atomically", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalLoanCapture(store, loanRequest("loan-capture-1"), { clock: () => 100 });
    await assert.rejects(
      commitPGliteCanonicalLoanCapture(store, loanRequest("loan-capture-conflict", "1200"), { clock: () => 100 }),
      /occurrence|overwrite|contradict/iu,
    );
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM loan_transaction_facts")).rows[0]?.count, 1);
  } finally {
    await store.close();
  }
});

test("PGlite relation command admits scoped repayment evidence and deduplicates replay", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const capture = loanRequest("loan-evidence-capture").capture;
    await commitPGliteCanonicalLoanCapture(store, { capture }, { clock: () => 100 });
    const evidence = {
      captureId: capture.captureId,
      sourceRecordKey: capture.records[0]!.sourceRecordKey,
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpochKey: capture.identity.identityEpochKey,
      accountKey: capture.identity.accountKey,
      accountValue: "123456789012",
      role: "beneficiary" as const,
      purpose: "loan_repayment",
      evidenceKind: "repayment-mandate" as const,
      contractVersion: "loan/canonical/v2.fubon",
    };
    const request = {
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      observedAt: capture.observedAt,
      counterpartyEvidence: [evidence],
    };
    await resolvePGliteCanonicalLoanRepaymentRelations(store, request, { clock: () => 101 });
    await resolvePGliteCanonicalLoanRepaymentRelations(store, request, { clock: () => 102 });
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM transaction_counterparty_account_evidence")).rows[0]?.count, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM counterparty_account_evidence_support")).rows[0]?.count, 1);
    await assert.rejects(resolvePGliteCanonicalLoanRepaymentRelations(store, {
      ...request,
      counterpartyEvidence: [{ ...evidence, identityEpochKey: "wrong-epoch" }],
    }), /source scope/u);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM transaction_counterparty_account_evidence")).rows[0]?.count, 1);
  } finally {
    await store.close();
  }
});

test("PGlite loan command commits counterpart source and relation atomically", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const base = loanRequest("loan-capture-with-counterpart");
    const sourceRecordKey = token("counterpart-source");
    const counterpartAccountKey = token("repayment-account");
    const relationId = token("loan-relation");
    const capture = {
      ...base.capture,
      counterpartTransactions: [{
        captureId: "counterpart-capture-1",
        sourceRecordKey,
        occurrenceIndex: 1,
        sourceConnectionKey: base.capture.identity.sourceConnectionKey,
        identityEpochKey: base.capture.identity.identityEpochKey,
        accountKey: counterpartAccountKey,
        subjectDigest: token("counterpart-subject"),
        accountNo: token("counterpart-number"),
        accountType: "depository" as const,
        stream: "domestic-deposit" as const,
        recordKind: "fubon-loan-counterpart-deposit",
        authorityRoute: "fubon/loan/counterpart-deposit-v1",
        contractVersion: "loan/counterpart/v1.fubon",
        effectiveOn: "2026-09-21",
        sourceTime: { localTime: "12:00:00", precision: "second" as const, timeOrigin: "source_reported" as const },
        postingStatus: "posted" as const,
        direction: "outflow" as const,
        amount: { coefficient: "1000", scale: 0 },
        currency: "TWD" as const,
        description: "repayment booking",
        sourceEvidence: { kind: "source-linked-counterpart" as const, sourceRecordKey, relationId, contractVersion: "loan/counterpart/v1.fubon" },
      }],
      relations: [{
        kind: "transfer_counterpart" as const,
        fromSourceRecordKey: base.capture.records[0]!.sourceRecordKey,
        toSourceRecordKey: sourceRecordKey,
        fromAccountKey: base.capture.identity.accountKey,
        toAccountKey: counterpartAccountKey,
        fromDirection: "inflow" as const,
        toDirection: "outflow" as const,
        evidence: { kind: "explicit-source-linkage" as const, sourceRecordKey, relationId, contractVersion: "loan/canonical/v2.fubon" },
      }],
      relationCoverage: "source-linked-complete" as const,
    };
    const result = await commitPGliteCanonicalLoanCapture(store, { capture }, { clock: () => 100 });
    assert.equal(result.counterpartTransactionCount, 1);
    assert.equal(result.relationCount, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM transaction_relations")).rows[0]?.count, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM loan_account_identities WHERE account_type = 'depository'")).rows[0]?.count, 1);
    const relationRequest = {
      sourceConnectionKey: base.capture.identity.sourceConnectionKey,
      explicitLinks: [{
        fromCaptureId: "counterpart-capture-1",
        fromSourceRecordKey: sourceRecordKey,
        toCaptureId: base.capture.captureId,
        toSourceRecordKey: base.capture.records[0]!.sourceRecordKey,
        relationId,
        contractVersion: "loan/canonical/v2.fubon",
      }],
      observedAt: "2026-09-22T01:00:00.000Z",
    };
    const resolved = await resolvePGliteCanonicalLoanRepaymentRelations(store, relationRequest, { clock: () => 101 });
    assert.equal(resolved.outcome, "changed");
    assert.equal((await queryPGliteCurrentLoanRepaymentRelations(store)).length, 1);
    const resolvedAgain = await resolvePGliteCanonicalLoanRepaymentRelations(store, relationRequest, { clock: () => 102 });
    assert.equal(resolvedAgain.outcome, "unchanged");
    assert.deepEqual(resolvedAgain.exactRelationIds, resolved.exactRelationIds);
  } finally {
    await store.close();
  }
});

test("PGlite Fubon loan capture permits balance-only evolution as a new observation revision", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalLoanCapture(store, loanRequest("loan-capture-1"), { clock: () => 100 });
    const next = loanRequest("loan-capture-balance-update");
    const record = next.capture.records[0]!;
    const balanceEvidence = {
      ...record.balanceSourceEvidence![0]!,
      balance: { coefficient: "900", scale: 0 },
      effectiveAt: "2026-09-22",
    };
    const evolved = {
      ...next,
      capture: {
        ...next.capture,
        observedAt: "2026-09-23T01:00:00.000Z",
        scope: { ...next.capture.scope, endDate: "2026-09-22" },
        records: [{ ...record, balanceSourceEvidence: [balanceEvidence] }],
        balanceObservations: [{
          ...next.capture.balanceObservations[0]!,
          balance: { coefficient: "900", scale: 0 },
          effectiveAt: "2026-09-22",
          effectiveTimeEvidence: { ...next.capture.balanceObservations[0]!.effectiveTimeEvidence, value: "2026-09-22" },
        }],
      },
    };
    const result = await commitPGliteCanonicalLoanCapture(store, evolved, { clock: () => 200 });
    assert.equal(result.transactions[0]?.revisionCreated, false);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM balance_observation_revisions")).rows[0]?.count, 2);
    assert.deepEqual((await store.query<{ balance_coefficient: string; effective_at: string }>("SELECT balance_coefficient, effective_at FROM balance_observation_revisions ORDER BY revision_number")).rows, [{ balance_coefficient: "1000", effective_at: "2026-09-20T16:00:00.000000000Z" }, { balance_coefficient: "900", effective_at: "2026-09-21T16:00:00.000000000Z" }]);
  } finally {
    await store.close();
  }
});
