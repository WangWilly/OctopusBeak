import assert from "node:assert/strict";
import test from "node:test";
import { translations } from "../i18n/i18n.ts";
import type { CredentialGroupDto } from "../desktop/api.ts";
import { NO_CREDENTIAL_CHANGES } from "./credential-changes.ts";
import {
  CLOSED_CREDENTIAL_SHEET,
  applyCredentialSaveResult,
  certificateFileValidationMessage,
  credentialSheetView,
  planCredentialSave,
  reduceCredentialSheet,
  type CredentialSheetAction,
  type CredentialSheetContext,
  type CredentialSheetState,
} from "./credential-sheet.ts";

function group(id: string, overrides: Partial<CredentialGroupDto> = {}): CredentialGroupDto {
  return {
    id,
    label: id,
    displayName: { en: id.toUpperCase(), "zh-TW": `${id}銀行（${id.toUpperCase()}）` },
    searchAliases: [],
    enabledKey: `${id.toUpperCase()}_ENABLED`,
    credentialKeys: [`${id.toUpperCase()}_ID`],
    credentialFields: [],
    setupGuide: { summary: { en: "", "zh-TW": "" }, requirements: [], steps: [], links: [] },
    enabled: false,
    selectedStatementTypeIds: [],
    statementSetupRequired: false,
    storedCredentialFileNames: {},
    invalidCredentialFileKeys: [],
    ...overrides,
  } as CredentialGroupDto;
}

const fubon = group("fubon", {
  enabled: true,
  searchAliases: ["taipei fubon"],
  selectedStatementTypeIds: ["deposit"],
  statementSelectionKey: "FUBON_STATEMENTS",
  statementTypes: [{ id: "deposit" }, { id: "credit_card" }],
});
const cathay = group("cathay", {
  statementSelectionKey: "CATHAY_STATEMENTS",
  statementTypes: [{ id: "deposit" }],
});
const maicoin = group("maicoin");
const groups = [fubon, cathay, maicoin];

function context(overrides: Partial<CredentialSheetContext> = {}): CredentialSheetContext {
  return {
    dictionary: translations.en,
    locale: "en",
    credentialGroups: groups,
    collectionGroupIds: new Set(["fubon", "cathay", "maicoin"]),
    onboardingSourceSelection: false,
    onboardingSingleSource: false,
    onboardingNodeId: null,
    onboardingSelectedCredentialGroupId: null,
    credentialState: () => "ready",
    ...overrides,
  };
}

function run(
  actions: readonly CredentialSheetAction[],
  ctx = context(),
  state: CredentialSheetState = CLOSED_CREDENTIAL_SHEET,
) {
  return actions.reduce((current, action) => reduceCredentialSheet(current, action, ctx), state);
}

const onboarding = (overrides: Partial<CredentialSheetContext> = {}) =>
  context({ onboardingSourceSelection: true, onboardingSingleSource: true, ...overrides });

test("opening resets edits, keeps the last group outside onboarding and clears the search", () => {
  const edited = run([
    { type: "open" },
    { type: "select-group", groupId: "cathay" },
    { type: "toggle-group", groupId: "maicoin" },
    { type: "search", search: "cat" },
  ]);
  const reopened = run([{ type: "close" }, { type: "open" }], context(), edited);
  assert.equal(reopened.open, true);
  assert.equal(reopened.selectedGroupId, "cathay");
  assert.equal(reopened.search, "");
  assert.equal(reopened.presentation, "details");
  assert.deepEqual(reopened.changes, NO_CREDENTIAL_CHANGES);
  assert.equal(run([{ type: "open" }]).selectedGroupId, "fubon", "the first group without a remembered one");
  const staged = run([{ type: "stage-value", key: "CATHAY_ID", value: "stale" }], context(), edited);
  const failed = run([{ type: "certificate-file-failed", key: "CATHAY_ID", message: "bad", generation: staged.generation }], context(), staged);
  const reopenedWithoutClose = run([{ type: "open" }], context(), failed);
  assert.deepEqual(reopenedWithoutClose.changes, NO_CREDENTIAL_CHANGES, "opening an open sheet also drops its edits");
  assert.deepEqual(reopenedWithoutClose.fileErrors, {});
});

