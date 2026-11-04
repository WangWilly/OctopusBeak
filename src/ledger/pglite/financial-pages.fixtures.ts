import assert from "node:assert/strict";
import type { OverviewPageDto } from "../../lib/overview/types.ts";
import { commitPGliteCanonicalBalanceCapture, type PGliteCanonicalBalanceCaptureRequest } from "./balance.ts";
import { createPGliteCanonicalSourceStore, type PGliteCanonicalFinancialCommitRequest } from "./canonical-source-store.ts";
import { applyManualAssetCommand } from "./manual-assets.ts";
import { createPgliteOperationalProvider } from "./operational.ts";
import type { PGlitePreviewFinancialDataPort, PreviewAccount, PreviewVisibility } from "./preview-financial-data.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * Test data shared by the Financial page checks: the ledger's own page checks
 * and the Electron checks of the registry and live views that serve them.
 */

const token = (value: string): string => `sha256:${value.padEnd(64, value.at(-1) ?? "x").slice(0, 64)}`;
export const VISIBLE: PreviewVisibility = { visible: [{ sourceId: "synthetic", product: "deposit" }] };
export const HIDDEN: PreviewVisibility = { visible: [] };
export const TODAY = "2026-10-15";

export function depositCommit(): PGliteCanonicalFinancialCommitRequest {
  const occurrenceKey = token("occurrence");
  return {
    capture: {
      captureId: "preview-check-deposit",
      integrationNamespace: "cathay",
      sourceConnectionKey: token("a"),
      identityEpoch: token("b"),
      stream: "domestic-deposit",
      recordKind: "source-record",
      routeKey: "cathay/domestic-deposit/v1",
      contractVersion: "v1",
      subjectDigest: token("c"),
      observedAt: "2026-10-01T00:00:00.000Z",
      accountNumber: { value: "123456", kind: "depository-account", evidenceVersion: "synthetic-v1", sourceField: "accountNumber" },
      scope: {
        startDate: "20261001", endDate: "20261001", kind: "point-in-time", completeness: "single-page",
        ruleVersion: "cathay/domestic-deposit/v1", sourceAccountKey: "123456",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: { pageCount: 1 } }],
      records: [{
        occurrenceKey,
        collisionKey: token("collision"),
        providerKey: token("provider"),
        contentHash: token("content"),
        compact: { amount: { coefficient: "100", scale: 0 } },
      }],
    },
    account: { sourceAccountKey: "123456", accountNo: "123456", accountType: "depository", currency: "TWD" },
    transactions: [{
      sourceOccurrenceKey: occurrenceKey,
      sourceSequence: "sequence-1",
      amount: { coefficient: "100", scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "query-status-success-with-accounting-date",
      postingRuleVersion: "cathay/domestic-deposit/v1",
      description: "canonical outflow",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "cathay/domestic-deposit/v1",
      effectiveOn: "2026-10-01",
      transactionDateTimeLocal: "2026-10-01T00:00:00+08:00",
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "accounting",
      effectiveTimeRuleVersion: "cathay/domestic-deposit/v1",
      utcInstantUtcUs: 1,
    }],
  };
}

export function canonicalBalanceOf100Point1Twd(): PGliteCanonicalBalanceCaptureRequest {
  const occurrenceKey = token("balance-occurrence");
  const effectiveAt = "2026-10-01T04:00:00.000Z";
  return {
    capture: {
      captureId: "preview-check-balance",
      integrationNamespace: "cathay",
      sourceConnectionKey: token("a"),
      identityEpoch: token("b"),
      stream: "domestic-deposit",
      recordKind: "synthetic-balance",
      routeKey: "cathay/domestic-deposit/current-balance-v1",
      contractVersion: "cathay/current-deposit-balance-v1",
      subjectDigest: token("balance-subject"),
      observedAt: effectiveAt,
      accountNumber: null,
      scope: {
        startDate: "2026-10-01", endDate: "2026-10-01", dateFormat: "YYYY-MM-DD", kind: "point-in-time",
        completeness: "single-page", ruleVersion: "cathay/current-deposit-balance-v1",
        sourceAccountKey: "123456", accountNo: "123456",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: { provider: "synthetic" } }],
      records: [{
        occurrenceKey,
        collisionKey: token("balance-collision"),
        providerKey: token("balance-provider"),
        contentHash: token("balance-content"),
        compact: { balance: { coefficient: "1001", scale: 1 }, effectiveAt, currency: "TWD" },
      }],
    },
    account: { sourceAccountKey: "123456", accountType: "depository", currency: "TWD" },
    observations: [{
      observationKey: token("ledger-observation"),
      balanceKind: "ledger",
      balance: { coefficient: "1001", scale: 1 },
      currency: "TWD",
      effectiveAt,
      effectiveTimeBasis: "provider-system-time",
      effectiveTimeRuleVersion: "cathay/current-deposit-balance-v1",
      evidenceSourceRecordKey: occurrenceKey,
      evidenceSourceField: "balance",
      evidenceSourceValue: "100.1",
      evidenceContractVersion: "cathay/current-deposit-balance-v1",
      sourceOccurrenceKey: occurrenceKey,
    }],
  };
}

