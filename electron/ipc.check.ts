import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
assert.match(source, /"automation:forceTerminate": [\s\S]*?automationRuntime\.forceTerminate\(taskId, expectedRunId\)/);
assert.match(source, /"automation:cancel": [\s\S]*?automationRuntime\.cancel\(taskId, expectedRunId\)/);
assert.doesNotMatch(source, /"automation:forceQuit"/);
assert.doesNotMatch(source, /forceQuitHumanSessionForTask/);
assert.doesNotMatch(source, /terminateAutomationTaskProcesses/);
assert.doesNotMatch(source, /"automation:resume"/);
for (const channel of [
  "automation:resumeHumanAssistance",
  "automation:viewerScreenshot",
  "automation:viewerInspect",
  "automation:viewerInput",
  "automation:viewerCompletionCheck",
]) {
  assert.doesNotMatch(source, new RegExp(`"${channel}"`));
}
assert.doesNotMatch(source, /assertManualVerificationAllowedForTask|human-session/);
assert.match(source, /data:invalidated/);
assert.match(
  source,
  /PGliteFinancialPort/,
  "financial page requests use the worker-owned PGlite port",
);
assert.match(source, /registerPGliteViewIpc/);
assert.doesNotMatch(source, /financial-page-worker|createFinancialPageWorkerClient/);
assert.match(source, /pgliteOperational: \{/);
assert.match(source, /pgliteFinancial: PGliteFinancialPort/);
assert.match(source, /withExpectedDataVersion/);
assert.match(source, /options\?\.expectedVersion/);
assert.doesNotMatch(source, /"automation:load"/);
assert.match(source, /void automationCredentials\.prewarm\(\)\.catch/);
assert.doesNotMatch(
  source,
  /ipcMain\.on\([\s\S]{0,240}automationCredentials\.prewarm\(\)/,
  "credential prewarm must not be launched from a click/input handler",
);
assert.match(source, /await pgliteViewRegistration\.close\(\)/);
assert.doesNotMatch(source, /spending:updateItemCategory|spending:updateTransactionOverride/);
assert.match(source, /ONE_TIME_CODE\.test\(code\)/, "the renderer cannot pass anything but a digit code to a source");
assert.match(source, /deviceRegistrationSource\(value\)/, "the renderer cannot name a source without device registration");
assert.match(source, /await onSystemSettingsChanged\?\.\(value\)/);
assert.doesNotMatch(source, /refreshCathayEmailOtpTarget|refreshSinopacCaptchaTarget|refreshYuantaTradeChallengeSubmitTarget/);
assert.doesNotMatch(source, /shouldCheckYuantaTradeCompletion|shouldAutoResumeYuantaTradeCaptcha/);

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
assert.match(mainSource, /createExchangeRateScheduler/);
assert.match(
  mainSource,
  /onSystemSettingsChanged:\s*\(\)\s*=>\s*\{\s*scheduler\?\.reschedule\(\);\s*collectionScheduler\?\.reschedule\(\);\s*\}/,
);
assert.match(mainSource, /scheduled-collection-scheduler-error/);
assert.match(mainSource, /scheduler\?\.start\(\)/);
assert.match(mainSource, /scheduler\?\.stop\(\)/);
assert.match(mainSource, /ipcRegistration = registerOctopusBeakIpc/);
assert.match(mainSource, /ipcRegistration\?\.close\(\)/);
assert.match(mainSource, /exchange-rate-scheduler-error/);