test("opening during onboarding selects only a remembered collection group and shows the picker", () => {
  const remembered = run([{ type: "open" }], onboarding({
    onboardingSelectedCredentialGroupId: "cathay",
    onboardingNodeId: "source-entry",
  }));
  assert.equal(remembered.selectedGroupId, "cathay");
  assert.equal(remembered.presentation, "picker");
  const notCollected = run([{ type: "open" }], onboarding({
    onboardingSelectedCredentialGroupId: "cathay",
    collectionGroupIds: new Set(["fubon"]),
    onboardingNodeId: "credentials",
  }));
  assert.equal(notCollected.selectedGroupId, "");
  assert.equal(notCollected.presentation, "details");
});

test("opening resets edits before single-source onboarding disables the other sources", () => {
  const ctx = onboarding({ onboardingSelectedCredentialGroupId: "cathay" });
  const stale = { ...CLOSED_CREDENTIAL_SHEET, changes: { ...NO_CREDENTIAL_CHANGES, enabled: { maicoin: true } } };
  const opened = run([{ type: "open" }], ctx, stale);
  assert.deepEqual(opened.changes.enabled, { fubon: false });
});

test("selecting a group confirms its saved statements, clears the error and closes the guide on change", () => {
  let state = run([{ type: "open" }, { type: "toggle-setup-guide" }]);
  state = { ...state, statementSelectionError: "pick one" };
  const same = run([{ type: "select-group", groupId: "fubon" }], context(), state);
  assert.equal(same.setupGuideOpen, true);
  assert.equal(same.statementSelectionConfirmed, true);
  assert.equal(same.statementSelectionError, "");
  const other = run([{ type: "select-group", groupId: "cathay" }], context(), state);
  assert.equal(other.setupGuideOpen, false);
  assert.equal(other.statementSelectionConfirmed, false);
});

test("choosing a source during onboarding source selection shows its details", () => {
  const ctx = onboarding({ onboardingNodeId: "source-selection" });
  const state = run([{ type: "open" }, { type: "choose-group", groupId: "cathay" }], ctx);
  assert.equal(state.presentation, "details");
  assert.deepEqual(state.changes.enabled, { fubon: false });
  const outside = run([{ type: "open" }, { type: "present", presentation: "picker" }, { type: "choose-group", groupId: "cathay" }]);
  assert.equal(outside.presentation, "picker");
});

test("enable-and-select chooses the source and enables it, disabling the other single source", () => {
  const ctx = onboarding({ onboardingNodeId: "source-selection" });
  const state = run([{ type: "open" }, { type: "enable-and-select-group", groupId: "cathay" }], ctx);
  assert.equal(state.selectedGroupId, "cathay");
  assert.deepEqual(state.changes.enabled, { fubon: false, cathay: true });
});

test("onboarding presentation opens a closed sheet and selects a known group", () => {
  const state = run([{ type: "present-onboarding", presentation: "details", groupId: "cathay" }], onboarding());
  assert.equal(state.open, true);
  assert.equal(state.selectedGroupId, "cathay");
  assert.equal(state.presentation, "details");
  const unknown = run([{ type: "present-onboarding", presentation: "picker", groupId: "nope" }], onboarding(), state);
  assert.equal(unknown.selectedGroupId, "cathay");
  assert.equal(unknown.presentation, "picker");
  assert.equal(unknown.generation, state.generation, "an open sheet is not reopened");
});

