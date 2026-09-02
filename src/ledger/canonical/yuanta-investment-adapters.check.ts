import assert from "node:assert/strict";
import test from "node:test";
import { admitCanonicalInvestmentCapture } from "./investment-financial.ts";
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
    /explicit buy\/sell/,
  );
});
