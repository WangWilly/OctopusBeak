import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  admitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCapture,
  createCanonicalInvestmentStore,
  queryCanonicalInvestmentCurrent,
  queryCanonicalInvestmentHistorical,
} from "./investment-financial.ts";
import { CANONICAL_SOURCE_SCHEMA_VERSION } from "./canonical-source-store.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import {
  buildYuantaInvestmentCapture,
  YUANTA_TRADE_BROKERAGE_ACCOUNT_NUMBER_EVIDENCE_VERSION,
} from "./yuanta-investment-adapters.ts";
const token = (c: string) => `sha256:${c.repeat(64)}`;

/** Build a real v24 physical fixture before exercising v24 -> v25.  Changing
 * user_version alone would leave v26 account-identifier columns in place and
 * correctly trip the migration integrity audit as a partial schema. */
function rewindInvestmentDatabaseToV24PhysicalSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS investment_security_names_no_update;
    DROP TRIGGER IF EXISTS investment_security_names_no_delete;
    DROP TABLE IF EXISTS investment_security_name_observations;
    DROP TABLE IF EXISTS financial_account_identifier_observations;
    ALTER TABLE financial_accounts DROP COLUMN account_no;
    ALTER TABLE financial_accounts RENAME COLUMN source_account_key TO account_no;
    ALTER TABLE source_captures RENAME COLUMN source_account_key TO account_no;
    ALTER TABLE capture_scopes RENAME COLUMN source_account_key TO account_no;
    DELETE FROM schema_migrations WHERE version > 24;
    INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us)
      VALUES (24, 0);
    PRAGMA user_version = 24;
    PRAGMA foreign_keys = ON;
  `);
}

test("preserves a source brokerage account number beside the stable account key", () => {
  const capture = buildYuantaInvestmentCapture({
    sourceId: "yuanta-trade",
    captureId: "account-number-capture",
    sourceConnectionKey: token("a"),
    identityEpochKey: token("b"),
    accountKey: token("c"),
    accountNumber: {
      value: "001234567890",
      kind: "brokerage-account",
      evidenceVersion: "yuanta/trade/account-number-v1",
      sourceField: "CSV account_number",
    },
    reportingCurrency: "TWD",
    observedAt: "2026-08-31T12:00:00.000Z",
    sourceEffectiveOn: "2026-08-30",
    holdings: [
      {
        sourceRecordKey: token("d"),
        producerSecurityId: "SANITIZED",
        securityName: "SANITIZED COMPANY",
        ticker: "SANITIZED",
        currency: "TWD",
        effectiveOn: "2026-08-30",
        quantity: { coefficient: "1", scale: 0 },
      },
    ],
    transactions: [],
  });
  const identity = capture.identity as typeof capture.identity & {
    accountNumber?: unknown;
  };
  assert.equal(identity.accountKey, token("c"));
  assert.deepEqual(identity.accountNumber, {
    value: "001234567890",
    kind: "brokerage-account",
    evidenceVersion: "yuanta/trade/account-number-v1",
    sourceField: "CSV account_number",
  });
});

test("admits the live YuanTa C-format brokerage account into the investment identity", () => {
  const capture = buildYuantaInvestmentCapture({
    sourceId: "yuanta-trade",
    captureId: "c-format-account-number-capture",
    sourceConnectionKey: token("a"),
    identityEpochKey: token("b"),
    accountKey: token("c"),
    accountNumber: {
      value: "123C-0000001",
      kind: "brokerage-account",
      evidenceVersion: YUANTA_TRADE_BROKERAGE_ACCOUNT_NUMBER_EVIDENCE_VERSION,
      sourceField: "BrkAccount_C50",
    },
    reportingCurrency: "TWD",
    observedAt: "2026-08-31T12:00:00.000Z",
    sourceEffectiveOn: "2026-08-30",
    holdings: [
      {
        sourceRecordKey: token("d"),
        producerSecurityId: "TWSE:2330",
        currency: "TWD",
        effectiveOn: "2026-08-30",
        quantity: { coefficient: "1", scale: 0 },
      },
    ],
    transactions: [],
  });
  assert.doesNotThrow(() => admitCanonicalInvestmentCapture(capture));
  assert.equal(capture.identity.accountNumber?.value, "123C-0000001");
  assert.equal(
    capture.identity.accountNumber?.evidenceVersion,
    YUANTA_TRADE_BROKERAGE_ACCOUNT_NUMBER_EVIDENCE_VERSION,
  );
});

test("Yuanta repeated holdings accept a source display-name change without changing Security identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yuanta-security-name-"));
  const path = join(directory, "canonical.sqlite");
  let store = createCanonicalInvestmentStore(path);
  const capture = (captureId: string, name: string | undefined) =>
    buildYuantaInvestmentCapture({
      sourceId: "yuanta-trade",
      captureId,
      sourceConnectionKey: token("a"),
      identityEpochKey: token("b"),
      accountKey: token("c"),
      reportingCurrency: "TWD",
      observedAt: "2026-08-31T12:00:00.000Z",
      sourceEffectiveOn: "2026-08-30",
      holdings: [
        {
          sourceRecordKey: token("d"),
          producerSecurityId: "SANITIZED",
          securityName: name,
          ticker: "SANITIZED",
          currency: "USD",
          effectiveOn: "2026-08-30",
          quantity: { coefficient: "1", scale: 0 },
        },
      ],
      transactions: [],
    });
  try {
    const before = capture("name-before", "SANITIZED COMPANY");
    // Reproduce an existing Security admitted before the name-observation contract.
    delete before.securities[0]!.nameEvidence;
    await commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(before),
    );
    store.close();
    const legacy = new DatabaseSync(path);
    rewindInvestmentDatabaseToV24PhysicalSchema(legacy);
    legacy.close();
    store = createCanonicalInvestmentStore(path);
    assert.equal(
      (
        store.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
      CANONICAL_SOURCE_SCHEMA_VERSION,
    );
    const knowledgeBefore = Number(
      (
        store.db
          .prepare("SELECT MAX(commit_sequence) AS n FROM canonical_commits")
          .get() as { n: number }
      ).n,
    );
    const idBefore = (
      store.db
        .prepare("SELECT hex(security_id) AS id FROM investment_securities")
        .get() as { id: string }
    ).id;
    await commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(
        capture("name-after", "SANITIZED COMPANY-C"),
      ),
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM investment_securities")
          .get() as { count: number }
      ).count,
      1,
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT hex(security_id) AS id FROM investment_securities")
          .get() as { id: string }
      ).id,
      idBefore,
    );
    assert.equal(
      queryCanonicalInvestmentCurrent(store, token("a")).securities[0]!.name,
      "SANITIZED COMPANY-C",
    );
    assert.equal(
      queryCanonicalInvestmentHistorical(store, token("a"), {
        financialAt: "2026-08-30",
        knowledgeAt: knowledgeBefore,
      }).securities[0]!.name,
      "SANITIZED COMPANY",
    );
    const runtime = createCanonicalProjectionRuntime(store.db);
    const historical = runtime.read({
      kind: "historical",
      families: ["investment-holdings"],
      scope: { sourceConnectionKey: token("a") },
      cutoff: { financialAt: "2026-08-30", knowledgeAt: knowledgeBefore },
    });
    assert.equal(
      historical.families["investment-holdings"][0]!.securityName,
      "SANITIZED COMPANY",
    );
    assert.equal(
      runtime.read({
        kind: "current",
        families: ["investment-holdings"],
        scope: { sourceConnectionKey: token("a") },
      }).families["investment-holdings"][0]!.securityName,
      "SANITIZED COMPANY-C",
    );
    await commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(capture("name-absent", undefined)),
    );
    assert.equal(
      queryCanonicalInvestmentCurrent(store, token("a")).securities[0]!.name,
      "SANITIZED COMPANY-C",
    );
    assert.throws(
      () =>
        store.db.exec(
          "UPDATE investment_security_name_observations SET name='overwritten'",
        ),
      /immutable/,
    );
    assert.throws(
      () => store.db.exec("DELETE FROM investment_security_name_observations"),
      /cannot be deleted/,
    );
    const drift = capture("currency-drift", "ANOTHER NAME");
    drift.securities[0]!.currency = "EUR";
    await assert.rejects(
      commitCanonicalInvestmentCapture(
        store,
        admitCanonicalInvestmentCapture(drift),
      ),
      /Immutable Security/,
    );
    assert.equal(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM investment_security_name_observations",
          )
          .get() as { n: number }
      ).n,
      1,
    );
    const badEvidence = capture("bad-evidence", "ANOTHER NAME");
    badEvidence.securities[0]!.nameEvidence!.sourceRecordKey = token("z");
    assert.throws(
      () => admitCanonicalInvestmentCapture(badEvidence),
      /matching source record/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
for (const sourceId of ["yuanta-fund", "yuanta-trade"] as const)
  test(`${sourceId} sanitized rows produce a strict canonical investment capture`, () => {
    const capture = buildYuantaInvestmentCapture({
      sourceId,
      captureId: `${sourceId}-sanitized-v1`,
      sourceConnectionKey: token("a"),
      identityEpochKey: token("b"),
      accountKey: token("c"),
      observedAt: "2026-08-31T12:00:00.000Z",
      sourceEffectiveOn: "2026-08-30",
      reportingCurrency: "TWD",
      holdings: [
        {
          sourceRecordKey: token("d"),
          producerSecurityId:
            sourceId === "yuanta-fund" ? "FUND-001" : "TWSE:2330",
          securityName: "SANITIZED SECURITY",
          ticker: sourceId === "yuanta-fund" ? undefined : "2330",
          currency: "TWD",
          effectiveOn: "2026-08-30",
          quantity: { coefficient: "1000", scale: 2 },
          valuation: { coefficient: "500000", scale: 0, currency: "TWD" },
          effectiveTimeEvidence:
            sourceId === "yuanta-fund"
              ? {
                  sourceField: "reference-nav-and-fx-basis-date",
                  components: [
                    {
                      role: "reference-nav",
                      sourceField: "贖回/參考基準日",
                      value: "2026-08-29",
                    },
                    {
                      role: "reference-fx",
                      sourceField: "匯率/參考基準日",
                      value: "2026-08-30",
                    },
                  ],
                }
              : {
                  sourceField: "市價日期",
                  components: [
                    {
                      role: "market-price",
                      sourceField: "市價日期",
                      value: "2026-08-30",
                    },
                  ],
                },
        },
      ],
      transactions: [
        {
          sourceRecordKey: token("e"),
          producerSecurityId:
            sourceId === "yuanta-fund" ? "FUND-001" : "TWSE:2330",
          currency: "TWD",
          effectiveOn: "2026-08-29",
          action: "buy",
          quantity: { coefficient: "1000", scale: 2 },
          cashEffect: { coefficient: "500000", scale: 0, currency: "TWD" },
        },
      ],
    });
    assert.doesNotThrow(() => admitCanonicalInvestmentCapture(capture));
    assert.equal(capture.transactions[0]?.fundingEvidence.kind, "unresolved");
    assert.ok(capture.holdings[0]?.effectiveTimeEvidence.components?.length);
  });

test("Yuanta adapter does not guess an ambiguous transaction action", () => {
  assert.throws(
    () =>
      buildYuantaInvestmentCapture({
        sourceId: "yuanta-trade",
        captureId: "x",
        sourceConnectionKey: token("a"),
        identityEpochKey: token("b"),
        accountKey: token("c"),
        reportingCurrency: "TWD",
        observedAt: "2026-08-31T12:00:00Z",
        sourceEffectiveOn: "2026-08-30",
        holdings: [],
        transactions: [
          {
            sourceRecordKey: token("d"),
            producerSecurityId: "TWSE:2330",
            currency: "TWD",
            effectiveOn: "2026-08-29",
          },
        ],
      }),
    /explicit supported action/,
  );
});

test("Yuanta fund admits dated transactions without inventing a holding as-of date", () => {
  const capture = buildYuantaInvestmentCapture({
    sourceId: "yuanta-fund",
    captureId: "fund-transaction-only",
    sourceConnectionKey: token("a"),
    identityEpochKey: token("b"),
    accountKey: token("c"),
    reportingCurrency: "TWD",
    observedAt: "2026-09-08T12:00:00.000Z",
    sourceEffectiveOn: "2026-08-28",
    holdings: [],
    transactions: [
      {
        sourceRecordKey: token("d"),
        producerSecurityId: "FUND-001",
        securityName: "SANITIZED FUND",
        currency: "TWD",
        effectiveOn: "2026-08-28",
        action: "buy",
        quantity: { coefficient: "1000", scale: 0 },
        cashEffect: { coefficient: "10000", scale: 0, currency: "TWD" },
      },
    ],
  });
  const admitted = admitCanonicalInvestmentCapture(capture);
  assert.equal(admitted.holdings.length, 0);
  assert.equal(admitted.transactions.length, 1);
  assert.equal(admitted.transactions[0]?.effectiveOn, "2026-08-28");
  assert.equal(admitted.scope.effectiveOn, "2026-08-28");
});

test("repeated Yuanta source rows do not put capture-local keys into source occurrence content", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = (captureId: string, observedAt: string) => ({
    sourceId: "yuanta-trade" as const,
    captureId,
    sourceConnectionKey: token("a"),
    identityEpochKey: token("b"),
    accountKey: token("c"),
    reportingCurrency: "TWD",
    observedAt,
    sourceEffectiveOn: "2026-08-30",
    holdings: [
      {
        sourceRecordKey: token("d"),
        producerSecurityId: "TWSE:2330",
        currency: "TWD",
        effectiveOn: "2026-08-30",
        quantity: { coefficient: "1000", scale: 0 },
        valuation: { coefficient: "500000", scale: 0, currency: "TWD" },
      },
    ],
    transactions: [
      {
        sourceRecordKey: token("e"),
        producerSecurityId: "TWSE:2330",
        currency: "TWD",
        effectiveOn: "2026-08-29",
        action: "buy" as const,
        quantity: { coefficient: "1000", scale: 0 },
        cashEffect: { coefficient: "500000", scale: 0, currency: "TWD" },
      },
    ],
  });
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(
      buildYuantaInvestmentCapture(input("first", "2026-08-31T12:00:00.000Z")),
    ),
  );
  await assert.doesNotReject(
    commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(
        buildYuantaInvestmentCapture(
          input("second", "2026-09-01T12:00:00.000Z"),
        ),
      ),
    ),
  );
  store.close();
});
