import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { octopusBeakApiChannels } from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("settings:load"), true);
assert.equal(octopusBeakApiChannels.includes("settings:save"), true);
assert.equal(octopusBeakApiChannels.includes("spending:confirmCandidate"), true);
assert.equal(octopusBeakApiChannels.includes("spending:denyCandidate"), true);
assert.equal(octopusBeakApiChannels.includes("spending:revokeLink"), true);

const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
assert.match(source, /ipcMain\.handle\("settings:load"/);
assert.match(source, /ipcMain\.handle\("settings:save"/);
assert.match(source, /ipcMain\.handle\("spending:confirmCandidate"/);
assert.match(source, /ipcMain\.handle\("spending:denyCandidate"/);
assert.match(source, /ipcMain\.handle\("spending:revokeLink"/);
assert.match(
  source,
  /createFinancialPageWorkerClient/,
  "financial page loads must cross a worker boundary so projection reads cannot block Electron main",
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
assert.match(source, /return \{\s*close: \(\) => financialPages\.close\(\),?\s*\}/);
assert.match(source, /ipcMain\.handle\("automation:cathayGmailOtpStatus"/);
assert.match(source, /ipcMain\.handle\("automation:enableCathayGmailOtp"/);
assert.match(source, /ipcMain\.handle\(\s*"automation:setCathayGmailOtpEnabled"/);
assert.match(source, /ipcMain\.handle\(\s*"automation:disconnectCathayGmailOtp"/);
assert.match(source, /typeof enabled !== "boolean"/);
assert.match(source, /await onSystemSettingsChanged\?\.\(value\)/);
assert.match(
  source,
  /shouldCheckProviderVerificationCompletion\(\s*record\.type,\s*clickedTarget\?\.semanticId/,
);
assert.match(
  source,
  /await refreshProviderVerificationTarget\(session, contract\)/,
);
assert.match(
  source,
  /await sendProviderVerificationInput\(session, input, refreshedContract\)/,
);
assert.match(
  source,
  /await refreshProviderVerificationTarget\(\s*session,\s*refreshedContract,?\s*\)/,
);
assert.match(source, /shouldAutoResumeProviderVerification\(/);
assert.doesNotMatch(source, /refreshCathayEmailOtpTarget|refreshSinopacCaptchaTarget|refreshYuantaTradeChallengeSubmitTarget/);
assert.doesNotMatch(source, /shouldCheckYuantaTradeCompletion|shouldAutoResumeYuantaTradeCaptcha/);

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
assert.match(mainSource, /createExchangeRateScheduler/);
assert.match(mainSource, /onSystemSettingsChanged: scheduler\.reschedule/);
assert.match(mainSource, /scheduler\.start\(\)/);
assert.match(mainSource, /scheduler\?\.stop\(\)/);
assert.match(mainSource, /ipcRegistration = registerOctopusBeakIpc/);
assert.match(mainSource, /ipcRegistration\?\.close\(\)/);
assert.match(mainSource, /exchange-rate-scheduler-error/);
