import assert from "node:assert/strict";
import test from "node:test";
import {
  canConfirmQuarantine,
  seedDataIssuePrototype,
  transitionDataIssuePrototype,
} from "./prototype-model.ts";

test("data issue prototype completes quarantine, audit, and restore safely", () => {
  let state = seedDataIssuePrototype();
  state = transitionDataIssuePrototype(state, { type: "open-diagnosis" });
  state = transitionDataIssuePrototype(state, {
    type: "select-source",
    sourceId: "reported-import",
  });
  state = transitionDataIssuePrototype(state, {
    type: "preview",
    scenario: "safe",
  });
  assert.equal(state.screen, "preview");
  assert.equal(canConfirmQuarantine(state), false);

  state = transitionDataIssuePrototype(state, {
    type: "set-reason",
    reason: "Result from another account",
  });
  state = transitionDataIssuePrototype(state, {
    type: "acknowledge",
    acknowledged: true,
  });
  assert.equal(canConfirmQuarantine(state), true);

  state = transitionDataIssuePrototype(state, { type: "start-quarantine" });
  assert.equal(state.screen, "working");
  state = transitionDataIssuePrototype(state, { type: "complete-quarantine" });
  assert.equal(state.screen, "success");
  assert.equal(state.issue.status, "resolved");
  assert.equal(state.currentValue, 354_107);

  state = transitionDataIssuePrototype(state, { type: "show-audit" });
  assert.equal(state.screen, "audit");
  state = transitionDataIssuePrototype(state, { type: "preview-restore" });
  state = transitionDataIssuePrototype(state, { type: "confirm-restore" });
  assert.equal(state.screen, "restored");
  assert.equal(state.issue.status, "restored");
  assert.equal(state.currentValue, 520_524);
});

test("blocked and failed scenarios never change the displayed value", () => {
  const diagnosis = transitionDataIssuePrototype(seedDataIssuePrototype(), {
    type: "open-diagnosis",
  });
  const selected = transitionDataIssuePrototype(diagnosis, {
    type: "select-source",
    sourceId: "reported-import",
  });
  const blocked = transitionDataIssuePrototype(selected, {
    type: "preview",
    scenario: "blocked",
  });
  assert.equal(blocked.screen, "blocked");
  assert.equal(canConfirmQuarantine(blocked), false);
  assert.equal(blocked.currentValue, 520_524);

  const failed = transitionDataIssuePrototype(selected, {
    type: "preview",
    scenario: "failure",
  });
  assert.equal(failed.screen, "failure");
  assert.equal(failed.currentValue, 520_524);
  assert.equal(failed.issue.status, "investigating");
});
