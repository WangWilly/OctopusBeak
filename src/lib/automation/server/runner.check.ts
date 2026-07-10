import assert from "node:assert/strict";
import {
  accumulateAutomationOutput,
  automationProcessEnv,
  finalFailureMessage,
  isForceQuitRun,
  librettoRunCdpPatchCommand,
  liveTaskRunUpdate,
  nextAttemptStatus,
  parseAutomationProgress,
  resumeFailureMessage,
  resumeSessionFromLog,
  shouldAutoRunImport,
  shouldCloseResumeSession,
  shouldMarkWaitingForHuman,
} from "./runner.ts";

assert.equal(automationProcessEnv({ NODE_ENV: "production" }).NODE_ENV, "development");
assert.equal(automationProcessEnv({ NODE_ENV: "test" }).NODE_ENV, "test");

assert.equal(shouldMarkWaitingForHuman("libretto paused. resume --session abc"), true);
assert.equal(shouldMarkWaitingForHuman("Please enter OTP in browser"), true);
assert.equal(
  shouldMarkWaitingForHuman("manual-auth-required: enter the iPost CAPTCHA in the browser, then run `npx libretto resume --session ses-post`."),
  true,
);
assert.equal(
  shouldMarkWaitingForHuman(
    "hncb-login-account-refilled-after-captcha\nautomation-progress: 100\nIntegration completed.",
  ),
  false,
);
assert.equal(shouldMarkWaitingForHuman("download completed"), false);
assert.deepEqual(librettoRunCdpPatchCommand({ resumeSession: undefined }), [
  "node",
  "scripts/patch-libretto-run-cdp.mjs",
]);
const originalDesktop = process.env.OCTOPUSBEAK_DESKTOP;
const originalAppRoot = process.env.OCTOPUSBEAK_APP_ROOT;
const originalNodePath = process.env.OCTOPUSBEAK_NODE_PATH;
process.env.OCTOPUSBEAK_DESKTOP = "1";
process.env.OCTOPUSBEAK_APP_ROOT = "/AppRoot";
process.env.OCTOPUSBEAK_NODE_PATH = "/AppRoot/OctopusBeak";
assert.deepEqual(librettoRunCdpPatchCommand({ resumeSession: undefined }), [
  "/AppRoot/OctopusBeak",
  "/AppRoot/scripts/patch-libretto-run-cdp.mjs",
]);
if (originalDesktop === undefined) delete process.env.OCTOPUSBEAK_DESKTOP;
else process.env.OCTOPUSBEAK_DESKTOP = originalDesktop;
if (originalAppRoot === undefined) delete process.env.OCTOPUSBEAK_APP_ROOT;
else process.env.OCTOPUSBEAK_APP_ROOT = originalAppRoot;
if (originalNodePath === undefined) delete process.env.OCTOPUSBEAK_NODE_PATH;
else process.env.OCTOPUSBEAK_NODE_PATH = originalNodePath;
assert.equal(librettoRunCdpPatchCommand({ resumeSession: "ses-1p4q" }), null);
assert.equal(
  resumeSessionFromLog(
    "Workflow paused. run `npx libretto resume --session ses-1p4q`.",
  ),
  "ses-1p4q",
);
assert.equal(
  resumeSessionFromLog(
    "manual-auth-required: enter the iPost CAPTCHA in the browser, then run `npx libretto resume --session ses-post`.",
  ),
  "ses-post",
);
assert.equal(resumeSessionFromLog("download completed"), null);
assert.equal(parseAutomationProgress("automation-progress: 35"), 35);
assert.equal(parseAutomationProgress("automation-progress: 20\nautomation-progress: 67"), 67);
assert.equal(parseAutomationProgress("automation-progress: 105"), 100);
assert.equal(parseAutomationProgress("download completed"), null);
assert.deepEqual(liveTaskRunUpdate("download in progress"), {
  logTail: "download in progress",
});
assert.deepEqual(liveTaskRunUpdate("Workflow paused. resume --session ses-1p4q"), {
  status: "waiting_for_human",
  logTail: "Workflow paused. resume --session ses-1p4q",
});
const failedResumeLog =
  'Workflow failed after resume: Could not find selector "input[name=\\"qry_option\\"]".';
