import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFinancialQuery,
  type HistoricalFinancialProjection,
  type HistoricalFinancialQueryResult,
  type LineageFinancialProjection,
  type LineageFinancialQueryResult,
  type FinancialQueryBoundary,
} from "./financial-query.ts";
import { seedMockLedger } from "../../../ledger/seed-mock-ledger-db.ts";

const here = dirname(fileURLToPath(import.meta.url));
const loaders = [
  ["assets", join(here, "../../assets/server/load-assets.ts")],
  ["overview", join(here, "../../overview/server/load-overview.ts")],
  ["spending", join(here, "../../spending/server/store.ts")],
  ["liabilities", join(here, "../../liabilities/server/load-liabilities.ts")],
] as const;

for (const [product, path] of loaders) {
  const source = readFileSync(path, "utf8");
  assert.match(source, /financial-query\.ts/);
  const loaderSource = product === "spending"
    ? source.slice(source.indexOf("export function loadSpending"), source.indexOf("export function updateSpending"))
    : source;
  assert.doesNotMatch(loaderSource, /openLedger(?:Database|Drizzle)/);
  assert.doesNotMatch(loaderSource, /\.prepare\(/);
  assert.doesNotMatch(loaderSource, /ledger\/db\/schema\.ts/);
  assert.match(source, new RegExp(`product: ["']${product}["']`));
}

const boundary: FinancialQueryBoundary = createFinancialQuery();
assert.equal(typeof boundary.current, "function");
assert.equal(typeof boundary.historical, "function");
assert.equal(typeof boundary.lineage, "function");
assert.equal("overviewExchangeRates" in boundary, false);
const boundarySource = readFileSync(join(here, "financial-query.ts"), "utf8");
assert.doesNotMatch(boundarySource, /projection:\s*unknown/);
assert.doesNotMatch(boundarySource, /lineage:\s*unknown/);
assert.doesNotMatch(boundarySource, /LegacyFinancialQueryAdapter|openLedger(?:Database|Drizzle)/);
assert.doesNotMatch(boundarySource, /ledger\/db\/schema|data-issues\/server/);
assert.match(boundarySource, /request\.product === "assets" \|\| request\.product === "liabilities"/);
assert.match(boundarySource, /createCanonicalOverviewQuery\(this\.ledgerDir/);
assert.doesNotMatch(boundarySource, /publish\(\{[^}]*ledgerDir/);

type Assert<T extends true> = T;
type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type _HistoricalProjectionHasNoLegacyPayload = Assert<Equal<HistoricalFinancialProjection<never>["projection"], never>>;
type _LineageProjectionHasNoLegacyPayload = Assert<Equal<LineageFinancialProjection<never>["lineage"][number], never>>;
const historicalContract: HistoricalFinancialQueryResult<never> = await boundary.historical({
  kind: "historical",
  product: "overview",
  cutoff: { kind: "both", financialAt: "2026-01-01", knowledgeAt: "2026-01-02" },
});
assert.deepEqual(historicalContract, {
  status: "unsupported",
  kind: "historical",
  reason: "canonical-historical-query-not-available",
});
const lineageContract: LineageFinancialQueryResult<never> = await boundary.lineage({
  kind: "lineage",
  product: "overview",
  subject: { kind: "account", id: "example" },
});
assert.deepEqual(lineageContract, {
  status: "unsupported",
  kind: "lineage",
  reason: "canonical-lineage-query-not-available",
});

const latestExchangeRates = await boundary.current({
  kind: "current",
  product: "overview",
  selection: "latest",
  currencies: ["USD"],
});
assert.equal(latestExchangeRates.product, "overview");
assert.equal(latestExchangeRates.selection, "latest");
assert.deepEqual(latestExchangeRates.exchangeRates, []);

const historicalExchangeRates = await boundary.current({
  kind: "current",
  product: "overview",
  selection: "history",
  currencies: ["USD"],
  firstDate: "2026-01-01",
  lastDate: "2026-01-31",
});
assert.equal(historicalExchangeRates.product, "overview");
assert.equal(historicalExchangeRates.selection, "history");
assert.deepEqual(historicalExchangeRates.exchangeRates, []);

const ledgerDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "financial-query-boundary-"));
try {
  seedMockLedger(ledgerDir, new Date("2026-07-11T04:00:00.000Z"));
  const productQuery = createFinancialQuery(ledgerDir);
  const diagnosticChannels = [
    channel("octopus-beak.shared-ledger.financial-query"),
    channel("octopus-beak.shared-ledger.spending-query"),
    channel("octopus-beak.spending.canonical-store-open"),
  ];
  const diagnostics: unknown[] = [];
  const observer = (message: unknown) => diagnostics.push(message);
  for (const diagnosticChannel of diagnosticChannels) diagnosticChannel.subscribe(observer);
  try {
    await productQuery.current({ kind: "current", product: "overview" });
    productQuery.current({ kind: "current", product: "spending" });
  } finally {
    for (const diagnosticChannel of diagnosticChannels) diagnosticChannel.unsubscribe(observer);
  }
  assert.ok(diagnostics.length > 0);
  for (const diagnostic of diagnostics) {
    assert.ok(diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic));
    const payload = diagnostic as Record<string, unknown>;
    assert.equal("ledgerDir" in payload, false);
    assert.equal("path" in payload, false);
    assert.equal("sql" in payload, false);
    assert.equal("payload" in payload, false);
    assert.equal("identity" in payload, false);
  }
  const assets = await productQuery.current({ kind: "current", product: "assets" });
  assert.equal(assets.product, "assets");
  assert.equal(assets.projection.availability, "empty");
  assert.deepEqual(assets.projection.accounts, []);
  assert.deepEqual(assets.projection.transactions, []);
  const overview = await productQuery.current({ kind: "current", product: "overview" });
  assert.equal(overview.projection.availability, "awaiting");
  assert.deepEqual(overview.projection.accounts, []);
  const liabilities = await productQuery.current({ kind: "current", product: "liabilities" });
  assert.equal(liabilities.product, "liabilities");
  assert.equal(liabilities.projection.availability, "empty");
  assert.deepEqual(liabilities.projection.accounts, []);
  const spending = productQuery.current({ kind: "current", product: "spending" });
  assert.equal(spending.product, "spending");
  assert.deepEqual(spending.invoices, []);
  assert.deepEqual(spending.purchaseReport.records, []);
  assert.equal(spending.purchaseReport.totalStatus, "complete");
  assert.equal(spending.purchaseReport.knowledgeAt, 0);
  assert.throws(
    () => productQuery.current({
      kind: "current",
      product: "spending",
      cutoff: { knowledgePoint: 1 },
    }),
    { message: "canonical-cutoff-unavailable" },
  );
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
