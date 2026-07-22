import assert from "node:assert/strict";
import {
  BANK_STATEMENT_CAPABILITIES,
  assertValidStatementSelections,
  resolveStatementSelection,
  serializeStatementSelection,
} from "./statement-selection.ts";

const fubon = BANK_STATEMENT_CAPABILITIES.fubon;
const esun = BANK_STATEMENT_CAPABILITIES.esun;
assert.deepEqual(resolveStatementSelection(fubon, {}, true), {
  selectedIds: [], needsSetup: true, persisted: false,
});
assert.deepEqual(resolveStatementSelection(esun, {}, true), {
  selectedIds: ["credit_card"], needsSetup: false, persisted: false,
});
assert.deepEqual(
  resolveStatementSelection(fubon, { [fubon.statementSelectionKey]: "loan,deposit,loan" }, true).selectedIds,
  ["deposit", "loan"],
);
assert.equal(serializeStatementSelection(["deposit", "credit_card"]), "deposit,credit_card");
assert.deepEqual(
  resolveStatementSelection(
    { ...fubon, statementTypes: [...fubon.statementTypes, { id: "new_type" }] },
    { [fubon.statementSelectionKey]: "deposit,loan" },
    true,
  ).selectedIds,
  ["deposit", "loan"],
);
assert.deepEqual(
  resolveStatementSelection(fubon, { [fubon.statementSelectionKey]: "deposit" }, false).selectedIds,
  ["deposit"],
);
assert.throws(
  () => resolveStatementSelection(fubon, { [fubon.statementSelectionKey]: "deposit,unknown" }, true),
  /Unknown Fubon statement type: unknown/,
);
assert.deepEqual(
  resolveStatementSelection(
    fubon,
    { [fubon.statementSelectionKey]: "deposit,unknown" },
    true,
    { tolerateUnknown: true },
  ),
  { selectedIds: ["deposit"], needsSetup: true, persisted: true },
);
assert.throws(
  () => assertValidStatementSelections(
    [{ id: "fubon", enabledKey: "LIBRETTO_CLOUD_FUBON_ENABLED", credentialKeys: [], ...fubon }],
    { LIBRETTO_CLOUD_FUBON_ENABLED: true, [fubon.statementSelectionKey]: "" },
  ),
  /Select at least one Fubon statement type/,
);