const failedResumeMessage = 'Could not find selector "input[name=\\"qry_option\\"]".';
assert.equal(
  resumeFailureMessage(failedResumeLog),
  failedResumeMessage,
);
assert.deepEqual(
  liveTaskRunUpdate(failedResumeLog),
  {
    status: "failed",
    errorMessage: failedResumeMessage,
    logTail: failedResumeLog,
  },
);
const longResumeFailureLog = [
  "Workflow failed after resume: locator.click: Timeout 30000ms exceeded.",
  ...Array.from(
    { length: 220 },
    () => "\u001b[2m    - waiting 500ms\u001b[22m",
  ),
].join("\n");
const accumulatedFailure = accumulateAutomationOutput(
  { logTail: "", resumeFailure: null },
  longResumeFailureLog,
);
assert.equal(
  accumulatedFailure.resumeFailure,
  "locator.click: Timeout 30000ms exceeded.",
);
assert.ok(accumulatedFailure.logTail.length <= 4_000);
assert.doesNotMatch(accumulatedFailure.logChunk, /\u001b/);
assert.doesNotMatch(accumulatedFailure.logTail, /\u001b/);
assert.equal(
  accumulateAutomationOutput(
    accumulatedFailure,
    "\u001b[2m    - retrying click action\u001b[22m",
  ).resumeFailure,
  "locator.click: Timeout 30000ms exceeded.",
);
assert.equal(
  finalFailureMessage(
    [
      "libretto run CDP patch already applied.",
      "Running workflow \"fubonAllStatements\" from /path/fubon-all-statements.ts (headless)...",
      "automation-progress: 0",
      "Fubon credentials look like placeholder values. Update the Fubon credentials in Settings before running Fubon statements.",
      "Browser is still open. You can use `exec` to inspect it. Call `run` to re-run the workflow.",
      "",
    ].join("\n"),
    1,
  ),
  "Fubon credentials look like placeholder values. Update the Fubon credentials in Settings before running Fubon statements.",
);
assert.equal(finalFailureMessage("", 1), "Task exited with code 1");
assert.equal(isForceQuitRun({ status: "failed", errorMessage: "Browser session force quit." }), true);
assert.equal(isForceQuitRun({ status: "failed", errorMessage: "Task exited with code 1" }), false);
assert.equal(isForceQuitRun({ status: "waiting_for_human", errorMessage: null }), false);

assert.equal(
  nextAttemptStatus({
    kind: "crawler",
    attempt: 1,
    maxAttempts: 2,
    exitCode: 0,
    waitingForHuman: true,
  }),
  "waiting_for_human",
);
assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 1, maxAttempts: 2, exitCode: 1 }),
  "failed",
);
assert.equal(
  nextAttemptStatus({
    kind: "crawler",
    attempt: 1,
    maxAttempts: 1,
    exitCode: 1,
    waitingForHuman: true,
  }),
  "failed",
);
assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 2, maxAttempts: 2, exitCode: 1 }),
  "failed",
);
assert.equal(
  nextAttemptStatus({ kind: "sync", attempt: 1, maxAttempts: 1, exitCode: 1 }),
  "failed",
);
assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 1, maxAttempts: 2, exitCode: 0 }),
  "completed",
);

assert.equal(
  shouldAutoRunImport({ kind: "crawler", status: "completed", importLocked: false }),
  true,
);
assert.equal(
  shouldAutoRunImport({ kind: "crawler", status: "failed", importLocked: false }),
  false,
);
assert.equal(
  shouldAutoRunImport({ kind: "sync", status: "completed", importLocked: false }),
  false,
);
assert.equal(
  shouldAutoRunImport({ kind: "crawler", status: "completed", importLocked: true }),
  false,
);
assert.equal(shouldCloseResumeSession({ status: "failed", resumeSession: "ses-1p4q" }), true);
assert.equal(
  shouldCloseResumeSession({ status: "waiting_for_human", resumeSession: "ses-1p4q" }),
  false,
);
assert.equal(shouldCloseResumeSession({ status: "failed" }), false);
