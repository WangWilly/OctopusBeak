import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAssets } from "../lib/assets/server/load-assets.ts";
import {
  admitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCapture,
  createCanonicalInvestmentStore,
  type InvestmentCaptureInput,
  type InvestmentSourceId,
} from "./canonical/investment-financial.ts";
import { canonicalSqlitePath } from "./canonical/canonical-database.ts";

const token = (label: string) =>
  `sha256:${createHash("sha256").update(label).digest("base64url")}`;

async function symbolsAfterSnapshots(options: {
  fixtureName: string;
  sourceId: InvestmentSourceId;
  snapshots: string[][];
}) {
  const rootDir = await mkdtemp(join(tmpdir(), `${options.fixtureName}-`));
  const outputDir = join(rootDir, "ledger");
  const store = createCanonicalInvestmentStore(canonicalSqlitePath(outputDir));
  try {
    for (const [index, symbols] of options.snapshots.entries()) {
      await commitCanonicalInvestmentCapture(
        store,
        admitCanonicalInvestmentCapture(investmentSnapshot(options.sourceId, index, symbols)),
      );
    }
    const assets = await loadAssets(outputDir, { expectedSources: [] });
    return Object.values(assets.positionsByAccount)
      .flat()
      .map((position) => position.symbol)
      .sort();
  } finally {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("a newer brokerage holdings snapshot removes sold positions", async () => {
  const symbols = await symbolsAfterSnapshots({
    fixtureName: "brokerage-snapshot-replacement",
    sourceId: "yuanta-trade",
    snapshots: [["ANET", "VRT"], ["ANET"]],
  });
  assert.deepEqual(symbols, ["ANET"]);
});

test("an empty brokerage holdings snapshot clears the account positions", async () => {
  const symbols = await symbolsAfterSnapshots({
    fixtureName: "brokerage-empty-snapshot",
    sourceId: "yuanta-trade",
    snapshots: [["ANET"], []],
  });
  assert.deepEqual(symbols, []);
});

test("a newer fund holdings snapshot removes redeemed funds", async () => {
  const symbols = await symbolsAfterSnapshots({
    fixtureName: "fund-snapshot-replacement",
    sourceId: "yuanta-fund",
    snapshots: [["FUND-A", "FUND-B"], ["FUND-A"]],
  });
  assert.deepEqual(symbols, ["FUND-A"]);
});

function investmentSnapshot(
  sourceId: InvestmentSourceId,
  index: number,
  symbols: readonly string[],
): InvestmentCaptureInput {
  const route = `${sourceId}/investment/canonical-v1`;
  const observedAt = `2026-07-31T${String(9 + index).padStart(2, "0")}:00:00.000Z`;
  return {
    captureId: token(`${sourceId}:capture:${index}`),
    sourceId,
    authorityRoute: route,
    contractVersion: route,
    observedAt,
    identity: {
      sourceConnectionKey: token(`${sourceId}:connection`),
      identityEpochKey: token(`${sourceId}:epoch`),
      accountKey: token(`${sourceId}:account`),
      accountType: "investment",
      reportingCurrency: "TWD",
    },
    scope: { effectiveOn: "2026-07-31", complete: true },
    securities: symbols.map((symbol) => ({
      securityKey: `${sourceId}:${symbol}`,
      producerSecurityId: symbol,
      name: `${symbol} Holding`,
      ticker: symbol,
      currency: "USD",
      securityType: sourceId === "yuanta-fund" ? "mutual_fund" as const : "equity" as const,
      identityEvidence: { kind: "producer-security-id" as const, contractVersion: route },
    })),
    holdings: symbols.map((symbol, row) => ({
      measurementKey: token(`${sourceId}:measurement:${index}:${symbol}`),
      measurementSubjectKey: token(`${sourceId}:subject:${symbol}`),
      sourceRecordKey: token(`${sourceId}:record:${index}:${symbol}`),
      securityKey: `${sourceId}:${symbol}`,
      quantity: { coefficient: String(row + 1), scale: 0 },
      valuation: { coefficient: String((row + 1) * 100), scale: 0, currency: "USD" },
      effectiveOn: "2026-07-31",
      observedAt,
      effectiveTimeEvidence: {
        kind: "source-reported-as-of" as const,
        sourceRecordKey: token(`${sourceId}:record:${index}:${symbol}`),
        sourceField: "as_of_date",
        value: "2026-07-31",
        contractVersion: route,
      },
      lineage: { page: 0, row, contractVersion: route },
    })),
    transactions: [],
  };
}
