import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { applyPgliteBaseline } from "./baseline.ts";
import { PGliteStore } from "./transaction.ts";
import {
  commitPGliteCanonicalDepositCapture,
} from "./deposit.ts";
import {
  commitPGliteCanonicalCreditCardCapture,
  type PGliteCanonicalCreditCardCaptureRequest,
} from "./credit-card.ts";
import { refreshPGliteCurrentProjectionInTransaction } from "./projection.ts";
import {
  createForeignCurrencyDepositCapture,
} from "../canonical/foreign-currency-deposit-admission.ts";
import { YUANTA_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 } from "../canonical/foreign-currency-deposit.fixtures.ts";
import {
  FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2,
  FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
  FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS,
  FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
  FUBON_DOMESTIC_DEPOSIT_TIME_ZONE,
  admitFubonDomesticDepositCaptureEvidence,
  admitFubonDomesticDepositFinancialCapture,
  deriveFubonDomesticDepositAccountIdentity,
} from "../canonical/fubon-domestic-deposit-admission.ts";
import { FUBON_HUMAN_ATTESTED_V1_MANIFEST } from "../canonical/fubon-human-attestation-contract.ts";
import { classifyCathayDescription } from "../canonical/cathay-description-classifier.ts";
import { deriveSourceConnectionIdentityKey } from "../canonical/source-connection-identity.ts";

const token = (value: string): string => `sha256:${createHash("sha256").update(value).digest("base64url")}`;

