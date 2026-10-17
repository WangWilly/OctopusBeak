import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { navigateToCathayLoginForm } from "./cathay-login.ts";

const cathayWorkflowSource = readFileSync(
  new URL("./cathay-statements.ts", import.meta.url),
  "utf8",
);
assert.match(cathayWorkflowSource, /export async function signInCathayForApp/);
assert.doesNotMatch(cathayWorkflowSource, /requestHumanAssistance|verificationActor|human-submitted|cathay-login-email-otp/);
assert.doesNotMatch(
  cathayWorkflowSource,
  /from "libretto"|from "node:fs|writeFile\(|requirePGliteChildRpcClient|executePGliteWorkflowRun|export default workflow|downloadCathayStatements/,
);

const calls: unknown[][] = [];
await navigateToCathayLoginForm({
  goto: async (...args: unknown[]) => {
    calls.push(["goto", ...args]);
  },
  locator: (...args: unknown[]) => {
    calls.push(["locator", ...args]);
    return {
      waitFor: async (...waitForArgs: unknown[]) => {
        calls.push(["waitFor", ...waitForArgs]);
      },
    };
  },
} as never);

assert.deepEqual(calls, [
  ["goto", "https://www.cathaybk.com.tw/MyBank/", { waitUntil: "commit" }],
  ["locator", "#CustID"],
  ["waitFor", { state: "visible", timeout: 60_000 }],
]);
