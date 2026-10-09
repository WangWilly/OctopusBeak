import assert from "node:assert/strict";
import {
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
  "spending:set-purchase-category",
  "spending:pending-overview",
  "spending:merge-log",
  "spending:month-insight",
  "spending:merchant-stats",
  "spending:confirm-strong-candidates",
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
  "automation:tdccDeviceRegistrationStatus",
  "automation:startTdccDeviceRegistration",
  "automation:submitTdccRegistrationCode",
  "automation:cancelTdccDeviceRegistration",
  "automation:selectCertificateFile",
  "automation:openSetupGuideLink",
  "automation:run",
  "automation:runMany",
  "automation:cancel",
  "automation:forceTerminate",
  "automation:runHistory",
  "automation:openExternalPrerequisite",
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

