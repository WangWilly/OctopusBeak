import assert from "node:assert/strict";
import test from "node:test";
import {
  canConfirmQuarantine,
  reportContextForAccount,
  seedDataIssuePrototype,
  transitionDataIssuePrototype,
} from "./prototype-model.ts";
import type { AccountRowDto } from "../shared-ledger/types.ts";

test("account report preserves the value visible when the issue is created", () => {
  const account: AccountRowDto = {
    id: "loan-1100",
    label: "萬華 - 信貸中放 - **********1100",
    institution: "元大銀行",
    product: "信貸中放",
    group: "liability",
    kind: "loan",
    typeLabel: "Loan",
    amountLines: [{ currency: "TWD", value: 520_524 }],
    transactionCount: 78,
    assetPositionCount: 0,
    lastUpdated: "2026-07-13",
  };

  assert.deepEqual(reportContextForAccount(account, "實際應為 354,107"), {
    accountId: "loan-1100",
    accountLabel: "萬華 - 信貸中放 - **********1100",
    institution: "元大銀行",
    fieldKey: "balance",
    displayedValue: 520_524,
    currency: "TWD",
    dataDate: "2026-07-13",
    note: "實際應為 354,107",
  });
});

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
