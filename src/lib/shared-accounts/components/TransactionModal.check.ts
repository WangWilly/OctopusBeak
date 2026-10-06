import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./TransactionModal.svelte", import.meta.url), "utf8");

test("rows show and filter on the day the table displays", () => {
  assert.match(source, /transactionDay\(row, \$systemTimezone\)/);
  assert.match(source, /filterTransactions\(rows, \{ range, flow: "all", timeZone: \$systemTimezone \}\)/);
});

test("money columns keep canonical exact values and drop the sign the column already states", () => {
  assert.match(source, /row\.amountExact\.coefficient\.replace\(\/\^-\/, ""\)/);
  assert.match(source, /\{row\.amount < 0 \? columnAmount\(row\) : ""\}/);
  assert.match(source, /\{row\.amount > 0 \? columnAmount\(row\) : ""\}/);
});

test("Escape closes an open filter menu before the modal", () => {
  assert.match(source, /if \(menu\) menu = null;\s*else close\(\);/);
});
