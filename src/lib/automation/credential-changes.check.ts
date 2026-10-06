import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_CREDENTIAL_CHANGES,
  closeCredentialEditor,
  confirmCredentialEditor,
  credentialSetupInput,
  effectiveGroupEnabled,
  effectiveStatementSelection,
  openCredentialEditor,
  pendingCredentialChanges,
  revertCredential,
  selectAllStatementTypes,
  setGroupEnabled,
  stageCredentialFile,
  stageCredentialValue,
  toggleStatementType,
  updateCredentialEditor,
  type CredentialChangeGroup,
} from "./credential-changes.ts";

const groups: CredentialChangeGroup[] = [
  {
    id: "fubon",
    enabled: true,
    selectedStatementTypeIds: ["deposit"],
    statementTypes: [{ id: "deposit" }, { id: "credit_card" }, { id: "loan" }],
    credentialKeys: ["FUBON_ID", "FUBON_PASSWORD"],
  },
  {
    id: "maicoin",
    enabled: false,
    selectedStatementTypeIds: [],
    credentialKeys: ["MAX_KEY"],
  },
];

test("a fresh modal has no pending changes and reads the saved settings", () => {
  assert.deepEqual(pendingCredentialChanges(groups, NO_CREDENTIAL_CHANGES), []);
  assert.equal(effectiveGroupEnabled(groups, NO_CREDENTIAL_CHANGES, "fubon"), true);
  assert.equal(effectiveGroupEnabled(groups, NO_CREDENTIAL_CHANGES, "maicoin"), false);
  assert.deepEqual(effectiveStatementSelection(groups, NO_CREDENTIAL_CHANGES, "fubon"), ["deposit"]);
});

test("confirming an editor stages one credential change and closes the editor", () => {
  let changes = openCredentialEditor(NO_CREDENTIAL_CHANGES, "fubon", "FUBON_PASSWORD");
  changes = updateCredentialEditor(changes, "new-secret");
  assert.deepEqual(pendingCredentialChanges(groups, changes), []);
  changes = confirmCredentialEditor(changes);
  assert.equal(changes.editor, null);
  assert.deepEqual(pendingCredentialChanges(groups, changes), [
    { kind: "credential", groupId: "fubon", key: "FUBON_PASSWORD" },
  ]);
  assert.deepEqual(credentialSetupInput(groups, changes).credentialDrafts, {
    FUBON_PASSWORD: "new-secret",
  });
});

test("an empty editor draft cannot be confirmed and cancelling stages nothing", () => {
  let changes = openCredentialEditor(NO_CREDENTIAL_CHANGES, "fubon", "FUBON_PASSWORD");
  changes = updateCredentialEditor(changes, "   ");
  assert.equal(confirmCredentialEditor(changes).editor?.key, "FUBON_PASSWORD");
  changes = closeCredentialEditor(updateCredentialEditor(changes, "typed"));
  assert.equal(changes.editor, null);
  assert.deepEqual(changes.credentials, {});
});

test("revert drops exactly one staged credential", () => {
  let changes = stageCredentialValue(NO_CREDENTIAL_CHANGES, "FUBON_ID", "synthetic-id");
  changes = stageCredentialValue(changes, "FUBON_PASSWORD", "pw");
  changes = revertCredential(changes, "FUBON_PASSWORD");
  assert.deepEqual(pendingCredentialChanges(groups, changes), [
    { kind: "credential", groupId: "fubon", key: "FUBON_ID" },
  ]);
});

test("clearing a typed value removes its pending change", () => {
  const typed = stageCredentialValue(NO_CREDENTIAL_CHANGES, "MAX_KEY", "key");
  assert.deepEqual(stageCredentialValue(typed, "MAX_KEY", "").credentials, {});
});

test("certificate files stage their path for saving", () => {
  const changes = stageCredentialFile(NO_CREDENTIAL_CHANGES, "MAX_KEY", "/tmp/cert.pfx", "cert.pfx");
  assert.deepEqual(credentialSetupInput(groups, changes).credentialDrafts, { MAX_KEY: "/tmp/cert.pfx" });
});

test("toggling a group back to its saved state leaves no change behind", () => {
  const disabled = setGroupEnabled(groups, NO_CREDENTIAL_CHANGES, "fubon", false);
  assert.deepEqual(pendingCredentialChanges(groups, disabled), [
    { kind: "enabled", groupId: "fubon", enabled: false },
  ]);
  assert.equal(credentialSetupInput(groups, disabled).enabled.fubon, false);
  assert.deepEqual(pendingCredentialChanges(groups, setGroupEnabled(groups, disabled, "fubon", true)), []);
});

test("statement selections keep catalog order and collapse when they match the saved one", () => {
  let changes = toggleStatementType(groups, NO_CREDENTIAL_CHANGES, "fubon", "loan");
  changes = toggleStatementType(groups, changes, "fubon", "credit_card");
  assert.deepEqual(effectiveStatementSelection(groups, changes, "fubon"), ["deposit", "credit_card", "loan"]);
  assert.deepEqual(pendingCredentialChanges(groups, changes), [{ kind: "statements", groupId: "fubon" }]);
  changes = toggleStatementType(groups, changes, "fubon", "loan");
  changes = toggleStatementType(groups, changes, "fubon", "credit_card");
  assert.deepEqual(pendingCredentialChanges(groups, changes), []);
  assert.deepEqual(
    effectiveStatementSelection(groups, selectAllStatementTypes(groups, NO_CREDENTIAL_CHANGES, "fubon"), "fubon"),
    ["deposit", "credit_card", "loan"],
  );
});

test("pending changes list groups in catalog order with enable, fields, then statements", () => {
  let changes = toggleStatementType(groups, NO_CREDENTIAL_CHANGES, "fubon", "loan");
  changes = stageCredentialValue(changes, "MAX_KEY", "key");
  changes = setGroupEnabled(groups, changes, "maicoin", true);
  changes = stageCredentialValue(changes, "FUBON_PASSWORD", "pw");
  assert.deepEqual(pendingCredentialChanges(groups, changes), [
    { kind: "credential", groupId: "fubon", key: "FUBON_PASSWORD" },
    { kind: "statements", groupId: "fubon" },
    { kind: "enabled", groupId: "maicoin", enabled: true },
    { kind: "credential", groupId: "maicoin", key: "MAX_KEY" },
  ]);
});
