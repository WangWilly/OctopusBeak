import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isVerificationSolverExhaustedEvent,
  verificationSolverExhausted,
} from "./verification-actor-ui.ts";
import { translations } from "../i18n/i18n.ts";

const exhausted = [{ stage: "authentication", code: "verification-solver-exhausted" }] as const;
assert.equal(verificationSolverExhausted(exhausted), true);
assert.equal(isVerificationSolverExhaustedEvent(exhausted[0]), true);
assert.equal(verificationSolverExhausted([{ stage: "authentication", code: "device-registration-required" }]), false);
assert.equal(verificationSolverExhausted([{ stage: "collection", code: "verification-solver-exhausted" }]), false);
for (const dictionary of [translations.en.automation, translations["zh-TW"].automation]) {
  assert.ok(dictionary.verificationSolverExhausted);
  assert.doesNotMatch(dictionary.statusLabels.waiting_for_human, /human|人工/i);
  assert.doesNotMatch(dictionary.progressAutomaticVerification, /human|人工/i);
}
assert.equal(translations.en.automation.statusLabels.waiting_for_human, "verifying");
assert.equal(translations["zh-TW"].automation.statusLabels.waiting_for_human, "驗證中");
const dashboard = readFileSync(new URL("./AutomationDashboard.svelte", import.meta.url), "utf8");
assert.doesNotMatch(dashboard, /shouldOfferManualVerification|verificationActorsByCredentialGroup|openHumanViewer/);
assert.match(dashboard, /workflowEventFailureLabel\(event\)/);
assert.match(dashboard, /<code>\{event\.code\}<\/code>/);

const page = readFileSync(new URL("../../routes/+page.svelte", import.meta.url), "utf8");
assert.doesNotMatch(page, /verificationActorsByCredentialGroup/);

console.log("Verification actor UI checks passed.");
