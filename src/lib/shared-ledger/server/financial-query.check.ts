import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
import { canonicalDatabaseWriterKey, openCanonicalDatabaseHandle } from "../../../ledger/canonical/canonical-database.ts";

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
  openCanonicalDatabaseHandle(ledgerDir).close();
  const productQuery = createFinancialQuery(ledgerDir);
  const assets = await productQuery.current({ kind: "current", product: "assets" });
  assert.equal(assets.product, "assets");
  assert.equal(assets.projection.availability, "empty");
  assert.deepEqual(assets.projection.accounts, []);
  assert.deepEqual(assets.projection.transactions, []);
  const overview = await productQuery.current({ kind: "current", product: "overview" });
  assert.equal(overview.projection.availability, "empty");
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
  const competingWriter = new DatabaseSync(canonicalDatabaseWriterKey(ledgerDir));
  competingWriter.exec("BEGIN IMMEDIATE");
  try {
    // Dashboard reads must not request a second writer transaction on open.
    assert.equal(productQuery.current({ kind: "current", product: "spending" }).product, "spending");
  } finally {
    competingWriter.exec("ROLLBACK");
    competingWriter.close();
  }
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
