import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { isFubonStatementSummaryRow } = await import(
  "./fubon-credit-card-statements.ts"
);

const summaryRows = [
  ["115/06/21", "網路繳款"],
  ["115/06/21", "行動銀行繳款"],
  ["", "前期應繳總額"],
];
const transactionRow = ["115/06/21", "咖啡店"];

for (const row of summaryRows) {
  assert.equal(isFubonStatementSummaryRow(row), true);
}
assert.equal(isFubonStatementSummaryRow(transactionRow), false);
assert.deepEqual(
  [...summaryRows, transactionRow].filter(
    (row) => !isFubonStatementSummaryRow(row),
  ),
  [transactionRow],
);
