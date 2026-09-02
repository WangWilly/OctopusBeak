import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  admitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCapture,
  createCanonicalInvestmentStore,
  queryCanonicalInvestmentCurrent,
  type InvestmentCaptureInput,
} from "./investment-financial.ts";

const token = (letter: string) => `sha256:${letter.repeat(64)}`;

function fixture(captureId = "yuanta-trade-sanitized-1"): InvestmentCaptureInput {
  return {
    captureId,
    sourceId: "yuanta-trade",
    authorityRoute: "yuanta-trade/investment/canonical-v1",
    contractVersion: "investment/canonical/v1.yuanta-trade",
    observedAt: "2026-08-31T12:00:00.000Z",
    identity: {
      sourceConnectionKey: token("a"),
      identityEpochKey: token("b"),
      accountKey: token("c"),
      accountType: "investment",
    },
    scope: { effectiveOn: "2026-08-30", complete: true },
    securities: [{
      securityKey: "yuanta-trade:TWSE:2330",
      producerSecurityId: "TWSE:2330",
      name: "SANITIZED EQUITY",
      ticker: "2330",
      currency: "TWD",
    }],
    holdings: [{
      measurementKey: token("d"),
      sourceRecordKey: token("e"),
      securityKey: "yuanta-trade:TWSE:2330",
      quantity: { coefficient: "1000", scale: 0 },
      valuation: { coefficient: "500000", scale: 0, currency: "TWD" },
      effectiveOn: "2026-08-30",
      observedAt: "2026-08-31T12:00:00.000Z",
      lineage: { page: 0, row: 0, contractVersion: "investment/canonical/v1.yuanta-trade" },
    }],
    transactions: [{
      sourceRecordKey: token("f"),
      transactionKey: token("g"),
      securityKey: "yuanta-trade:TWSE:2330",
      action: "buy",
      quantity: { coefficient: "1000", scale: 0 },
      cashEffect: { coefficient: "-500000", scale: 0, currency: "TWD" },
      effectiveOn: "2026-08-29",
      fundingEvidence: { kind: "unresolved", sourceRecordKey: token("f") },
    }],
    margin: { kind: "embedded", amount: { coefficient: "25000", scale: 0, currency: "TWD" }, effectiveOn: "2026-08-30", sourceRecordKey: token("h") },
  };
}

test("investment capture is atomic, restart-safe, and preserves independent measurements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canonical-investment-"));
  const path = join(dir, "canonical.sqlite");
  try {
    let store = createCanonicalInvestmentStore(path);
    await commitCanonicalInvestmentCapture(store, admitCanonicalInvestmentCapture(fixture()));
    await commitCanonicalInvestmentCapture(store, admitCanonicalInvestmentCapture(fixture("yuanta-trade-sanitized-2")));
    let current = queryCanonicalInvestmentCurrent(store, token("a"));
    assert.equal(current.accounts.length, 1);
    assert.equal(current.securities.length, 1);
    assert.equal(current.holdings.length, 2);
    assert.equal(current.transactions[0]?.action, "buy");
    assert.equal(current.marginBalances[0]?.balanceKind, "margin_loan");
    assert.equal(current.transactions[0]?.fundingEvidence.kind, "unresolved");
    assert.equal(current.relations.length, 0);
    store.close();
    store = createCanonicalInvestmentStore(path);
    current = queryCanonicalInvestmentCurrent(store, token("a"));
    assert.equal(current.holdings.length, 2);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("investment admission fails closed for ambiguous actions, unstable security identity, and import-time holdings", () => {
  assert.throws(() => admitCanonicalInvestmentCapture({ ...fixture(), transactions: [{ ...fixture().transactions[0]!, action: "unknown" as "buy" }] }), /buy or sell/);
  assert.throws(() => admitCanonicalInvestmentCapture({ ...fixture(), securities: [{ ...fixture().securities[0]!, securityKey: "SANITIZED EQUITY" }] }), /producer-scoped/);
  assert.throws(() => admitCanonicalInvestmentCapture({ ...fixture(), holdings: [{ ...fixture().holdings[0]!, effectiveOn: "2026-08-31" }] }), /contract-established effective time/);
});

test("a revision requires an explicit stable correction key", () => {
  const input = fixture();
  input.holdings[0] = { ...input.holdings[0]!, correctionOfMeasurementKey: token("z") };
  assert.throws(() => admitCanonicalInvestmentCapture(input), /correction target/);
});
