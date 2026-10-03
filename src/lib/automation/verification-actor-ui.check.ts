import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CATHAY_APP_VERIFICATION_FAILURE_REASONS,
  cathayEmailOtpFailureReason,
  cathayOtpReasonNeedsGmailSettings,
  onboardingStepForVerificationActor,
  shouldOfferManualVerification,
  verificationFailureEventReason,
  verificationSolverExhausted,
  verificationActorForUiGroup,
} from "./verification-actor-ui.ts";
import { translations } from "../i18n/i18n.ts";

assert.equal(verificationActorForUiGroup("cathay", undefined), "solver");
assert.equal(verificationActorForUiGroup("cathay", { cathay: "unknown" } as never), "solver");
assert.equal(verificationActorForUiGroup("cathay", { cathay: "human" }), "human");
assert.equal(shouldOfferManualVerification("cathay", undefined), false);
assert.equal(shouldOfferManualVerification("cathay", { cathay: "human" }), true);
assert.equal(
  onboardingStepForVerificationActor("assist", "cathay", undefined),
  "hidden",
);
assert.equal(
  onboardingStepForVerificationActor("assist", "cathay", { cathay: "human" }),
  "assist",
);
assert.equal(
  onboardingStepForVerificationActor("credentials", "cathay", undefined),
  "credentials",
);

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
}
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
assert.match(dashboard, /iconTasks = automation\.tasks\.filter\([\s\S]*?shouldOfferManualVerification/);
assert.match(dashboard, /status === "waiting_for_human" && task\.humanSession[\s\S]*?shouldOfferManualVerification/);
assert.match(dashboard, /function openHumanViewer\(task: AutomationTaskRow\) \{\s*if \(!shouldOfferManualVerification/);
assert.match(dashboard, /visibleOnboardingStep = onboardingStepForVerificationActor/);
assert.match(dashboard, /cathayGmailOtpSettingsAction/);
assert.match(dashboard, /workflowEventFailureLabel\(event\)/);
assert.match(dashboard, /<code>\{event\.code\}<\/code>/);

const page = readFileSync(new URL("../../routes/+page.svelte", import.meta.url), "utf8");
assert.match(page, /onboardingStepForVerificationActor\([\s\S]*?automationValue\?\.verificationActorsByCredentialGroup/);
assert.match(page, /verificationActorsByCredentialGroup=\{automationRenderValue\.verificationActorsByCredentialGroup\}/);

console.log("Verification actor UI checks passed.");
