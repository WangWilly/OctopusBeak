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
  cathayWorkflowSource.indexOf("export async function completeEmailOtpIfNeeded"),
  cathayWorkflowSource.indexOf("async function waitForSignedInState"),
);
assert.match(cathayWorkflowSource, /ensureCathayGmailOtpAccess/);
assert.match(cathayWorkflowSource, /prepareCathayGmailOtpRetrieval/);
assert.match(cathayWorkflowSource, /retrieveCathayGmailOtp/);
assert.match(cathayOtpSource, /const ensureAccess = automation\.ensureAccess/);
assert.match(cathayOtpSource, /const retrieve = automation\.retrieve/);
assert.match(
  cathayOtpSource,
  /const boundary = await prepareRetrieval\(\);/,
);
assert.match(cathayOtpSource, /await clickSendOnce\(\);\s*const result = await retrieve\(boundaryId\);/);
assert.match(cathayOtpSource, /await otpField\.fill\(otp\);/);
assert.match(cathayOtpSource, /await page\.locator\("#btnConfirm"\)\.click\(\);/);
assert.match(cathayOtpSource, /pauseForManualCathayEmailOtp\(/);
assert.equal(
  cathayOtpSource.match(/await retrieve\(/g)?.length,
  1,
);
assert.doesNotMatch(cathayOtpSource, /waitForTimeout\(5_000\)/);
assert.doesNotMatch(cathayOtpSource, /setTimeout\([^\n]*120_000/);
assert.match(
  cathayOtpSource,
  /reportCathayGmailOtpFallback\("access", access\)/,
);
assert.match(
  cathayOtpSource,
  /reportCathayGmailOtpFallback\("retrieval", result\)/,
);
assert.match(
  cathayOtpSource,
  /reportCathayGmailOtpFallback\("workflow", null\)/,
);
assert.doesNotMatch(cathayOtpSource, /cathay-gmail-otp-fallback[^\n]*(?:error|otp|token|email)/i);

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
