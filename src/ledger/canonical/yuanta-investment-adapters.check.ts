import assert from "node:assert/strict";
import test from "node:test";
import {
  admitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCapture,
  createCanonicalInvestmentStore,
} from "./investment-financial.ts";
import { buildYuantaInvestmentCapture } from "./yuanta-investment-adapters.ts";
const token = (c: string) => `sha256:${c.repeat(64)}`;
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
        buildYuantaInvestmentCapture(input("second", "2026-09-01T12:00:00.000Z")),
      ),
    ),
  );
  store.close();
});
