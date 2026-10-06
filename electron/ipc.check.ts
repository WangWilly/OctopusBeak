import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { octopusBeakApiChannels } from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("settings:load"), true);
assert.equal(octopusBeakApiChannels.includes("settings:save"), true);
assert.equal(octopusBeakApiChannels.includes("spending:confirmCandidate"), true);
assert.equal(octopusBeakApiChannels.includes("spending:pairing-candidates"), true);
assert.equal(octopusBeakApiChannels.includes("spending:pairing-prewarm"), true);
assert.equal(octopusBeakApiChannels.includes("spending:denyCandidate"), true);
assert.equal(octopusBeakApiChannels.includes("spending:revokeLink"), true);
assert.equal(octopusBeakApiChannels.includes("data:getVersion"), true);
assert.equal(octopusBeakApiChannels.includes("data:acknowledgeVersion"), true);
assert.equal(octopusBeakApiChannels.includes("data:invalidated"), true);
assert.equal(octopusBeakApiChannels.includes("automation:forceTerminate"), true);
assert.equal((octopusBeakApiChannels as readonly string[]).includes("automation:forceQuit"), false);
assert.equal((octopusBeakApiChannels as readonly string[]).includes("automation:resume"), false);
for (const channel of ["data-views:subscribe", "data-views:enabled", "data-views:unsubscribe", "data-views:rows", "data-views:error"] as const)
  assert.equal(octopusBeakApiChannels.includes(channel), true);

const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
assert.match(source, /ipcMain\.handle\("settings:load"/);
assert.match(source, /ipcMain\.handle\("settings:save"/);
assert.match(source, /ipcMain\.handle\("spending:confirmCandidate"/);
assert.match(source, /ipcMain\.handle\("spending:pairing-candidates"/);
assert.match(source, /ipcMain\.handle\("spending:pairing-prewarm"/);
assert.match(source, /ipcMain\.handle\("spending:denyCandidate"/);
assert.match(source, /ipcMain\.handle\("spending:revokeLink"/);
assert.match(source, /ipcMain\.handle\("data:getVersion"/);
assert.match(source, /ipcMain\.handle\("data:acknowledgeVersion"/);
assert.match(source, /ipcMain\.handle\("automation:forceTerminate",[\s\S]*?automationForceTerminate\(taskId, operationalProvider, expectedRunId\)/);
assert.match(source, /ipcMain\.handle\("automation:cancel",[\s\S]*?automationCancel\(taskId, operationalProvider, expectedRunId\)/);
assert.doesNotMatch(source, /ipcMain\.handle\("automation:forceQuit"/);
assert.doesNotMatch(source, /forceQuitHumanSessionForTask/);
assert.doesNotMatch(source, /terminateAutomationTaskProcesses/);
assert.doesNotMatch(source, /ipcMain\.handle\("automation:resume"/);
for (const channel of [
  "automation:resumeHumanAssistance",
  "automation:viewerScreenshot",
  "automation:viewerInspect",
  "automation:viewerInput",
  "automation:viewerCompletionCheck",
]) {
  assert.equal((octopusBeakApiChannels as readonly string[]).includes(channel), false);
  assert.doesNotMatch(source, new RegExp(`ipcMain\\.handle\\(\\s*"${channel}"`));
}
assert.doesNotMatch(source, /assertManualVerificationAllowedForTask|human-session/);
assert.match(source, /data:invalidated/);
assert.match(
  source,
  /PGliteFinancialPageClient/,
  "financial page requests use the worker-owned PGlite registry",
);
assert.match(source, /registerPGliteViewIpc/);
assert.doesNotMatch(source, /financial-page-worker|createFinancialPageWorkerClient/);
assert.match(source, /pgliteOperational: \{/);
assert.match(source, /pgliteFinancial: PGliteFinancialPageClient/);
assert.match(source, /withExpectedDataVersion/);
assert.match(source, /options\?\.expectedVersion/);
for (const channel of ["overview:block", "assets:block", "liabilities:block", "spending:block", "automation:block"])
  assert.match(source, new RegExp(`ipcMain\\.handle\\(\\s*"${channel}"`));
assert.doesNotMatch(source, /ipcMain\.handle\(\s*"automation:load"/);
assert.match(source, /void automationCredentials\.prewarm\(\)\.catch/);
assert.doesNotMatch(
  source,
  /ipcMain\.on\([\s\S]{0,240}automationCredentials\.prewarm\(\)/,
  "credential prewarm must not be launched from a click/input handler",
);
assert.doesNotMatch(
  source,
  /ipcMain\.handle\("overview:load", \(\) =>\s*loadOverview/,
  "overview projection must not execute synchronously on Electron main",
);
assert.doesNotMatch(
  source,
  /ipcMain\.handle\("assets:load", \(\) => loadAssets/,
  "assets projection must not execute synchronously on Electron main",
);
assert.doesNotMatch(
  source,
  /ipcMain\.handle\("liabilities:load", \(\) => loadLiabilities/,
  "liabilities projection must not execute synchronously on Electron main",
);
assert.match(source, /await pgliteViewRegistration\.close\(\)/);
assert.doesNotMatch(source, /spending:updateItemCategory|spending:updateTransactionOverride/);
assert.match(source, /ipcMain\.handle\("automation:cathayGmailOtpStatus"/);
assert.match(source, /ipcMain\.handle\("automation:enableCathayGmailOtp"/);
assert.match(source, /ipcMain\.handle\(\s*"automation:setCathayGmailOtpEnabled"/);
assert.match(source, /ipcMain\.handle\(\s*"automation:disconnectCathayGmailOtp"/);
assert.match(source, /typeof enabled !== "boolean"/);
assert.match(source, /await onSystemSettingsChanged\?\.\(value\)/);
assert.doesNotMatch(source, /refreshCathayEmailOtpTarget|refreshSinopacCaptchaTarget|refreshYuantaTradeChallengeSubmitTarget/);
assert.doesNotMatch(source, /shouldCheckYuantaTradeCompletion|shouldAutoResumeYuantaTradeCaptcha/);

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
assert.match(mainSource, /createExchangeRateScheduler/);
assert.match(
  mainSource,
  /onSystemSettingsChanged:\s*\(\)\s*=>\s*scheduler\?\.reschedule\(\)/,
);
assert.match(mainSource, /scheduler\?\.start\(\)/);
assert.match(mainSource, /scheduler\?\.stop\(\)/);
assert.match(mainSource, /ipcRegistration = registerOctopusBeakIpc/);
assert.match(mainSource, /ipcRegistration\?\.close\(\)/);
assert.match(mainSource, /exchange-rate-scheduler-error/);
