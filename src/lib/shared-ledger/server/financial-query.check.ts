import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFinancialQuery,
  type FinancialQueryBoundary,
} from "./financial-query.ts";

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
const historical = await boundary.historical({
  kind: "historical",
  product: "overview",
  financialCutoff: "2026-01-01",
});
assert.deepEqual(historical, {
  status: "unsupported",
  kind: "historical",
  reason: "legacy-adapter-does-not-support-historical-queries",
});
const lineage = await boundary.lineage({
  kind: "lineage",
  product: "overview",
  subject: { type: "account", id: "example" },
});
assert.deepEqual(lineage, {
  status: "unsupported",
  kind: "lineage",
  reason: "legacy-adapter-does-not-support-lineage-queries",
});
