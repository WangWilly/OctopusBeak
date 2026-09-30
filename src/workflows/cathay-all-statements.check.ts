import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [allSource, domesticSource, foreignSource] = await Promise.all([
  readFile(new URL("./cathay-all-statements.ts", import.meta.url), "utf8"),
  readFile(new URL("./cathay-statements.ts", import.meta.url), "utf8"),
  readFile(new URL("./cathay-foreign-statements.ts", import.meta.url), "utf8"),
]);

assert.match(allSource, /export async function runCathayAllProviderWorkflow/);
assert.match(allSource, /dependencies\.otp/);
assert.match(allSource, /context\.financialCommit!?\.execute\(/);
assert.match(allSource, /collectCathayDomesticFinancialRequests/);
assert.match(allSource, /collectCathayForeignFinancialCaptures/);
assert.doesNotMatch(
  allSource,
  /from "libretto"|from "node:fs|writeFile\(|console\.|createCathayAllStatementsWorkflow|runCathayAllStatements|downloadCathay|requirePGliteChildRpcClient|executePGliteWorkflowRun/,
);

assert.match(domesticSource, /export type CathayGmailOtpPort/);
assert.match(domesticSource, /export async function signInCathayForApp/);
assert.match(domesticSource, /export async function collectCathayDomesticFinancialRequests/);
assert.match(domesticSource, /decodeCathayApiSourceResponse/);
assert.doesNotMatch(
  domesticSource,
  /from "libretto"|from "node:fs|writeFile\(|console\.|from "\.\/gmail-otp\.ts"|requirePGliteChildRpcClient|executePGliteWorkflowRun|export default workflow|downloadCathayStatements/,
);

assert.match(foreignSource, /export async function collectCathayForeignFinancialCaptures/);
assert.match(foreignSource, /fetchCathayApiSourceText/);
assert.doesNotMatch(
  foreignSource,
  /from "libretto"|from "node:fs|writeFile\(|console\.|requirePGliteChildRpcClient|executePGliteWorkflowRun|commitCathayForeignAndCurrentCanonicalCaptures|downloadCathayForeignStatements|export default workflow/,
);
