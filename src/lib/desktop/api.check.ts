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
  "spending:pairing-candidates",
  "spending:confirmCandidate",
  "spending:denyCandidate",
  "spending:revokeLink",
  "spending:updateItemCategory",
  "spending:updateTransactionOverride",
  "automation:load",
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
  "automation:resume",
  "automation:cancel",
  "automation:runHistory",
  "automation:openExternalPrerequisite",
  "automation:viewerScreenshot",
  "automation:viewerInspect",
  "automation:viewerInput",
  "automation:viewerCompletionCheck",
  "automation:forceQuit",
  "data:getVersion",
  "data:acknowledgeVersion",
  "data:invalidated",
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
