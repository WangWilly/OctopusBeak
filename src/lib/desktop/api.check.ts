import assert from "node:assert/strict";
import type { AutomationCredentialSaveResult } from "./api.ts";

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

