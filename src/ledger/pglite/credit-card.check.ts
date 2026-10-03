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
import { canonicalOccurrenceGroupKey } from "../canonical/occurrence-groups.ts";

const route = "esun/credit-card/human-attested-v4";
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
  const occurrenceScopeKey = token("credit-card-occurrence-scope");
  const occurrenceFingerprint = token("credit-card-economic-fingerprint");
  const records = [
    { occurrenceKey: instrument, providerKey: token("instrument-provider"), contentHash: token("instrument-content"), compact: { kind: "instrument", instrumentKey: "opaque-primary" } },
    { occurrenceKey: transaction, occurrenceGroup: { scopeKey: occurrenceScopeKey, fingerprint: occurrenceFingerprint, partitionDate: "2026-09-22", ordinal: 1 }, occurrenceGroupBucketKey: "month:2026/09", providerKey: token("transaction-provider"), contentHash: token("transaction-content"), compact: { kind: "transaction", sourceSequence: "transaction-1", amount: "1000" }, description: "Card purchase" },
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
      occurrenceGroupCoverage: [{
        scopeKey: occurrenceScopeKey,
        startDate: "2026-09-22",
        endDate: "2026-09-22",
        contractVersion: route,
        bucketKeys: ["month:2026/09"],
      }],
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

const fubonRoute = "fubon/credit-card/human-attested-v2";
const fubonOccurrenceScope = token("fubon-credit-card-economic-scope");
const fubonFingerprint = token("fubon-duplicate-transaction-fingerprint");
const fubonInstrumentOccurrence = token("fubon-credit-card-instrument");

function fubonLifecycleCapture(
  captureId: string,
  billingStatuses: readonly ("billed" | "unbilled")[],
  date = "2026-09-22",
  options: Readonly<{
    bucketKeys?: readonly string[];
    billedBucketKey?: string;
    scopeStartDate?: string;
    scopeEndDate?: string;
    fingerprint?: string;
  }> = {},
): PGliteCanonicalCreditCardCaptureRequest {
  const bucketKeys = options.bucketKeys ?? ["statement:2026/09", "unbilled"];
  const billedBucketKey = options.billedBucketKey ?? "statement:2026/09";
  const scopeStartDate = options.scopeStartDate ?? date;
  const scopeEndDate = options.scopeEndDate ?? date;
  const fingerprint = options.fingerprint ?? fubonFingerprint;
  const groups = billingStatuses.map((_, index) => ({
    scopeKey: fubonOccurrenceScope,
    fingerprint,
    partitionDate: date,
    ordinal: index + 1,
  }));
  const occurrenceKeys = groups.map(canonicalOccurrenceGroupKey);
  const compact = {
    kind: "transaction",
    instrumentKey: "opaque-primary",
    consumeDate: "2026-09-22",
    postingDate: "2026-09-22",
    amount: "1000",
    currency: "TWD",
    direction: "outflow",
    description: "Duplicate purchase",
  };
  const records = [
    {
      occurrenceKey: fubonInstrumentOccurrence,
      collisionKey: fubonInstrumentOccurrence,
      providerKey: "human-attested:no-provider-key",
      humanAttestedOccurrenceKey: fubonInstrumentOccurrence,
      contentHash: token("fubon-credit-card-instrument-content"),
      compact: { kind: "instrument", instrumentKey: "opaque-primary" },
      sequenceLexeme: "observed-source-order:0",
    },
    ...groups.map((group, index) => ({
      occurrenceKey: occurrenceKeys[index]!,
      collisionKey: occurrenceKeys[index]!,
      occurrenceGroup: group,
      occurrenceGroupBucketKey: billingStatuses[index] === "unbilled"
        ? "unbilled"
        : billedBucketKey,
      providerKey: "human-attested:no-provider-key",
      humanAttestedOccurrenceKey: occurrenceKeys[index]!,
      contentHash: token("fubon-credit-card-transaction-content"),
      compact,
      sequenceLexeme: `observed-source-order:${index + 1}`,
      description: "Duplicate purchase",
    })),
  ];
  return {
    capture: {
      captureId,
      integrationNamespace: "fubon",
      sourceConnectionKey: token("fubon-credit-card-check-connection"),
      identityEpoch: token("fubon-credit-card-check-epoch"),
      stream: "credit-card",
      recordKind: "fubon-credit-card-transaction",
      routeKey: fubonRoute,
      contractVersion: fubonRoute,
      subjectDigest: token("fubon-credit-card-check-subject"),
      observedAt: "2026-09-22T01:00:00.000Z",
      scope: {
        startDate: scopeStartDate,
        endDate: scopeEndDate,
        dateFormat: "YYYY-MM-DD",
        kind: "bounded-range",
        completeness: "complete-range",
        ruleVersion: fubonRoute,
        completenessBasis: "six-billed-periods-plus-unbilled-terminal-grids",
        sourceAccountKey: "fubon-credit-card-portfolio",
        absenceAuthority: "comparable-complete-range",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: { fixture: "fubon-lifecycle" } }],
      records,
      occurrenceGroupCoverage: [{
        scopeKey: fubonOccurrenceScope,
        startDate: scopeStartDate,
        endDate: scopeEndDate,
        contractVersion: fubonRoute,
        bucketKeys,
      }],
    },
    account: { sourceAccountKey: "fubon-credit-card-portfolio", accountType: "credit", currency: "TWD" },
    identity: { accountNaturalKey: token("fubon-opaque-account"), identityMethod: "human-attested-portfolio" },
    instruments: [{ instrumentKey: "opaque-primary", cardMask: "****4281", role: "primary", lifecycle: "active", evidenceSourceOccurrenceKey: fubonInstrumentOccurrence }],
    transactions: billingStatuses.map((billingStatus, index) => ({
      sourceOccurrenceKey: occurrenceKeys[index]!,
      sourceSequence: occurrenceKeys[index]!,
      amount: { coefficient: "1000", scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: fubonRoute,
      description: "Duplicate purchase",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: fubonRoute,
      effectiveOn: date,
      transactionDateTimeLocal: `${date}T10:00:00`,
      timeZone: "Asia/Taipei",
      timePrecision: "minute",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: fubonRoute,
      utcInstantUtcUs: Date.parse(`${date}T02:00:00Z`) * 1000,
      instrumentKey: "opaque-primary",
      billingStatus,
      consumeDate: date,
      postingDate: date,
      effectiveDateBasis: "consume-date",
      ...(billingStatus === "billed" ? { statementKey: "statement-2026-09" } : {}),
    })),
    statements: [],
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

test("card routes reject date-only or incomplete group proof before writing", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const complete = capture("credit-card-missing-inventory");
    const dateOnly = {
      ...complete,
      capture: {
        ...complete.capture,
        occurrenceGroupCoverage: complete.capture.occurrenceGroupCoverage?.map(
          ({ bucketKeys: _bucketKeys, ...entry }) => entry,
        ),
      },
    };
    await assert.rejects(
      commitPGliteCanonicalCreditCardCapture(store, dateOnly),
      /complete queried-bucket inventory/u,
    );

    const incomplete = {
      ...complete,
      capture: {
        ...complete.capture,
        captureId: "credit-card-incomplete-history",
        scope: {
          ...complete.capture.scope,
          kind: "point-in-time" as const,
          completeness: "single-page" as const,
        },
      },
    };
    await assert.rejects(
      commitPGliteCanonicalCreditCardCapture(store, incomplete),
      /complete bounded source history/u,
    );
    assert.equal(
      Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count),
      0,
    );
  } finally {
    await store.close();
  }
});

