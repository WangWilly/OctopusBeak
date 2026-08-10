import assert from "node:assert/strict";
import { buildCredentialSetupPlan } from "./credential-setup.ts";
import { maskTaiwanId, credentialInputValue } from "./credential-redaction.ts";
import { AUTOMATION_CREDENTIAL_GROUPS } from "./server/tasks.ts";

assert.equal(maskTaiwanId(""), "");
assert.equal(maskTaiwanId("A"), "•");
assert.equal(maskTaiwanId("A123"), "••••");
assert.equal(maskTaiwanId("A1234"), "A•234");

const taiwanIdDigits = ["123", "456", "789"].join("");
const rawTaiwanId = `A${taiwanIdDigits}`;
const maskedTaiwanId = `A${"•".repeat(6)}${taiwanIdDigits.slice(-3)}`;
assert.equal(maskTaiwanId(rawTaiwanId), maskedTaiwanId);
assert.equal(maskTaiwanId(`a${taiwanIdDigits}`), `a${maskedTaiwanId.slice(1)}`);

const taiwanIdCredentialKey = "LIBRETTO_CLOUD_FUBON_USER_ID";
assert.equal(credentialInputValue(rawTaiwanId, "partial", false), maskedTaiwanId);
assert.equal(credentialInputValue(rawTaiwanId, "partial", true), rawTaiwanId);
assert.equal(credentialInputValue("code-123", "full", false), "code-123");
assert.equal(credentialInputValue("plain", "none", false), "plain");

const setupGroups = AUTOMATION_CREDENTIAL_GROUPS.map((group) => ({
  id: group.id,
  label: group.label,
  enabledKey: group.enabledKey,
  statementSelectionKey: group.statementSelectionKey,
  statementTypes: group.statementTypes,
}));
const plan = buildCredentialSetupPlan({
  groups: setupGroups,
  enabled: Object.fromEntries(setupGroups.map((group) => [group.id, true])),
  statementSelections: {},
  credentialDrafts: { [taiwanIdCredentialKey]: rawTaiwanId },
  selectedCredentialGroupId: "fubon",
  onboardingSingleSource: false,
  collectionGroupIds: new Set(["fubon"]),
});
assert.equal(plan.updates[taiwanIdCredentialKey], rawTaiwanId);
assert.doesNotMatch(plan.updates[taiwanIdCredentialKey], /•/);
