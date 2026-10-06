import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { navigateToCathayLoginForm } from "./cathay-login.ts";
import { cathayEmailOtpSubmissionValue } from "./cathay-statements.ts";

assert.equal(
  cathayEmailOtpSubmissionValue({ kind: "found", otp: "IBIL-123456" }),
  "123456",
);
assert.equal(
  cathayEmailOtpSubmissionValue({ kind: "found", otp: "IBIL-12345" }),
  null,
);
assert.equal(
  cathayEmailOtpSubmissionValue({ kind: "timeout", otp: "IBIL-123456" }),
  null,
);

const cathayWorkflowSource = readFileSync(
  new URL("./cathay-statements.ts", import.meta.url),
  "utf8",
);
const cathayOtpSource = cathayWorkflowSource.slice(
  cathayWorkflowSource.indexOf("export async function completeCathayEmailOtpForApp"),
  cathayWorkflowSource.indexOf("async function openDomesticStatementsPage"),
);
assert.match(cathayWorkflowSource, /export type CathayGmailOtpPort/);
assert.match(cathayWorkflowSource, /export async function signInCathayForApp/);
assert.match(cathayOtpSource, /dependencies\.otp\.ensureAccess\(\)/);
assert.match(cathayOtpSource, /dependencies\.otp\.prepareRetrieval\(\)/);
assert.equal(cathayOtpSource.match(/dependencies\.otp\.retrieve\(/g)?.length, 1);
assert.doesNotMatch(cathayWorkflowSource, /requestHumanAssistance|verificationActor|human-submitted|cathay-login-email-otp/);
assert.doesNotMatch(cathayOtpSource, /authentication-otp-auto-retrieval-fallback/);
assert.doesNotMatch(
  cathayWorkflowSource,
  /from "libretto"|from "node:fs|writeFile\(|from "\.\/gmail-otp\.ts"|ensureCathayGmailOtpAccess|prepareCathayGmailOtpRetrieval|retrieveCathayGmailOtp|requirePGliteChildRpcClient|executePGliteWorkflowRun|export default workflow|downloadCathayStatements/,
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
