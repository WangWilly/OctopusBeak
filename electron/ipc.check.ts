import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
const serviceSource = readFileSync(
  new URL("../src/lib/automation/server/automation-desktop-service.ts", import.meta.url),
  "utf8",
);
for (const removed of [
  /"automation:forceQuit"/,
  /forceQuitHumanSessionForTask/,
  /terminateAutomationTaskProcesses/,
  /"automation:resume"/,
  /"automation:resumeHumanAssistance"/,
  /"automation:viewerScreenshot"/,
  /"automation:viewerInspect"/,
  /"automation:viewerInput"/,
  /"automation:viewerCompletionCheck"/,
  /assertManualVerificationAllowedForTask|human-session/,
  /"automation:load"/,
  /refreshCathayEmailOtpTarget|refreshSinopacCaptchaTarget|refreshYuantaTradeChallengeSubmitTarget/,
  /shouldCheckYuantaTradeCompletion|shouldAutoResumeYuantaTradeCaptcha/,
]) {
  assert.doesNotMatch(source, removed);
  assert.doesNotMatch(serviceSource, removed);
}
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
assert.match(source, /\.\.\.automationForwardHandlers\(automation\)/, "automation channels only forward to the desktop service");
assert.match(
  source,
  /"automation:selectCertificateFile": \(event, locale\) =>\s*automation\.selectCertificateFile\(BrowserWindow\.fromWebContents\(event\.sender\), locale\)/,
);
assert.doesNotMatch(serviceSource, /from "electron"/, "the desktop service reaches Electron only through its ports");
assert.match(source, /await pgliteViewRegistration\.close\(\)/);
assert.doesNotMatch(source, /spending:updateItemCategory|spending:updateTransactionOverride/);
assert.match(source, /await onSystemSettingsChanged\?\.\(value\)/);

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
assert.match(mainSource, /createExchangeRateScheduler/);
assert.match(
  mainSource,
  /onSystemSettingsChanged:\s*\(settings\)\s*=>\s*\{\s*scheduler\?\.reschedule\(\);\s*collectionScheduler\?\.reschedule\(\);\s*void usagePinger\?\.check\(\);\s*appUpdater\?\.setEnabled\(settings\.appUpdatesEnabled\);\s*\}/,
);
assert.match(mainSource, /scheduled-collection-scheduler-error/);
assert.match(mainSource, /scheduler\?\.start\(\)/);
assert.match(mainSource, /scheduler\?\.stop\(\)/);
assert.match(mainSource, /const automation = createAutomationDesktopService/);
assert.match(mainSource, /ipcRegistration = registerOctopusBeakIpc\(\{\s*automation,/);
assert.match(
  mainSource,
  /try \{\s*await ipcRegistration\?\.close\(\);\s*\} finally \{[^}]*automationDesktopService\?\.close\(\);\s*\}\s*if \(automationRuntime\?\.hasActive\(\)\) await automationRuntime\.shutdown\(\);/,
  "IPC stops answering, then the service stops publishing, then runs shut down",
);
assert.match(mainSource, /exchange-rate-scheduler-error/);