export const twdSavings: PreviewAccount = {
  sourceAccountKey: "savings",
  displayLabel: "Preview savings",
  currency: "TWD",
  type: "depository",
  balances: [
    { kind: "current", amount: "1000.00", currency: "TWD", observedAt: { at: "2026-10-03T02:00:00.000Z", source: "reported" } },
    { kind: "current", amount: "1234.50", currency: "TWD", observedAt: { at: "2026-10-05T02:00:00.000Z", source: "reported" } },
  ],
  transactions: [
    { sourceRowKey: "row-1", amount: "250", currency: "TWD", direction: "unknown",
      postedAt: { precision: "day", value: "2026-10-04" }, description: "preview row" },
    { sourceRowKey: "row-2", amount: "-40", currency: "TWD", direction: "outflow",
      postedAt: { precision: "minute", value: "2026-10-05T09:30" }, description: "preview fee" },
  ],
};

export const usdSavings: PreviewAccount = {
  sourceAccountKey: "usd",
  displayLabel: "Preview USD",
  currency: "USD",
  type: "depository",
  balances: [{ kind: "current", amount: "10.00", currency: "USD", observedAt: { at: "2026-10-05T02:00:00.000Z", source: "collection-time" } }],
  transactions: [],
};

/** The verified 100.1 TWD deposit every preview check starts from: one canonical outflow and its balance. */
export async function commitVerifiedDeposit(store: PGliteStore): Promise<void> {
  await createPGliteCanonicalSourceStore(store).commit(depositCommit());
  await commitPGliteCanonicalBalanceCapture(store, canonicalBalanceOf100Point1Twd());
}

/** One synthetic preview deposit collection holding the given accounts. */
export async function writePreviewDeposits(preview: PGlitePreviewFinancialDataPort, ...accounts: PreviewAccount[]): Promise<void> {
  await preview.write({
    sourceId: "synthetic",
    institution: "bank-017",
    product: "deposit",
    collection: { collectedAt: "2026-10-05T03:00:00.000Z", accounts },
  });
}

/** A USD rate of 32 TWD, dated `rateDate`. */
export function addUsdRate(store: PGliteStore, rateDate: string): Promise<void> {
  return createPgliteOperationalProvider(store).exchangeRates.upsertExchangeRates([{
    rateDate, currency: "USD", twdPerUnit: 32, source: "check", fetchedAt: `${rateDate}T00:00:00.000Z`,
  }]);
}

export function convertedNet(overview: OverviewPageDto) {
  const net = overview.summary.net;
  if (net.display !== "converted") assert.fail(`expected a converted Net position, got ${net.display}`);
  return net;
}

export const MANUAL_CLOCK = { now: () => "2026-11-01T02:00:00.000Z", today: () => "2026-11-01" };

export const createManualAsset = (category: string, name: string, currency: string, valuedOn: string, amount: string, source: string) => ({
  kind: "createAsset", category, name, currency, firstValuation: { valuedOn, amount, source, note: null },
});

/** Apply a Manual Asset command at `MANUAL_CLOCK`, failing the check on a refusal. */
export async function applyManual(store: PGliteStore, command: unknown) {
  const result = await applyManualAssetCommand(store, command, MANUAL_CLOCK);
  if (!result.ok) assert.fail(`refused: ${result.code}`);
  return result;
}
