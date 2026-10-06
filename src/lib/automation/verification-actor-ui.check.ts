import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CATHAY_APP_VERIFICATION_FAILURE_REASONS,
  cathayEmailOtpFailureReason,
  cathayOtpReasonNeedsGmailSettings,
  verificationFailureEventReason,
  verificationSolverExhausted,
} from "./verification-actor-ui.ts";
import { translations } from "../i18n/i18n.ts";

const events = [
  { stage: "preparation", code: "prepared" },
  { stage: "authentication", code: "cathay-email-otp-gmail-needs-authorization" },
] as const;
assert.equal(cathayEmailOtpFailureReason(events), "gmail-needs-authorization");
assert.equal(cathayOtpReasonNeedsGmailSettings("gmail-needs-authorization"), true);
assert.equal(cathayOtpReasonNeedsGmailSettings("gmail-no-candidate"), false);
const exhausted = [{ stage: "authentication", code: "verification-solver-exhausted" }] as const;
assert.equal(verificationSolverExhausted(exhausted), true);
assert.equal(verificationFailureEventReason(exhausted[0]), "verification-solver-exhausted");
assert.equal(verificationSolverExhausted([{ stage: "collection", code: "verification-solver-exhausted" }]), false);
for (const dictionary of [translations.en.automation, translations["zh-TW"].automation]) {
  for (const reason of CATHAY_APP_VERIFICATION_FAILURE_REASONS) {
    assert.ok(dictionary.cathayOtpFailureReasons[reason], `missing translation for ${reason}`);
  }
  assert.ok(dictionary.verificationSolverExhausted);
  assert.doesNotMatch(dictionary.statusLabels.waiting_for_human, /human|人工/i);
  assert.doesNotMatch(dictionary.progressAutomaticVerification, /human|人工/i);
}
assert.equal(translations.en.automation.statusLabels.waiting_for_human, "verifying");
assert.equal(translations["zh-TW"].automation.statusLabels.waiting_for_human, "驗證中");
assert.equal(
  cathayEmailOtpFailureReason([
    { stage: "collection", code: "cathay-email-otp-gmail-needs-authorization" },
  ]),
  null,
);
assert.equal(
  cathayEmailOtpFailureReason([
    { stage: "authentication", code: "cathay-email-otp-user-data-must-not-leak" },
  ]),
  null,
);
assert.equal(
  cathayEmailOtpFailureReason([
    { stage: "authentication", code: "cathay-email-otp-gmail-no-candidate" },
    { stage: "authentication", code: "cathay-email-otp-unrecognized" },
  ]),
  null,
);

const dashboard = readFileSync(new URL("./AutomationDashboard.svelte", import.meta.url), "utf8");
assert.doesNotMatch(dashboard, /shouldOfferManualVerification|verificationActorsByCredentialGroup|openHumanViewer/);
assert.match(dashboard, /cathayGmailOtpSettingsAction/);
assert.match(dashboard, /workflowEventFailureLabel\(event\)/);
assert.match(dashboard, /<code>\{event\.code\}<\/code>/);

const page = readFileSync(new URL("../../routes/+page.svelte", import.meta.url), "utf8");
assert.doesNotMatch(page, /verificationActorsByCredentialGroup/);

console.log("Verification actor UI checks passed.");
