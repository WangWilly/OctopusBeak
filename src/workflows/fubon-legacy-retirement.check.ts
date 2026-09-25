import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fileNames = [
  "fubon-all-statements.ts",
  "fubon-statements.ts",
  "fubon-credit-card-statements.ts",
  "fubon-loan-statements.ts",
  "fubon-deposit-telemetry.ts",
  "fubon-auth.ts",
] as const;

for (const fileName of fileNames) {
  const source = await readFile(new URL(`./${fileName}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["']libretto["']/u, `${fileName} must not depend on Libretto`);
  assert.doesNotMatch(source, /LibrettoWorkflowContext/u, `${fileName} must not expose Libretto context`);
  assert.doesNotMatch(source, /export default workflow\(/u, `${fileName} must not register a Libretto production workflow`);
  assert.doesNotMatch(source, /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun/u, `${fileName} must not open a direct PGlite RPC`);
  assert.doesNotMatch(source, /from ["']node:fs\/promises["']|downloads[\\/]fubon|writeFile\(/u, `${fileName} must not write source or generated files`);
}

const auth = await readFile(new URL("./fubon-auth.ts", import.meta.url), "utf8");
assert.doesNotMatch(auth, /npx libretto|\bpause\(/u, "Fubon assistance must use the App-owned assistance port");

const allStatements = await readFile(new URL("./fubon-all-statements.ts", import.meta.url), "utf8");
assert.match(allStatements, /export async function runFubonAllStatementsWorkflow\(/u);
assert.doesNotMatch(allStatements, /export async function runFubonAllStatements\(/u);