test("searching away from the selection picks the first match, or nothing during onboarding", () => {
  const state = run([{ type: "open" }, { type: "select-group", groupId: "maicoin" }]);
  const searched = run([{ type: "search", search: "taipei" }], context(), state);
  assert.equal(searched.selectedGroupId, "fubon");
  assert.deepEqual(credentialSheetView(searched, context()).visibleGroups.map((g) => g.id), ["fubon"]);
  const ctx = onboarding({ onboardingSingleSource: false });
  const onboardingSearch = run([{ type: "search", search: "taipei" }], ctx, state);
  assert.equal(onboardingSearch.selectedGroupId, "");
  const stillVisible = run([{ type: "search", search: "mai" }], context(), state);
  assert.equal(stillVisible.selectedGroupId, "maicoin");
});

test("statement toggles confirm the selection; editor, revert and field focus stage through credential changes", () => {
  let state = run([
    { type: "open" },
    { type: "select-group", groupId: "cathay" },
    { type: "toggle-statement-type", groupId: "cathay", typeId: "deposit" },
  ]);
  assert.equal(state.statementSelectionConfirmed, true);
  assert.deepEqual(state.changes.statementSelections, { cathay: ["deposit"] });
  state = run([
    { type: "editor-start", groupId: "cathay", key: "CATHAY_ID" },
    { type: "editor-draft", draft: "A123" },
  ], context(), state);
  const draftOnly = run([
    { type: "open" },
    { type: "editor-start", groupId: "cathay", key: "CATHAY_ID" },
    { type: "editor-draft", draft: "A123" },
  ]);
  assert.equal(credentialSheetView(draftOnly, context()).dirty, true, "an unconfirmed draft is dirty");
  state = run([{ type: "editor-confirm" }], context(), state);
  assert.deepEqual(state.changes.credentials.CATHAY_ID, { kind: "value", value: "A123" });
  state = run([{ type: "revert", key: "CATHAY_ID" }, { type: "focus-field", key: "X" }, { type: "blur-field", key: "Y" }], context(), state);
  assert.equal(state.changes.credentials.CATHAY_ID, undefined);
  assert.equal(state.focusedKey, "X", "blurring another field keeps the focus");
  assert.equal(run([{ type: "blur-field", key: "X" }], context(), state).focusedKey, null);
});

test("closing resets the edits and advances the generation", () => {
  const state = run([{ type: "open" }, { type: "toggle-group", groupId: "maicoin" }]);
  const closed = run([{ type: "close" }], context(), state);
  assert.equal(closed.open, false);
  assert.deepEqual(closed.changes, NO_CREDENTIAL_CHANGES);
  assert.equal(closed.generation, state.generation + 1);
});

test("the view derives the rail, pending changes and the selected group fallback", () => {
  const state = run([{ type: "open" }, { type: "toggle-group", groupId: "maicoin" }]);
  const view = credentialSheetView({ ...state, selectedGroupId: "" }, context());
  assert.equal(view.savedEnabledGroupCount, 1);
  assert.deepEqual(view.railEnabledGroups.map((g) => g.id), ["fubon", "maicoin"]);
  assert.deepEqual(view.railAvailableGroups.map((g) => g.id), ["cathay"]);
  assert.deepEqual(view.pendingChanges, [{ kind: "enabled", groupId: "maicoin", enabled: true }]);
  assert.equal(view.selectedGroup?.id, "fubon", "falls back to the first visible group");
  assert.equal(view.canSubmit, true);
  assert.equal(credentialSheetView({ ...state, selectedGroupId: "" }, onboarding()).selectedGroup, undefined);
});

test("onboarding readiness needs the source enabled, its sign-in details and confirmed statements", () => {
  const ctx = onboarding({ credentialState: () => "missing" });
  let state = run([{ type: "open" }, { type: "enable-and-select-group", groupId: "cathay" }], ctx);
  let view = credentialSheetView(state, ctx);
  assert.equal(view.onboardingSourceEnabled, true);
  assert.equal(view.onboardingMissingCredentialKey, "CATHAY_ID");
  assert.equal(view.onboardingNeedsStatements, true);
  assert.equal(view.canSubmit, false);
  state = run([
    { type: "stage-value", key: "CATHAY_ID", value: "A123" },
    { type: "toggle-statement-type", groupId: "cathay", typeId: "deposit" },
  ], ctx, state);
  view = credentialSheetView(state, ctx);
  assert.equal(view.onboardingCredentialsReady, true);
  assert.equal(view.canSubmit, true);
});

