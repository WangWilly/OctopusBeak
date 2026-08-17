import assert from "node:assert/strict";
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
for (const [reader, forbidden] of [
  ["readCurrentAssets", /exchange_rates|loadSpendingQueryData/],
  ["readCurrentLiabilities", /exchange_rates|loadSpendingQueryData/],
  ["readCurrentOverview", /fundBuyTransactions|fundRedemptionTransactions|brokerageTradeTransactions|loadSpendingQueryData/],
] as const) {
  const start = boundarySource.indexOf(`private async ${reader}`);
  const end = boundarySource.indexOf("\n  private ", start + 1);
  assert.ok(start >= 0, `${reader} must be a private product reader`);
  assert.doesNotMatch(boundarySource.slice(start, end < 0 ? undefined : end), forbidden);
}

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
  reason: "legacy-adapter-does-not-support-historical-queries",
});
const lineageContract: LineageFinancialQueryResult<never> = await boundary.lineage({
  kind: "lineage",
  product: "overview",
  subject: { kind: "account", id: "example" },
});
assert.deepEqual(lineageContract, {
  status: "unsupported",
  kind: "lineage",
  reason: "legacy-adapter-does-not-support-lineage-queries",
});

const latestExchangeRates = await boundary.current({
  kind: "current",
  product: "overview",
  selection: "latest",
  currencies: ["USD"],
});
assert.equal(latestExchangeRates.product, "overview");
assert.equal(latestExchangeRates.selection, "latest");

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

const ledgerDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "financial-query-boundary-"));
try {
  seedMockLedger(ledgerDir, new Date("2026-07-11T04:00:00.000Z"));
  const productQuery = createFinancialQuery(ledgerDir);
  const assets = await productQuery.current({ kind: "current", product: "assets" });
  assert.deepEqual(assets.ledger.creditCardStatementLines, []);
  assert.deepEqual(assets.ledger.creditCardSnapshots, []);
  assert.deepEqual(assets.ledger.loanTransactions, []);
  const overview = await productQuery.current({ kind: "current", product: "overview" });
  assert.deepEqual(overview.ledger.fundBuyTransactions, []);
  assert.deepEqual(overview.ledger.brokerageTradeTransactions, []);
  const liabilities = await productQuery.current({ kind: "current", product: "liabilities" });
  assert.deepEqual(liabilities.ledger.maicoinStatementRows, []);
  const spending = productQuery.current({ kind: "current", product: "spending" });
  assert.equal(spending.product, "spending");
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