test("Fubon duplicate group slots preserve billing lifecycle and reject billed/unbilled overlap", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalCreditCardCapture(
      store,
      fubonLifecycleCapture("fubon-unbilled-duplicates", ["unbilled", "unbilled"]),
    );
    await assert.rejects(
      commitPGliteCanonicalCreditCardCapture(
        store,
        fubonLifecycleCapture("fubon-mixed-duplicate-grids", ["billed", "unbilled"]),
      ),
      /cannot appear in billed and unbilled grids/u,
    );
    assert.equal(Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count), 1);
    await commitPGliteCanonicalCreditCardCapture(
      store,
      fubonLifecycleCapture("fubon-billed-duplicates", ["billed", "billed"]),
    );
    await assert.rejects(
      commitPGliteCanonicalCreditCardCapture(
        store,
        fubonLifecycleCapture("fubon-oldest-group-zero-after-date-shift", [], "2026-09-23"),
      ),
      /cannot reduce their billed member count/u,
    );
    await assert.rejects(
      commitPGliteCanonicalCreditCardCapture(
        store,
        fubonLifecycleCapture("fubon-billing-regression", ["unbilled", "unbilled"]),
      ),
      /cannot reduce their billed member count/u,
    );

    const counts = await store.query<{ transactions: number; revisions: number; lifecycle: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM financial_transactions) AS transactions,
        (SELECT COUNT(*)::int FROM transaction_revisions) AS revisions,
        (SELECT COUNT(*)::int FROM canonical_credit_card_transaction_lifecycle) AS lifecycle`);
    assert.deepEqual(counts.rows[0], { transactions: 2, revisions: 2, lifecycle: 4 });

    const latest = await store.query<{ billing_status: string; group_ordinal: number | string }>(`
      SELECT DISTINCT ON (lifecycle.transaction_id)
        lifecycle.billing_status,
        source_record.occurrence_group_ordinal AS group_ordinal
      FROM canonical_credit_card_transaction_lifecycle lifecycle
      JOIN source_records source_record
        ON source_record.source_record_id = lifecycle.source_record_id
      JOIN source_captures source_capture
        ON source_capture.capture_id = lifecycle.capture_id
      JOIN canonical_commits commit_row
        ON commit_row.commit_id = source_capture.commit_id
      ORDER BY lifecycle.transaction_id, commit_row.commit_sequence DESC,
        lifecycle.lifecycle_event_id DESC`);
    assert.deepEqual(
      latest.rows.map((row) => ({
        billingStatus: row.billing_status,
        ordinal: Number(row.group_ordinal),
      })).sort((left, right) => left.ordinal - right.ordinal),
      [
        { billingStatus: "billed", ordinal: 1 },
        { billingStatus: "billed", ordinal: 2 },
      ],
    );

    const emptyGroupFingerprint = token("aged-out-empty-group");
    await commitPGliteCanonicalCreditCardCapture(
      store,
      fubonLifecycleCapture(
        "fubon-aged-out-billed-period-before-empty",
        ["billed", "billed"],
        "2026-09-22",
        {
          bucketKeys: ["statement:2026/08", "statement:2026/09", "unbilled"],
          billedBucketKey: "statement:2026/08",
          fingerprint: emptyGroupFingerprint,
        },
      ),
    );
    const agedOut = await commitPGliteCanonicalCreditCardCapture(
      store,
      fubonLifecycleCapture(
        "fubon-aged-out-billed-period-empty",
        [],
        "2026-09-23",
        {
          bucketKeys: ["statement:2026/09", "statement:2026/10", "unbilled"],
          scopeStartDate: "2026-09-20",
          scopeEndDate: "2026-09-30",
          fingerprint: emptyGroupFingerprint,
        },
      ),
    );
    assert.equal(agedOut.status, "committed");

    await commitPGliteCanonicalCreditCardCapture(
      store,
      fubonLifecycleCapture(
        "fubon-aged-out-partial-group-before-window-shift",
        ["billed", "billed"],
        "2026-09-22",
        {
          bucketKeys: ["statement:2026/07", "statement:2026/09", "unbilled"],
          billedBucketKey: "statement:2026/07",
          fingerprint: token("aged-out-partial-group"),
        },
      ),
    );
    const partialAgedOutGroup = await commitPGliteCanonicalCreditCardCapture(
      store,
      fubonLifecycleCapture(
        "fubon-aged-out-partial-group-current-window",
        ["billed"],
        "2026-09-23",
        {
          bucketKeys: ["statement:2026/09", "statement:2026/10", "unbilled"],
          billedBucketKey: "statement:2026/09",
          scopeStartDate: "2026-09-20",
          scopeEndDate: "2026-09-30",
          fingerprint: token("aged-out-partial-group"),
        },
      ),
    );
    assert.equal(partialAgedOutGroup.status, "committed");
  } finally {
    await store.close();
  }
});


test("Fubon current balance capture succeeds after grouped billed history without transaction inventory", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const history = fubonLifecycleCapture("fubon-before-current-balance", ["billed"]);
    await commitPGliteCanonicalCreditCardCapture(store, history);
    const template = capture("fubon-current-balance-template");
    const balanceTemplate = template.balance!;
    const route = "fubon/credit-card/current-used-credit-v1";
    const balance = {
      ...balanceTemplate,
      observation: {
        ...balanceTemplate.observation,
        effectiveTimeRuleVersion: route,
        evidenceContractVersion: route,
      },
    };
    const record = template.capture.records.find((row) => row.occurrenceKey === balance.observation.sourceOccurrenceKey)!;
    const result = await commitPGliteCanonicalCreditCardBalanceCapture(store, {
      capture: {
        ...history.capture,
        captureId: "fubon-current-balance-after-history",
        recordKind: "credit-card-current-used-credit",
        routeKey: route, contractVersion: route,
        scope: { ...history.capture.scope, kind: "point-in-time", completeness: "single-page", ruleVersion: route, absenceAuthority: undefined },
        occurrenceGroupCoverage: undefined,
        records: [record],
        pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: {} }],
      },
      account: history.account, identity: history.identity, balance,
    });
    assert.equal(result.balanceRevisionCreated, true);
    assert.equal(result.transactionCount, 0);
    const incompleteHistory = fubonLifecycleCapture("fubon-empty-history-without-inventory", []);
    await assert.rejects(commitPGliteCanonicalCreditCardCapture(store, {
      ...incompleteHistory,
      capture: { ...incompleteHistory.capture, occurrenceGroupCoverage: undefined },
    }), /requires complete queried-bucket inventory/u);
    const count = await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM canonical_credit_card_transaction_lifecycle");
    assert.equal(count.rows[0]?.count, 1);
  } finally { await database.close(); }
});
