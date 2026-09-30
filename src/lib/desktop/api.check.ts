import assert from "node:assert/strict";
import {
  displayScaleZoomFactor,
  octopusBeakApiChannels,
  type AutomationCredentialSaveResult,
} from "./api.ts";

assert.deepEqual([...octopusBeakApiChannels], [
  "settings:load",
  "settings:save",
  "overview:load",
  "overview:block",
  "assets:load",
  "assets:block",
  "liabilities:load",
  "liabilities:block",
  "spending:load",
  "spending:block",
  "spending:record-page",
  "spending:candidate-page",
  "spending:candidate-page-cancel",
  "spending:page-action",
  "spending:pairing-candidates",
  "spending:pairing-prewarm",
  "spending:confirmCandidate",
  "spending:denyCandidate",
  "spending:revokeLink",
  "automation:block",
  "automation:saveCredentials",
  "automation:cathayGmailOtpStatus",
  "automation:enableCathayGmailOtp",
  "automation:setCathayGmailOtpEnabled",
  "automation:disconnectCathayGmailOtp",
  "automation:selectCertificateFile",
  "automation:openSetupGuideLink",
  "automation:run",
  "automation:runMany",
  "automation:resumeHumanAssistance",
  "automation:cancel",
  "automation:forceTerminate",
  "automation:runHistory",
  "automation:openExternalPrerequisite",
  "automation:viewerScreenshot",
  "automation:viewerInspect",
  "automation:viewerInput",
  "automation:viewerCompletionCheck",
  "automation:runtimeSnapshot",
  "automation:fatalRuntimeSnapshot",
  "automation:runtime-changed",
  "data:getVersion",
  "data:acknowledgeVersion",
  "data:invalidated",
  "data-views:subscribe",
  "data-views:enabled",
  "data-views:unsubscribe",
  "data-views:rows",
  "data-views:error",
]);

import type { OctopusBeakApi } from "./api.ts";

const displayApi: OctopusBeakApi["display"] = {
  setScale(percent) {
    assert.equal(percent, 100);
  },
};
displayApi.setScale(100);

const invalidCertificateSave: AutomationCredentialSaveResult = {
  saved: false,
  error: "invalid-certificate-file",
  credentialKey: "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH",
  reason: "invalid-extension",
};
assert.equal(invalidCertificateSave.saved, false);

assert.equal(displayScaleZoomFactor(75), 0.75);
assert.equal(displayScaleZoomFactor(100), 1);
assert.equal(displayScaleZoomFactor(150), 1.5);
assert.equal(displayScaleZoomFactor(50), 0.75);
assert.equal(displayScaleZoomFactor(200), 1.5);
assert.throws(
  () => displayScaleZoomFactor(Number.NaN),
  { name: "TypeError", message: "Display scale must be finite." },
);
