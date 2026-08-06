import assert from "node:assert/strict";
import {
  BANK_STATEMENT_CAPABILITIES,
  automationFlagEnabled,
  isStatementSelectionGroup,
  selectStatementTypes,
  StatementSelectionError,
} from "./statement-selection.ts";

const fubon = BANK_STATEMENT_CAPABILITIES.fubon;
const esun = BANK_STATEMENT_CAPABILITIES.esun;

assert.equal(isStatementSelectionGroup({ statementSelectionKey: "types", statementTypes: [] }), true);
assert.equal(isStatementSelectionGroup({ statementSelectionKey: "types" }), false);
assert.equal(automationFlagEnabled(undefined), false);

assert.deepEqual(selectStatementTypes(fubon, {}, "display"), {
  selectedIds: [], needsSetup: false, persisted: false,
});
assert.deepEqual(selectStatementTypes(esun, {}, "strict"), {
  selectedIds: ["credit_card"], needsSetup: false, persisted: false,
});
assert.deepEqual(
  selectStatementTypes(
    fubon,
    { [fubon.statementSelectionKey]: "loan,deposit,loan" },
    "strict",
  ).selectedIds,
  ["deposit", "loan"],
);
assert.deepEqual(
  selectStatementTypes(
    { ...fubon, statementTypes: [...fubon.statementTypes, { id: "new_type" }] },
    { [fubon.statementSelectionKey]: "deposit,loan" },
    "strict",
  ).selectedIds,
  ["deposit", "loan"],
);
assert.deepEqual(
  selectStatementTypes(
    fubon,
    {
      [fubon.enabledKey]: false,
      [fubon.statementSelectionKey]: "deposit",
    },
    "strict",
  ).selectedIds,
  ["deposit"],
);
assert.deepEqual(
  selectStatementTypes(
    fubon,
    {
      [fubon.enabledKey]: "false",
      [fubon.statementSelectionKey]: "",
    },
    "strict",
  ),
  { selectedIds: [], needsSetup: false, persisted: true },
);

assert.throws(
  () => selectStatementTypes(
    fubon,
    {
      [fubon.enabledKey]: true,
      [fubon.statementSelectionKey]: "deposit,unknown",
    },
    "strict",
  ),
  (error: unknown) => {
    assert.ok(error instanceof StatementSelectionError);
    assert.equal(error.groupId, "fubon");
    assert.equal(error.reason, "unknown-type");
    assert.deepEqual(error.unknownIds, ["unknown"]);
    assert.equal(error.message, "Unknown Fubon statement type: unknown");
    return true;
  },
);
assert.equal(
  new StatementSelectionError(fubon.id, "unknown-type", fubon).message,
  "Unknown Fubon statement type: unknown",
);
assert.deepEqual(
  selectStatementTypes(
    fubon,
    {
      [fubon.enabledKey]: true,
      [fubon.statementSelectionKey]: "deposit,unknown",
    },
    "display",
  ),
  { selectedIds: ["deposit"], needsSetup: true, persisted: true },
);
assert.throws(
  () => selectStatementTypes(
    fubon,
    {
      [fubon.enabledKey]: true,
      [fubon.statementSelectionKey]: "",
    },
    "strict",
  ),
  (error: unknown) => {
    assert.ok(error instanceof StatementSelectionError);
    assert.equal(error.groupId, "fubon");
    assert.equal(error.reason, "missing-selection");
    assert.deepEqual(error.unknownIds, []);
    assert.equal(error.message, "Select at least one Fubon statement type.");
    return true;
  },
);
