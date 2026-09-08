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
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import { buildYuantaInvestmentCapture } from "./yuanta-investment-adapters.ts";
const token = (c: string) => `sha256:${c.repeat(64)}`;
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
    legacy.exec(`DROP TABLE investment_security_name_observations;
      DELETE FROM schema_migrations WHERE version=25;
      PRAGMA user_version=24;`);
    legacy.close();
    store = createCanonicalInvestmentStore(path);
    assert.equal(
      (
        store.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
      25,
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
