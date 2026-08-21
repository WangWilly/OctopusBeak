import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    if (specifier === "./fubon-auth.js") {
      return nextResolve("./fubon-auth.ts", context);
    }
    if (specifier === "./run-selected-statements.js") {
      return nextResolve("./run-selected-statements.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { isFubonStatementSummaryRow } =
  await import("./fubon-credit-card-statements.ts");

const source = await readFile(
  new URL("./fubon-credit-card-statements.ts", import.meta.url),
  "utf8",
);
const loginEntry = source.slice(
  source.indexOf("async function openCreditCardLoginForm"),
  source.indexOf("async function openStatementDetailsPage"),
);
assert.match(loginEntry, /openFubonLoginForm\(page\)/);
assert.match(source, /findStatementDetailsScope/);
assert.match(source, /StatementComponentAbsentError/);
assert.match(source, /hasFubonCreditCardNoRecord\(scope\)/);
assert.doesNotMatch(
  loginEntry,
  /#menu_CCC|menu_CCC02|task_CCCQU002|landingFrame\.goto|txnFrame\.goto/,
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
