import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { applyPgliteBaseline } from "./baseline.ts";
import { buildCathayDomesticFinancialRequestsForPGlite } from "./cathay-domestic-adapter.ts";
import { commitPGliteCanonicalFinancialCapture } from "./canonical-source-store.ts";
import {
  commitPGliteCanonicalLoanCapture,
  type PGliteCanonicalLoanCommitRequest,
} from "./loan.ts";
import { PGliteStore } from "./transaction.ts";
import {
  resolvePGliteCanonicalLoanRepaymentRelations,
  queryPGliteCurrentLoanRepaymentRelations,
  queryPGliteCurrentLoanRepaymentSettlementGroups,
} from "./relations.ts";
import { canonicalOccurrenceGroupKey } from "../canonical/occurrence-groups.ts";
import { canonicalLoanOccurrenceScopeKey } from "../canonical/loan-admission.ts";
import { buildFubonLoanPaymentAccountEvidence, type FubonDepositStatementEvidence } from "../../workflows/fubon-statements.ts";
import { buildFubonLoanCapture } from "../canonical/fubon-loan-admission.ts";

const token = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("base64url")}`;

function loanRequest(captureId: string, amount = "1000", fixtureKey = "primary"): PGliteCanonicalLoanCommitRequest {
  const accountKey = token("loan-account");
  const occurrenceGroup = {
    scopeKey: canonicalLoanOccurrenceScopeKey("fubon", accountKey),
    fingerprint: token(fixtureKey === "primary" ? "loan-payment-group" : `${fixtureKey}:loan-payment-group`),
    partitionDate: "2026-09-21",
    ordinal: 1,
  };
  const sourceRecordKey = canonicalOccurrenceGroupKey(occurrenceGroup);
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
      occurrenceGroupCoverage: [{
        scopeKey: occurrenceGroup.scopeKey,
        startDate: "2026-09-21",
        endDate: "2026-09-21",
        contractVersion: "loan/canonical/v2.fubon",
      }],
      records: [{
        sourceRecordKey,
        occurrenceIndex: 1,
        sourceSequenceIndex: 1,
        occurrenceGroup,
        occurrenceCollisionKey: token(`${fixtureKey}:loan-collision`),
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
        observationKey: token(fixtureKey === "primary" ? "loan-balance" : `${fixtureKey}:loan-balance`),
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

function loanGroupRequest(captureId: string, memberCount: number): PGliteCanonicalLoanCommitRequest {
  const base = loanRequest(captureId);
  const firstRecord = base.capture.records[0]!;
  const records = Array.from({ length: memberCount }, (_, index) => {
    const ordinal = index + 1;
    const occurrenceGroup = { ...firstRecord.occurrenceGroup, ordinal };
    const sourceRecordKey = canonicalOccurrenceGroupKey(occurrenceGroup);
    return {
      ...firstRecord,
      sourceRecordKey,
      occurrenceIndex: ordinal,
      sourceSequenceIndex: ordinal,
      occurrenceGroup,
      occurrenceCollisionKey: token(`loan-payment-collision:${ordinal}`),
      eventEvidence: { ...firstRecord.eventEvidence, sourceRecordKey },
      balanceSourceEvidence: (firstRecord.balanceSourceEvidence ?? []).map((evidence) => ({
        ...evidence,
        observationKey: token(`loan-payment-observation:${ordinal}`),
      })),
    };
  });
  const balanceObservations = records.map((record) => {
    const baseObservation = base.capture.balanceObservations[0]!;
    return {
      ...baseObservation,
      observationKey: token(`loan-payment-observation:${record.occurrenceIndex}`),
      sourceRecordKey: record.sourceRecordKey,
      effectiveTimeEvidence: {
        ...baseObservation.effectiveTimeEvidence,
        sourceRecordKey: record.sourceRecordKey,
      },
    };
  });
  return {
    ...base,
    capture: {
      ...base.capture,
      pages: base.capture.pages.map((page) => ({ ...page, rowCount: memberCount })),
      records,
      balanceObservations,
    },
  };
}

function loanRequestWithRepaymentDeposit(captureId: string, fixtureKey: string): PGliteCanonicalLoanCommitRequest {
  const base = loanRequest(captureId, "1000", fixtureKey);
  const sourceRecordKey = token(`${fixtureKey}:counterpart-source`);
  const relationId = token(`${fixtureKey}:counterpart-relation`);
  const contractVersion = "loan/counterpart/v1.fubon";
  return {
    ...base,
    capture: {
      ...base.capture,
      counterpartTransactions: [{
        captureId: `${fixtureKey}-counterpart-capture`,
        sourceRecordKey,
        occurrenceIndex: 1,
        sourceConnectionKey: base.capture.identity.sourceConnectionKey,
        identityEpochKey: base.capture.identity.identityEpochKey,
        accountKey: token(`${fixtureKey}:repayment-account`),
        subjectDigest: token(`${fixtureKey}:counterpart-subject`),
        accountNo: token(`${fixtureKey}:counterpart-number`),
        accountType: "depository" as const,
        stream: "domestic-deposit" as const,
        recordKind: "fubon-loan-counterpart-deposit",
        authorityRoute: "fubon/loan/counterpart-deposit-v1",
        contractVersion,
        effectiveOn: "2026-09-21",
        sourceTime: { localTime: "12:00:00", precision: "second" as const, timeOrigin: "source_reported" as const },
        postingStatus: "posted" as const,
        direction: "outflow" as const,
        amount: { coefficient: "1000", scale: 0 },
        currency: "TWD" as const,
        description: "repayment booking",
        sourceEvidence: { kind: "source-linked-counterpart" as const, sourceRecordKey, relationId, contractVersion },
      }],
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

test("Fubon loan slots survive unrelated insertion and reject group shrinkage atomically", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const makeCapture = (observedAt: string, rows: readonly {
      transactionDate: string;
      transactionContent: string;
      transactionAmount: string;
      balanceAfterTransaction: string;
    }[]) => ({
      capture: buildFubonLoanCapture({
        accountValue: "fubon-group-continuity-account",
        sourceConnectionScope: "fubon-group-continuity-connection",
        observedAt,
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        scope: {
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          completeness: "complete-range",
          completenessBasis: "source-declared-terminal-range",
          completenessRuleVersion: "loan/canonical/v2.fubon",
          pageCount: 1,
          terminal: true,
        },
        pages: [{
          pageOrdinal: 0,
          responseCode: "200",
          terminal: true,
          rowCount: rows.length,
          proofKind: "source-declared-terminal-range",
        }],
        counterpartTransactions: [],
        relations: [],
        relationCoverage: "not-asserted",
        rows,
      }),
    });
    const payment = {
      transactionDate: "2026/09/10",
      transactionContent: "LOAN-PAYMENT",
      transactionAmount: "1000.00",
      balanceAfterTransaction: "9000.00",
    };
    const fee = {
      transactionDate: "2026/09/01",
      transactionContent: "LOAN-FEE",
      transactionAmount: "100.00",
      balanceAfterTransaction: "10000.00",
    };
    const first = makeCapture("2026-10-01T00:00:00.000Z", [payment, payment]);
    const firstResult = await commitPGliteCanonicalLoanCapture(store, first, { clock: () => 100 });
    const originalSlots = firstResult.transactions.map((row) => ({
      key: row.sourceOccurrenceKey,
      id: row.transactionId,
      revision: row.revisionId,
    }));
    assert.equal(originalSlots.length, 2);

    const grown = makeCapture("2026-10-02T00:00:00.000Z", [fee, payment, payment, payment]);
    const grownResult = await commitPGliteCanonicalLoanCapture(store, grown, { clock: () => 101 });
    for (const prior of originalSlots) {
      const retained = grownResult.transactions.find((row) => row.sourceOccurrenceKey === prior.key);
      assert.ok(retained);
      assert.equal(retained.transactionId, prior.id);
      assert.equal(retained.revisionId, prior.revision);
      assert.equal(retained.revisionCreated, false);
    }
    assert.deepEqual(
      grown.capture.records.filter((row) => row.effectiveOn === "2026-09-10").map((row) => row.occurrenceIndex),
      [1, 2, 3],
    );

    await assert.rejects(
      commitPGliteCanonicalLoanCapture(store, makeCapture("2026-10-03T00:00:00.000Z", [fee, payment]), { clock: () => 102 }),
      /occurrence group cannot lose members/iu,
    );
    await assert.rejects(
      commitPGliteCanonicalLoanCapture(store, makeCapture("2026-10-04T00:00:00.000Z", [fee]), { clock: () => 103 }),
      /occurrence group cannot lose members/iu,
    );
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count, 2);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM loan_transaction_facts")).rows[0]?.count, 4);
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

test("PGlite loan settlement groups keep member history and roll back cancelled replacement", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const first = loanRequestWithRepaymentDeposit("loan-group-capture-1", "primary");
    const second = loanGroupRequest("loan-group-capture-2", 2);
    await commitPGliteCanonicalLoanCapture(store, first, { clock: () => 100 });
    await commitPGliteCanonicalLoanCapture(store, second, { clock: () => 101 });

    const deposit = first.capture.counterpartTransactions[0]!;
    const repaymentAccountValue = "123456789012";
    const commonEvidence = {
      sourceConnectionKey: first.capture.identity.sourceConnectionKey,
      accountValue: repaymentAccountValue,
      role: "beneficiary" as const,
      purpose: "loan_repayment",
      contractVersion: "loan/canonical/v2.fubon",
    };
    const relationRequest = {
      sourceConnectionKey: first.capture.identity.sourceConnectionKey,
      observedAt: "2026-09-22T01:00:00.000Z",
      counterpartyEvidence: [
        {
          ...commonEvidence,
          captureId: deposit.captureId,
          sourceRecordKey: deposit.sourceRecordKey,
          identityEpochKey: deposit.identityEpochKey,
          evidenceKind: "transaction-counterparty-account" as const,
        },
        {
          ...commonEvidence,
          captureId: first.capture.captureId,
          sourceRecordKey: first.capture.records[0]!.sourceRecordKey,
          identityEpochKey: first.capture.identity.identityEpochKey,
          accountKey: first.capture.identity.accountKey,
          evidenceKind: "repayment-mandate" as const,
        },
      ],
    };
    const firstResolution = await resolvePGliteCanonicalLoanRepaymentRelations(store, relationRequest, { clock: () => 102 });
    assert.equal(firstResolution.settlementGroupIds.length, 1, JSON.stringify(firstResolution));
    const firstGroupId = firstResolution.settlementGroupIds[0]!;
    const firstGroups = await queryPGliteCurrentLoanRepaymentSettlementGroups(store, {
      sourceConnectionKey: relationRequest.sourceConnectionKey,
    });
    assert.equal(firstGroups.length, 1);
    assert.equal(firstGroups[0]?.settlementGroupId, firstGroupId);
    const firstMembers = firstGroups[0]?.members as readonly Readonly<{ memberKind: string }>[] | undefined;
    assert.equal(firstMembers?.length, 3);
    assert.deepEqual(new Set(firstMembers?.map((member) => member.memberKind)), new Set(["deposit_outflow", "loan_payment"]));

    const third = loanGroupRequest("loan-group-capture-3", 3);
    await commitPGliteCanonicalLoanCapture(store, third, { clock: () => 103 });
    const cancelled = new AbortController();
    await assert.rejects(
      resolvePGliteCanonicalLoanRepaymentRelations(store, relationRequest, {
        clock: () => 104,
        signal: cancelled.signal,
        projection: async () => {
          cancelled.abort();
        },
      }),
      /cancel/iu,
    );
    assert.deepEqual(
      (await queryPGliteCurrentLoanRepaymentSettlementGroups(store, {
        sourceConnectionKey: relationRequest.sourceConnectionKey,
      })).map((group) => group.settlementGroupId),
      [firstGroupId],
      "the cancelled group replacement and withdrawal must roll back together",
    );
    assert.deepEqual((await store.query<{ event_kind: string }>(
      "SELECT event_kind FROM loan_repayment_relation_events ORDER BY event_id",
    )).rows.map((row) => row.event_kind), ["observed"]);

    const replacement = await resolvePGliteCanonicalLoanRepaymentRelations(store, relationRequest, { clock: () => 105 });
    assert.equal(replacement.outcome, "changed");
    assert.equal(replacement.settlementGroupIds.length, 1);
    assert.notEqual(replacement.settlementGroupIds[0], firstGroupId);
    const current = await queryPGliteCurrentLoanRepaymentSettlementGroups(store, {
      sourceConnectionKey: relationRequest.sourceConnectionKey,
    });
    assert.equal(current.length, 1);
    assert.equal(current[0]?.settlementGroupId, replacement.settlementGroupIds[0]);
    const currentMembers = current[0]?.members as readonly Readonly<{ memberKind: string }>[] | undefined;
    assert.equal(currentMembers?.length, 4);
    const lifecycle = await store.query<{
      event_kind: string;
      settlement_group_id: Uint8Array;
      commit_sequence: number | string;
    }>(
      `SELECT event.event_kind, event.settlement_group_id, event_commit.commit_sequence
         FROM loan_repayment_relation_events event
         JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
        ORDER BY event_commit.commit_sequence, encode(event.event_id, 'hex')`,
    );
    const eventsByGroup = new Map<string, string[]>();
    for (const event of lifecycle.rows) {
      const groupId = Buffer.from(event.settlement_group_id).toString("hex");
      const events = eventsByGroup.get(groupId) ?? [];
      events.push(event.event_kind);
      eventsByGroup.set(groupId, events);
    }
    assert.deepEqual(eventsByGroup.get(firstGroupId.replaceAll("-", "")), ["observed", "withdrawn"]);
    assert.deepEqual(eventsByGroup.get(replacement.settlementGroupIds[0]?.replaceAll("-", "")), ["observed"]);
    assert.deepEqual((await store.query<{ settlement_group_id: Uint8Array }>(
      "SELECT settlement_group_id FROM current_loan_repayment_settlement_groups",
    )).rows.map((row) => Buffer.from(row.settlement_group_id).toString("hex")), [replacement.settlementGroupIds[0]?.replaceAll("-", "")]);
  } finally {
    await store.close();
  }
});

test("default PGlite enrichment records superseded and withdrawn assertion transitions", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const request = (captureLabel: string, description: string) =>
      buildCathayDomesticFinancialRequestsForPGlite({
        sourceConnectionId: "pglite-transition-cathay-connection",
        identityEpoch: "pglite-transition-cathay-epoch",
        authorityRoute: "cathay/domestic-deposit/v1",
        stream: "domestic-deposit",
        observedAt: `2026-09-22T01:00:${captureLabel === "first" ? "00" : captureLabel === "second" ? "01" : "02"}.000Z`,
        scopes: [{
          accountNo: "pglite-transition-account",
          accountNumber: {
            value: "987654",
            kind: "depository-account",
            evidenceVersion: "cathay/domestic-deposit/v1",
            sourceField: "accountNo",
          },
          currency: "TWD",
          startDate: "2026-09-22",
          endDate: "2026-09-22",
          contractFingerprint: "cathay/domestic-deposit/v1",
          preflightFingerprint: "cathay/domestic-deposit/v1",
          pages: [{
            pageOrdinal: 0,
            rowCount: 1,
            responseDigest: token(`${captureLabel}:response`),
          }],
          rows: [{
            sequence: "transition-row-1",
            accountDate: "2026-09-22",
            transactionDateTime: "2026-09-22T09:00:00",
            description,
            utcInstantUtcUs: Date.parse("2026-09-22T01:00:00Z") * 1_000,
            amount: { coefficient: 1_000n, scale: 0 },
            direction: "outflow",
            balance: { coefficient: 9_000n, scale: 0 },
            payload: JSON.stringify({ captureLabel, description, sequence: "transition-row-1" }),
          }],
        }],
      })[0]!;

    const first = await commitPGliteCanonicalFinancialCapture(store, request("first", "transfer"));
    assert.equal(first.transactions.length, 1);
    const second = await commitPGliteCanonicalFinancialCapture(store, request("second", "deposit"));
    assert.equal(second.transactions.length, 1);
    const third = await commitPGliteCanonicalFinancialCapture(store, request("third", "opaque provider note"));
    assert.equal(third.transactions.length, 1);

    const transitions = await store.query<{
      event_kind: string;
      assertion_id: Uint8Array;
      transition_commit_id: Uint8Array;
      run_commit_id: Uint8Array;
      output_state: string;
      output_assertion_id: Uint8Array | null;
    }>(
      `SELECT transition.event_kind, transition.assertion_id,
              transition.commit_id AS transition_commit_id,
              run.commit_id AS run_commit_id,
              output.output_state, output.assertion_id AS output_assertion_id
         FROM assertion_transitions transition
         JOIN enrichment_runs run ON run.run_id = transition.enrichment_run_id
         JOIN enrichment_run_outputs output
           ON output.run_id = run.run_id
          AND output.transaction_id = transition.transaction_id
          AND output.field_name = transition.field_name
        WHERE transition.enrichment_run_id IS NOT NULL
          AND transition.event_kind IN ('observed', 'superseded', 'withdrawn')
        ORDER BY (SELECT commit_sequence FROM canonical_commits WHERE commit_id = transition.commit_id),
                 transition.event_kind`,
    );
    assert.deepEqual(transitions.rows.map((row) => row.event_kind), ["observed", "observed", "superseded", "withdrawn"]);
    const observed = transitions.rows[0]!;
    const replacementObserved = transitions.rows[1]!;
    const superseded = transitions.rows[2]!;
    const withdrawn = transitions.rows[3]!;
    assert.equal(observed.output_state, "supported");
    assert.deepEqual(observed.output_assertion_id, observed.assertion_id);
    assert.equal(replacementObserved.output_state, "supported");
    assert.deepEqual(replacementObserved.output_assertion_id, replacementObserved.assertion_id);
    assert.equal(superseded.output_state, "supported");
    assert.deepEqual(superseded.assertion_id, observed.assertion_id);
    assert.deepEqual(superseded.output_assertion_id, replacementObserved.assertion_id);
    assert.deepEqual(withdrawn.assertion_id, replacementObserved.assertion_id);
    assert.equal(withdrawn.output_state, "unsupported");
    assert.equal(withdrawn.output_assertion_id, null);
    for (const transition of transitions.rows)
      assert.deepEqual(transition.transition_commit_id, transition.run_commit_id);
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
        occurrenceGroupCoverage: next.capture.occurrenceGroupCoverage.map((coverage) => ({
          ...coverage,
          endDate: "2026-09-22",
        })),
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


test("Fubon repeated deposit capture resolves repayment evidence through its stable account scope", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const first = loanRequestWithRepaymentDeposit("fubon-replay-first", "replay");
    await commitPGliteCanonicalLoanCapture(store, first);
    const deposit = first.capture.counterpartTransactions[0]!;
    const repeatedDeposit = { ...deposit, captureId: "fubon-replay-deposit-second" };
    await commitPGliteCanonicalLoanCapture(store, {
      capture: { ...first.capture, captureId: "fubon-replay-second", counterpartTransactions: [repeatedDeposit] },
    });
    const queryRange = { startDate: "2026/09/21", endDate: "2026/09/21" };
    const sourceAccount = { value: "synthetic-deposit", label: "SYNTHETIC", branchName: "000" };
    const source: FubonDepositStatementEvidence = {
      evidenceVersion: "capture-evidence-v2", source: "fubon",
      observedAt: first.capture.observedAt, account: sourceAccount, queryRange,
      pages: [{ pageOrdinal: 0, responseSequence: 1, terminal: true,
        nextPage: null, pageFieldName: null, queryRange, selectedAccount: sourceAccount,
        rows: [{ rowOrdinal: 0, cells: [
          "2026/09/21", "12:00:00", "放款繳款", "1000", "", "100", "01234567890123測試分行",
        ] }], zeroObservation: "non-empty-page" }],
      zeroObservation: "non-empty-range",
      providerRouteEvidence: { endpointPath: "/synthetic", contract: "synthetic", currency: "TWD" },
      provenance: { source: "fubon-ebank-domestic-deposit-form-postback", responseBodyRetained: false, semantics: "unresolved" },
    };
    const evidence = buildFubonLoanPaymentAccountEvidence(source, {
      captureId: repeatedDeposit.captureId,
      identity: { sourceConnectionKey: deposit.sourceConnectionKey,
        identityEpochKey: deposit.identityEpochKey, accountNo: token("display-only-account"),
        sourceAccountKey: deposit.accountKey },
      records: [{ occurrenceKey: deposit.sourceRecordKey, sequenceLexeme: "0:0" }],
    });
    await resolvePGliteCanonicalLoanRepaymentRelations(store, {
      sourceConnectionKey: deposit.sourceConnectionKey,
      observedAt: first.capture.observedAt, counterpartyEvidence: evidence,
    });
    const rows = await store.query<{ transaction_id: unknown; account_id: unknown }>(
      "SELECT transaction_id, account_id FROM transaction_counterparty_account_evidence");
    assert.equal(rows.rows.length, 1);
    assert.ok(rows.rows[0]?.transaction_id);
    assert.equal(rows.rows[0]?.account_id, null);
  } finally { await store.close(); }
});

test("repeated deposit capture resolves repayment evidence that names no account through its capture scope", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const first = loanRequestWithRepaymentDeposit("unscoped-replay-first", "replay");
    await commitPGliteCanonicalLoanCapture(store, first);
    const deposit = first.capture.counterpartTransactions[0]!;
    const repeatedDeposit = { ...deposit, captureId: "unscoped-replay-deposit-second" };
    await commitPGliteCanonicalLoanCapture(store, {
      capture: { ...first.capture, captureId: "unscoped-replay-second", counterpartTransactions: [repeatedDeposit] },
    });
    const queryRange = { startDate: "2026/09/21", endDate: "2026/09/21" };
    const sourceAccount = { value: "synthetic-deposit", label: "SYNTHETIC", branchName: "000" };
    const source: FubonDepositStatementEvidence = {
      evidenceVersion: "capture-evidence-v2", source: "fubon",
      observedAt: first.capture.observedAt, account: sourceAccount, queryRange,
      pages: [{ pageOrdinal: 0, responseSequence: 1, terminal: true,
        nextPage: null, pageFieldName: null, queryRange, selectedAccount: sourceAccount,
        rows: [{ rowOrdinal: 0, cells: [
          "2026/09/21", "12:00:00", "放款繳款", "1000", "", "100", "01234567890123測試分行",
        ] }], zeroObservation: "non-empty-page" }],
      zeroObservation: "non-empty-range",
      providerRouteEvidence: { endpointPath: "/synthetic", contract: "synthetic", currency: "TWD" },
      provenance: { source: "fubon-ebank-domestic-deposit-form-postback", responseBodyRetained: false, semantics: "unresolved" },
    };
    const evidence = buildFubonLoanPaymentAccountEvidence(source, {
      captureId: repeatedDeposit.captureId,
      identity: { sourceConnectionKey: deposit.sourceConnectionKey,
        identityEpochKey: deposit.identityEpochKey, accountNo: token("display-only-account"),
        sourceAccountKey: deposit.accountKey },
      records: [{ occurrenceKey: deposit.sourceRecordKey, sequenceLexeme: "0:0" }],
    });
    // Yuanta deposit evidence carries no account key; the capture already names its account.
    const unscopedEvidence = evidence.map(({ accountKey: _accountKey, ...rest }) => rest);
    assert.ok(unscopedEvidence.length > 0 && unscopedEvidence.every((item) => !("accountKey" in item)));
    await resolvePGliteCanonicalLoanRepaymentRelations(store, {
      sourceConnectionKey: deposit.sourceConnectionKey,
      observedAt: first.capture.observedAt, counterpartyEvidence: unscopedEvidence,
    });
    const rows = await store.query<{ transaction_id: unknown; account_id: unknown }>(
      "SELECT transaction_id, account_id FROM transaction_counterparty_account_evidence");
    assert.equal(rows.rows.length, 1);
    assert.ok(rows.rows[0]?.transaction_id);
    assert.equal(rows.rows[0]?.account_id, null);
  } finally { await store.close(); }
});
