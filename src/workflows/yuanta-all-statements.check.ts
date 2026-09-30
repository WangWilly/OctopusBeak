import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const source = await readFile(
  new URL("./yuanta-all-statements.ts", import.meta.url),
  "utf8",
);

assert.doesNotMatch(
  source,
  /from\s+["']libretto["']|ExportedLibrettoWorkflow|LibrettoWorkflowContext|export\s+default\s+workflow\s*\(|yuanta(?:Statements|ForeignCurrencyStatements|LoanStatements|CreditCardStatements|FundStatements)\.run\(/u,
  "Yuanta all-statements must expose only its typed App parent, not a legacy Libretto parent",
);
assert.doesNotMatch(
  source,
  /emitAutomationProgress|node:fs\/promises|writeFile\(|pglite-child-rpc/u,
  "the typed Yuanta parent must not own logs, output files, or a direct persistence path",
);
assert.match(source, /export async function runYuantaAllStatementsWorkflow\(/u);
assert.match(
  source,
  /collectDeposit[\s\S]*collectForeignCurrency[\s\S]*collectCreditCard[\s\S]*collectLoan[\s\S]*collectFund/u,
  "the typed parent must keep all five product collectors",
);

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-yuanta-all-statements-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const loaded = await server
  .ssrLoadModule("/src/workflows/yuanta-all-statements.ts")
  .finally(() => server.close());
assert.equal(loaded.default, undefined, "the parent must not export a Libretto workflow");
assert.equal(typeof loaded.runYuantaAllStatementsWorkflow, "function");