function fubonCapture(captureId = "pglite-projection-fubon") {
  const structural = admitFubonDomesticDepositCaptureEvidence(FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
  if (structural.status !== "admissible" || !structural.capture) throw new Error("Fubon fixture is not admissible.");
  const sourceConnectionScope = "PGLITE-PROJECTION-FUBON-USER\u0000PGLITE-PROJECTION-FUBON-LOGIN";
  const sourceConnectionKey = deriveSourceConnectionIdentityKey("fubon", sourceConnectionScope);
  const identity = deriveFubonDomesticDepositAccountIdentity(
    structural.capture.account,
    FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    sourceConnectionKey,
  );
  const financial = admitFubonDomesticDepositFinancialCapture({
    capture: structural.capture,
    captureId,
    sourceConnectionScope,
    sourceConnectionKey,
    humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    semantics: {
      evidenceVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
      account: { ...identity, accountType: "depository", currency: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY },
      authority: { route: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY, scope: "personal-owned-accounts", membershipEffectiveDate: null },
      posting: { status: "posted", origin: FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN, basis: FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      direction: { outflowCellIndex: 3, inflowCellIndex: 4, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      effectiveTime: { basis: FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS, timeZone: FUBON_DOMESTIC_DEPOSIT_TIME_ZONE, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      cancellation: { rule: "explicit-none-only", ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      completeness: { basis: FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY, absenceAuthority: FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY },
      occurrence: { ruleVersion: FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION, providerGuaranteed: false },
    },
  });
  if (financial.status !== "admitted" || !financial.capture) throw new Error("Fubon financial fixture is not admitted.");
  return financial.capture;
}

function cardCapture(captureId: string, direction: "inflow" | "outflow" = "outflow"): PGliteCanonicalCreditCardCaptureRequest {
  const instrumentOccurrence = token(`${captureId}:instrument`);
  const transactionOccurrence = token(`${captureId}:transaction`);
  const records = [
    { occurrenceKey: instrumentOccurrence, providerKey: token(`${captureId}:instrument-provider`), contentHash: token(`${captureId}:instrument-content`), compact: { instrumentKey: "projection-card-instrument" }, description: "Card instrument" },
    { occurrenceKey: transactionOccurrence, providerKey: token(`${captureId}:provider`), contentHash: token(`${captureId}:content`), compact: { sourceSequence: "card-1", direction }, description: "Card purchase" },
  ];
  return {
    capture: {
      captureId,
      integrationNamespace: "fubon",
      sourceConnectionKey: token("projection-card-connection"),
      identityEpoch: token("projection-card-epoch"),
      stream: "credit-card",
      recordKind: "credit-card-capture",
      routeKey: "fubon/credit-card/human-attested-v1",
      contractVersion: "fubon/credit-card/human-attested-v1",
      subjectDigest: token("projection-card-subject"),
      observedAt: "2026-09-22T01:00:00.000Z",
      scope: { startDate: "2026-09-22", endDate: "2026-09-22", dateFormat: "YYYY-MM-DD", kind: "bounded-range", completeness: "complete-range", ruleVersion: "fubon/credit-card/human-attested-v1", completenessBasis: "projection-check", sourceAccountKey: "projection-card-account", absenceAuthority: "comparable-complete-range" },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: { fixture: "projection-check" } }],
      records,
    },
    account: { sourceAccountKey: "projection-card-account", accountType: "credit", currency: "TWD" },
    identity: { accountNaturalKey: token("projection-card-identity"), identityMethod: "opaque-provider-account" },
    instruments: [{ instrumentKey: "projection-card-instrument", cardMask: "****4281", role: "primary", lifecycle: "active", evidenceSourceOccurrenceKey: instrumentOccurrence }],
    transactions: [{
      sourceOccurrenceKey: transactionOccurrence,
      sourceSequence: "card-1",
      amount: { coefficient: "1000", scale: 0 },
      currency: "TWD",
      direction,
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      postingRuleVersion: "fubon/credit-card/human-attested-v1",
      description: "Card purchase",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "fubon/credit-card/human-attested-v1",
      effectiveOn: "2026-09-22",
      transactionDateTimeLocal: "2026-09-22T10:00:00",
      timeZone: "Asia/Taipei",
      timePrecision: "minute",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: "fubon/credit-card/human-attested-v1",
      utcInstantUtcUs: Date.parse("2026-09-22T02:00:00Z") * 1000,
      instrumentKey: "projection-card-instrument",
      billingStatus: "billed",
      consumeDate: "2026-09-22",
      postingDate: "2026-09-22",
      effectiveDateBasis: "consume-date",
    }],
    statements: [],
  };
}

test("Cathay worker classification preserves transfer and unsupported outcomes", () => {
  assert.deepEqual(classifyCathayDescription("transfer").candidates, [
    { value: "transfer.internal", confidenceBasisPoints: 8_600 },
  ]);
  assert.deepEqual(classifyCathayDescription("opaque provider note").candidates, []);
});

test("PGlite provider deposits maintain current transaction and derived bank kind", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const capture = createForeignCurrencyDepositCapture(YUANTA_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1);
    await commitPGliteCanonicalDepositCapture(store, capture);
    const rows = await store.query<{ transaction_id: Uint8Array; value_text: string; route_id: string }>(
      `SELECT current_row.transaction_id, enrichment.value_text, enrichment.route_id
         FROM current_transactions current_row
         JOIN current_transaction_enrichment enrichment
           ON enrichment.transaction_id = current_row.transaction_id
          AND enrichment.field_name = 'kind'`,
    );
    assert.equal(rows.rows.length, 1);
    // Keep parity with the canonical rule table: the fixture's retained
    // description contains the `fee` token inside "fixture".
    assert.equal(rows.rows[0]?.value_text, "fee.bank");
    assert.equal(rows.rows[0]?.route_id, "yuanta/foreign-currency-deposit/kind-enrichment/v4/kind");
    const commits = await store.query<{ commit_sequence: number; commit_kind: string }>(
      "SELECT commit_sequence, commit_kind FROM canonical_commits ORDER BY commit_sequence",
    );
    assert.deepEqual(commits.rows.map((row) => row.commit_kind), ["source_capture", "derived_import"]);
    const sourceSequence = commits.rows[0]?.commit_sequence;
    const derivedSequence = commits.rows[1]?.commit_sequence;
    assert.ok(sourceSequence !== undefined && derivedSequence !== undefined);
    assert.equal(
      Number((await store.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM enrichment_run_outputs output
           JOIN canonical_commits commit_row ON commit_row.commit_id = output.commit_id
          WHERE commit_row.commit_sequence <= $1`,
        [sourceSequence],
      )).rows[0]?.count),
      0,
    );
    assert.equal(
      Number((await store.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM enrichment_run_outputs output
           JOIN canonical_commits commit_row ON commit_row.commit_id = output.commit_id
          WHERE commit_row.commit_sequence <= $1`,
        [derivedSequence],
      )).rows[0]?.count),
      1,
    );
    const generation = (await store.query<{
      generation_id: number;
      build_cutoff_commit_sequence: number;
    }>(
      `SELECT generation_id, build_cutoff_commit_sequence
         FROM projection_generations
        WHERE status = 'active'`,
    )).rows[0];
    assert.ok(generation);
    assert.ok(Number(generation.build_cutoff_commit_sequence) >= Number(derivedSequence));
    assert.equal(
      Number((await store.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM projection_generation_transactions`,
      )).rows[0]?.count),
      1,
    );
    assert.equal(
      Number((await store.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM projection_generation_transaction_selection`,
      )).rows[0]?.count),
      1,
    );
    assert.ok(
      Number((await store.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM projection_generation_provenance`,
      )).rows[0]?.count) >= 4,
    );
  } finally {
    await store.close();
  }
});

test("PGlite source revision recurrence and complete-range withdrawal update current rows", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const first = createForeignCurrencyDepositCapture(YUANTA_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1);
    const recurrent = createForeignCurrencyDepositCapture({ ...YUANTA_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1, captureOccurrenceId: "projection-recurrent", captureId: "projection-recurrent" });
    await commitPGliteCanonicalDepositCapture(store, first);
    await commitPGliteCanonicalDepositCapture(store, recurrent);
    assert.equal(Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM current_transactions")).rows[0]?.count), 1);
    const empty = createForeignCurrencyDepositCapture({ ...YUANTA_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1, captureOccurrenceId: "projection-empty", captureId: "projection-empty", records: [], zeroResultAuthority: "provider-explicit-no-data" });
    await commitPGliteCanonicalDepositCapture(store, empty);
    assert.equal(Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM current_transactions")).rows[0]?.count), 1);
  } finally {
    await store.close();
  }
});

test("PGlite Fubon deposit and card commands refresh kind rows and rollback a failed projection", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalDepositCapture(store, fubonCapture());
    assert.equal(Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM current_transactions")).rows[0]?.count), 1);
    const card = cardCapture("projection-card-capture");
    const cardResult = await commitPGliteCanonicalCreditCardCapture(store, card);
    assert.equal(cardResult.transactionCount, 1);
    assert.equal((await store.query<{ value_text: string }>("SELECT value_text FROM current_transaction_enrichment WHERE route_id = 'fubon/credit-card/direction-enrichment/v1/kind'")).rows[0]?.value_text, "purchase");
    const before = Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count);
    const cancelled = new AbortController();
    await assert.rejects(
      commitPGliteCanonicalDepositCapture(store, fubonCapture("projection-cancelled"), {
        signal: cancelled.signal,
        projection: async (transaction, context) => {
          await refreshPGliteCurrentProjectionInTransaction(transaction, context);
          cancelled.abort();
        },
      }),
      (error: unknown) => error instanceof Error && "reason" in error && (error as { reason?: unknown }).reason === "cancelled",
    );
    assert.equal(Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count), before);
    await assert.rejects(
      commitPGliteCanonicalDepositCapture(store, fubonCapture(), {
        projection: async (transaction, context) => {
          await refreshPGliteCurrentProjectionInTransaction(transaction, context);
          throw new Error("projection regression injection");
        },
      }),
    );
    assert.equal(Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count), before);
  } finally {
    await store.close();
  }
});