test("a submit marks the sheet saving and a second submit is blocked", () => {
  const state = run([
    { type: "open" },
    { type: "toggle-group", groupId: "maicoin" },
    { type: "stage-value", key: "MAICOIN_ID", value: " user-1 " },
  ]);
  const save = planCredentialSave(state, context());
  assert.equal(save.kind, "submit");
  if (save.kind !== "submit") return;
  assert.equal(save.state.saving, true);
  assert.equal(save.plan.updates.MAICOIN_ENABLED, "true");
  assert.equal(save.plan.updates.MAICOIN_ID, "user-1", "staged sign-in details are saved");
  assert.equal(save.savedGroupId, "fubon");
  assert.equal(credentialSheetView(save.state, context()).canSubmit, false, "the submit button is disabled");
  assert.deepEqual(planCredentialSave(save.state, context()), { kind: "blocked" });
});

test("a submit is blocked while editing or before onboarding is ready", () => {
  assert.equal(credentialSheetView(run([{ type: "open" }]), context()).canSubmit, false, "nothing to save yet");
  const editing = run([
    { type: "open" },
    { type: "toggle-group", groupId: "maicoin" },
    { type: "editor-start", groupId: "fubon", key: "FUBON_ID" },
  ]);
  assert.equal(credentialSheetView(editing, context()).canSubmit, false, "an open editor disables the submit button");
  assert.deepEqual(planCredentialSave(editing, context()), { kind: "blocked" });
  const notReady = run([{ type: "open" }], onboarding());
  assert.deepEqual(planCredentialSave(notReady, onboarding()), { kind: "blocked" });
});

test("an invalid submit selects the group like a click, clears the search and shows its details", () => {
  const ctx = onboarding({ onboardingSingleSource: false, credentialState: () => "ready" });
  const state = run([
    { type: "open" },
    { type: "choose-group", groupId: "fubon" },
    { type: "toggle-group", groupId: "cathay" },
    { type: "toggle-setup-guide" },
    { type: "search", search: "fub" },
    { type: "present", presentation: "picker" },
  ], ctx);
  assert.equal(credentialSheetView(state, ctx).onboardingCredentialsReady, true);
  const save = planCredentialSave(state, ctx);
  assert.equal(save.kind, "invalid");
  if (save.kind !== "invalid") return;
  assert.equal(save.groupId, "cathay");
  assert.equal(save.state.selectedGroupId, "cathay");
  assert.equal(save.state.search, "");
  assert.equal(save.state.presentation, "details");
  assert.equal(save.state.statementSelectionConfirmed, false, "confirmation follows the newly selected group");
  assert.equal(save.state.setupGuideOpen, false);
  assert.equal(save.state.saving, false);
  assert.equal(save.state.statementSelectionError, translations.en.automation.selectOneStatementType("CATHAY"));
});

test("the invalid statement message names the group in the person's language", () => {
  const ctx = context({ dictionary: translations["zh-TW"], locale: "zh-TW" });
  const state = run([{ type: "open" }, { type: "toggle-group", groupId: "cathay" }], ctx);
  const save = planCredentialSave(state, ctx);
  assert.equal(save.kind === "invalid" && save.state.statementSelectionError,
    translations["zh-TW"].automation.selectOneStatementType("cathay銀行"));
});

test("a saved result resets the edits but stays saving until the reload closes the sheet", () => {
  const state = run([{ type: "open" }, { type: "toggle-group", groupId: "maicoin" }]);
  const save = planCredentialSave(state, context());
  if (save.kind !== "submit") throw new Error("expected a submit");
  const generation = save.state.generation;
  const saved = applyCredentialSaveResult(save.state, generation, { kind: "result", result: { saved: true } }, context());
  assert.deepEqual(saved.changes, NO_CREDENTIAL_CHANGES);
  assert.equal(saved.open, true);
  assert.equal(saved.saving, true);
  const closed = run([{ type: "saved-and-reloaded", generation }], context(), saved);
  assert.equal(closed.open, false);
  assert.equal(closed.saving, false);
});

