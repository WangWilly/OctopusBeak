import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { octopusBeakApiChannels } from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("settings:load"), true);
assert.equal(octopusBeakApiChannels.includes("settings:save"), true);
assert.equal(octopusBeakApiChannels.includes("spending:confirmCandidate"), true);
assert.equal(octopusBeakApiChannels.includes("spending:denyCandidate"), true);
assert.equal(octopusBeakApiChannels.includes("spending:revokeLink"), true);
assert.equal(octopusBeakApiChannels.includes("financialFreshness:changed"), true);
assert.equal(octopusBeakApiChannels.includes("financialFreshness:latestKnowledgePoint"), true);
assert.equal(octopusBeakApiChannels.includes("overview:section:load"), true);
assert.equal(octopusBeakApiChannels.includes("assets:section:load"), true);
assert.equal(octopusBeakApiChannels.includes("liabilities:section:load"), true);
assert.equal(octopusBeakApiChannels.includes("spending:section:load"), true);

const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
assert.match(source, /ipcMain\.handle\("settings:load"/);
assert.match(source, /ipcMain\.handle\("settings:save"/);
assert.match(source, /ipcMain\.handle\("spending:confirmCandidate"/);
assert.match(source, /ipcMain\.handle\("spending:denyCandidate"/);
assert.match(source, /ipcMain\.handle\("spending:revokeLink"/);
assert.match(source, /function spendingConfirmActionFrom\(/);
assert.match(source, /function spendingIdempotencyKeyFrom\(/);
assert.match(source, /spendingConfirmActionFrom\(input\)/);
assert.match(source, /spendingLinkActionFrom\(input\)/);
assert.match(source, /FINANCIAL_FRESHNESS_LATEST_CHANNEL/);
assert.match(source, /latestKnowledgePointFromDatabase/);
assert.match(source, /financialFreshness\.publish\(receipt\)/);
assert.match(
  source,
  /if \(resumed\) \{\s*automationResume\(taskId, undefined, \(receipt\) => \{\s*financialFreshness\.publish\(receipt\);\s*\}\);\s*\}/,
);
for (const [channel, method] of [
  ["spending:confirmCandidate", "confirmCandidate"],
  ["spending:denyCandidate", "denyCandidate"],
  ["spending:revokeLink", "revokeLink"],
] as const) {
  assert.match(
    source,
    new RegExp(
      `ipcMain\\.handle\\(\\"${channel}\\"[\\s\\S]*?publishSpendingMutationResult\\(\\s*financialPages\\.${method}\\(`,
    ),
    `${channel} must publish freshness only after its worker mutation resolves`,
  );
}
for (const [route, channel] of [
  ["overview", "overview:load"],
  ["assets", "assets:load"],
  ["liabilities", "liabilities:load"],
]) {
  assert.match(
    source,
    new RegExp(
      `ipcMain\\.handle\\(\\"${channel}\\", \\(_event, input: unknown, options: unknown\\) =>\\s*financialPages\\.load\\(\\s*\\"${route}\\",\\s*financialPageLoadInputFrom\\(input\\),`,
    ),
    `${route} IPC load must forward its cutoff input to the worker client`,
  );
}
assert.match(
  source,
  /ipcMain\.handle\(\s*"spending:load",\s*\(_event, input: unknown, options: unknown\) =>\s*financialPages\.load\(\s*"spending",\s*spendingLoadInputFrom\(input\),/,
);
assert.match(source, /function financialPageLoadInputFrom\(/);
assert.match(source, /function financialPageRequestOptionsFrom\(/);
assert.match(source, /ipcMain\.handle\(\"financial:cancel\"/);
assert.match(source, /financialPages\.cancel\(/);
assert.match(source, /function spendingLoadInputFrom\(/);
assert.match(source, /function financialSectionFrom\(/);
assert.match(source, /ipcMain\.handle\("overview:section:load"/);
assert.match(source, /ipcMain\.handle\("assets:section:load"/);
assert.match(source, /ipcMain\.handle\("liabilities:section:load"/);
assert.match(source, /ipcMain\.handle\(\s*"spending:section:load"/);
assert.match(source, /Financial query cutoff must contain a non-negative safe integer knowledge point/);
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
assert.match(source, /return \{[\s\S]*close: \(\) => financialPages\.close\(\)/);
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
assert.match(
  mainSource,
  /onSystemSettingsChanged:\s*\(\)\s*=>\s*scheduler\?\.reschedule\(\)/,
);
assert.match(mainSource, /scheduler\?\.start\(\)/);
assert.match(mainSource, /scheduler\?\.stop\(\)/);
assert.match(mainSource, /ipcRegistration = registerOctopusBeakIpc/);
assert.match(mainSource, /ipcRegistration\?\.close\(\)/);
assert.match(mainSource, /exchange-rate-scheduler-error/);
