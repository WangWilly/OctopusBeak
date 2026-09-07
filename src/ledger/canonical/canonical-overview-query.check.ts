import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLedgerDatabase } from "../../ledger/db/client.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  canonicalSqlitePath,
} from "./canonical-source-store.ts";
import {
  admitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCapture,
  createCanonicalInvestmentStore,
  type InvestmentCaptureInput,
} from "./investment-financial.ts";
import { createCanonicalOverviewQuery, exactAmountToNumber } from "./canonical-overview-query.ts";
import { loadOverview } from "../../lib/overview/server/load-overview.ts";

const token = (label: string) =>
  `sha256:${createHash("sha256").update(label).digest("base64url")}`;

test("unsafe exact presentation never becomes a fabricated zero", () => {
  assert.ok(Number.isNaN(exactAmountToNumber({ coefficient: "1", scale: 400 })));
  assert.ok(Number.isNaN(exactAmountToNumber({ coefficient: "1".padEnd(400, "0"), scale: 0 })));
});

test("Current Overview keeps canonical account identity and never infers deposit balance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-overview-query-"));
  try {
    const before = await createCanonicalOverviewQuery(directory).current();
    assert.equal(before.projection.availability, "awaiting");
    assert.deepEqual(before.projection.accounts, []);

    await commitCathayDomesticDeposit(directory, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
    await commitCathayDomesticDeposit(directory, {
      ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
      sourceConnectionId: "synthetic-cathay-connection-2",
      identityEpoch: "cathay-domestic-deposit-v1-2",
    });
    const current = await createCanonicalOverviewQuery(directory).current();
    assert.equal(current.projection.accounts.length, 2);
    assert.equal(new Set(current.projection.accounts.map((account) => account.id)).size, 2);
    assert.equal(new Set(current.projection.accounts.map((account) => account.label)).size, 1);
    assert.ok(current.projection.accounts.every((account) => account.amounts.length === 0));
    assert.ok(current.projection.accounts.every((account) => account.availability === "awaiting"));
    assert.ok(current.projection.accounts.every((account) => account.transactionCount > 0));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabled expected sources remain visible before their first canonical capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-overview-expected-source-"));
  const expectedSource = {
    sourceId: "cathay",
    integrationNamespace: "cathay",
    label: "Cathay United Bank",
  } as const;
  try {
    const current = await createCanonicalOverviewQuery(directory, {
      expectedSources: [expectedSource],
    }).current();
    assert.equal(current.projection.availability, "awaiting");
    assert.deepEqual(current.projection.sourceGaps, [{
      accountId: "expected:cathay",
      sourceConnectionKey: "expected:cathay",
      accountNo: "",
      integrationNamespace: "cathay",
      stream: undefined,
      label: "Cathay United Bank",
      reason: "source-not-collected",
    }]);
    const overview = await loadOverview(directory, { expectedSources: [expectedSource] });
    assert.equal(overview.coverage, "partial");
    assert.equal(overview.sourceGaps[0]?.label, "Cathay United Bank");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Current Overview uses exact current holding valuation and exposes its trace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-overview-investment-"));
  const store = createCanonicalInvestmentStore(canonicalSqlitePath(directory));
  try {
    const capture = admitCanonicalInvestmentCapture(investmentFixture());
    await commitCanonicalInvestmentCapture(store, capture);
    const current = await createCanonicalOverviewQuery(directory).current();
    const account = current.projection.accounts.find((row) => row.kind === "crypto");
    assert.ok(account);
    assert.deepEqual(account.amounts.map((amount) => ({
      currency: amount.currency,
      exact: amount.exact,
    })), [{ currency: "USD", exact: { coefficient: "123456", scale: 2 } }]);
    assert.deepEqual(account.marginAmounts.map((amount) => ({
      currency: amount.currency,
      exact: amount.exact,
    })), [{ currency: "USD", exact: { coefficient: "777", scale: 0 } }]);
    assert.equal(account.amounts[0]?.traces[0]?.kind, "investment-holding-observation");
    assert.equal(current.projection.positions[0]?.kind, "crypto");
    assert.equal(current.projection.positions[0]?.amount.exact.coefficient, "123456");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Overview loader preserves exact totals and marks Current-only history unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-overview-loader-"));
  const store = createCanonicalInvestmentStore(canonicalSqlitePath(directory));
  try {
    await commitCanonicalInvestmentCapture(store, admitCanonicalInvestmentCapture(investmentFixture()));
    store.close();
    const withoutRate = await loadOverview(directory);
    assert.equal(withoutRate.sankey, null);
    const ledger = openLedgerDatabase(directory);
    ledger.prepare("INSERT INTO exchange_rates (rate_date, currency, twd_per_unit, source, fetched_at) VALUES (?, ?, ?, ?, ?)").run(
      "2026-08-31", "USD", 32, "test", "2026-08-31T12:00:00.000Z",
    );
    ledger.close();
    const overview = await loadOverview(directory);
    assert.equal(overview.availability, "available");
    assert.equal(overview.historyAvailability, "unavailable");
    assert.deepEqual(overview.summary[1]?.amounts[0]?.exact, { coefficient: "123456", scale: 2 });
    assert.equal(overview.summary[1]?.amounts[0]?.value, 1234.56);
    const convertedLink = overview.sankey?.links.at(-1);
    assert.equal(convertedLink?.value, 39505.92);
    assert.deepEqual(convertedLink?.conversion, {
      fromCurrency: "USD",
      toCurrency: "TWD",
      rateDate: "2026-08-31",
      twdPerUnit: 32,
      convertedExact: { coefficient: "3950592", scale: 2 },
    });
    assert.deepEqual(convertedLink?.exact, { coefficient: "123456", scale: 2 });
    assert.equal(overview.dailyHistory.length, 0);
    assert.equal(overview.accounts[0]?.amountLines[0]?.traces?.[0]?.kind, "investment-holding-observation");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mixed typed and awaiting accounts mark Overview totals partial", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-overview-partial-coverage-"));
  try {
    await commitCathayDomesticDeposit(directory, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
    const store = createCanonicalInvestmentStore(canonicalSqlitePath(directory));
    await commitCanonicalInvestmentCapture(store, admitCanonicalInvestmentCapture(investmentFixture()));
    store.close();
    const overview = await loadOverview(directory);
    assert.equal(overview.availability, "available");
    assert.equal(overview.coverage, "partial");
    assert.equal(overview.sourceGaps.length, 1);
    assert.ok(overview.accounts.some((account) => account.valueAvailability === "available"));
    assert.ok(overview.accounts.some((account) => account.valueAvailability === "awaiting"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Current Overview with an unvalued current holding does not present a partial total", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-overview-partial-"));
  const store = createCanonicalInvestmentStore(canonicalSqlitePath(directory));
  try {
    const capture = investmentFixture();
    capture.securities.push({
      securityKey: "yuanta-trade:ETH",
      producerSecurityId: "ETH",
      name: "Ether",
      ticker: "ETH",
      currency: "USD",
      securityType: "cryptocurrency",
      identityEvidence: { kind: "producer-security-id", contractVersion: "yuanta-trade/investment/canonical-v1" },
    });
    capture.holdings.push({
      measurementKey: token("overview-unvalued-measurement"),
      measurementSubjectKey: token("overview-unvalued-subject"),
      sourceRecordKey: token("overview-unvalued-record"),
      securityKey: "yuanta-trade:ETH",
      quantity: { coefficient: "1", scale: 0 },
      effectiveOn: "2026-08-30",
      observedAt: "2026-08-31T12:00:00.000Z",
      effectiveTimeEvidence: {
        kind: "source-reported-as-of",
        sourceRecordKey: token("overview-unvalued-record"),
        sourceField: "as_of_date",
        value: "2026-08-30",
        contractVersion: "yuanta-trade/investment/canonical-v1",
      },
      lineage: { page: 0, row: 1, contractVersion: "yuanta-trade/investment/canonical-v1" },
    });
    await commitCanonicalInvestmentCapture(store, admitCanonicalInvestmentCapture(capture));
    store.close();
    const current = await createCanonicalOverviewQuery(directory).current();
    const account = current.projection.accounts[0];
    assert.equal(account?.availability, "awaiting");
    assert.deepEqual(account?.amounts, []);
    assert.deepEqual(account?.positions, []);
    assert.equal(current.projection.sourceGaps.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function investmentFixture(): InvestmentCaptureInput {
  const route = "yuanta-trade/investment/canonical-v1";
  return {
    captureId: token("overview-capture"),
    sourceId: "yuanta-trade",
    authorityRoute: route,
    contractVersion: route,
    observedAt: "2026-08-31T12:00:00.000Z",
    identity: {
      sourceConnectionKey: token("overview-connection"),
      identityEpochKey: token("overview-epoch"),
      accountKey: token("overview-account"),
      accountType: "investment",
      accountSubtype: "crypto_exchange",
      reportingCurrency: "TWD",
    },
    scope: { effectiveOn: "2026-08-30", complete: true },
    securities: [{
      securityKey: "yuanta-trade:BTC",
      producerSecurityId: "BTC",
      name: "Bitcoin",
      ticker: "BTC",
      currency: "USD",
      securityType: "cryptocurrency",
      identityEvidence: { kind: "producer-security-id", contractVersion: route },
    }],
    holdings: [{
      measurementKey: token("overview-measurement"),
      measurementSubjectKey: token("overview-subject"),
      sourceRecordKey: token("overview-holding-record"),
      securityKey: "yuanta-trade:BTC",
      quantity: { coefficient: "1234", scale: 3 },
      valuation: { coefficient: "123456", scale: 2, currency: "USD" },
      effectiveOn: "2026-08-30",
      observedAt: "2026-08-31T12:00:00.000Z",
      effectiveTimeEvidence: {
        kind: "source-reported-as-of",
        sourceRecordKey: token("overview-holding-record"),
        sourceField: "as_of_date",
        value: "2026-08-30",
        contractVersion: route,
      },
      lineage: { page: 0, row: 0, contractVersion: route },
    }],
    transactions: [],
    margin: {
      kind: "embedded",
      amount: { coefficient: "777", scale: 0, currency: "USD" },
      effectiveOn: "2026-08-30",
      sourceRecordKey: token("overview-margin-record"),
    },
  };
}