test("a rejected certificate writes its file error and a failed save clears saving", () => {
  const save = planCredentialSave(run([{ type: "open" }, { type: "toggle-group", groupId: "maicoin" }]), context());
  if (save.kind !== "submit") throw new Error("expected a submit");
  const { generation } = save.state;
  const rejected = applyCredentialSaveResult(save.state, generation, {
    kind: "result",
    result: { saved: false, error: "invalid-certificate-file", credentialKey: "FUBON_CERT", reason: "invalid-extension" },
  }, context());
  assert.equal(rejected.fileErrors.FUBON_CERT, translations.en.automation.invalidCertificateExtension);
  assert.equal(rejected.saving, false);
  assert.equal(rejected.changes, save.state.changes, "the edits stay for another try");
  const failed = applyCredentialSaveResult(save.state, generation, { kind: "failed" }, context());
  assert.equal(failed.saving, false);
  assert.equal(failed.open, true);
});

test("a save result from before a close and reopen is dropped", () => {
  const save = planCredentialSave(run([{ type: "open" }, { type: "toggle-group", groupId: "maicoin" }]), context());
  if (save.kind !== "submit") throw new Error("expected a submit");
  const { generation } = save.state;
  const reopened = run([{ type: "close" }, { type: "open" }, { type: "toggle-group", groupId: "cathay" }], context(), save.state);
  assert.equal(reopened.saving, false);
  for (const outcome of [
    { kind: "result", result: { saved: true } },
    { kind: "result", result: { saved: false, error: "invalid-certificate-file", credentialKey: "K", reason: "invalid-extension" } },
    { kind: "failed" },
  ] as const) {
    assert.equal(applyCredentialSaveResult(reopened, generation, outcome, context()), reopened);
  }
  assert.equal(run([{ type: "saved-and-reloaded", generation }], context(), reopened), reopened);
});

test("a certificate file stages for the same sheet and is dropped after the sheet changed", () => {
  const state = run([{ type: "open" }, { type: "certificate-file-started", key: "FUBON_CERT" }]);
  const { generation } = state;
  const result = { cancelled: false, path: "/tmp/a.pfx", filename: "a.pfx" } as const;
  const staged = run([{ type: "certificate-file-selected", generation, key: "FUBON_CERT", result }], context(), state);
  assert.deepEqual(staged.changes.credentials.FUBON_CERT, { kind: "file", path: "/tmp/a.pfx", filename: "a.pfx" });
  const invalid = run([{
    type: "certificate-file-selected",
    generation,
    key: "FUBON_CERT",
    result: { cancelled: false, error: "missing-or-unreadable" },
  }], context(), state);
  assert.equal(invalid.fileErrors.FUBON_CERT, translations.en.automation.unreadableCertificateFile);
  const reopened = run([{ type: "close" }, { type: "open" }], context(), state);
  assert.equal(run([{ type: "certificate-file-selected", generation, key: "FUBON_CERT", result }], context(), reopened), reopened);
  assert.equal(run([{ type: "certificate-file-failed", generation, key: "FUBON_CERT", message: "boom" }], context(), reopened), reopened);
  assert.equal(
    run([{ type: "certificate-file-failed", generation, key: "FUBON_CERT", message: "boom" }], context(), state).fileErrors.FUBON_CERT,
    "boom",
  );
});

test("a certificate message tells a bad extension apart from a missing stored file", () => {
  const { automation } = translations.en;
  assert.equal(certificateFileValidationMessage("invalid-extension", true, translations.en), automation.invalidCertificateExtension);
  assert.equal(certificateFileValidationMessage("missing-or-unreadable", true, translations.en), automation.missingCertificateFile);
  assert.equal(certificateFileValidationMessage("missing-or-unreadable", false, translations.en), automation.unreadableCertificateFile);
});
