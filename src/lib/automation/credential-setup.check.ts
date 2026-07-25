import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCredentialSetupPlan,
  firstInvalidCredentialGroup,
  singleSourceUpdates,
  type CredentialSetupGroup,
} from "./credential-setup.ts";

const groups: CredentialSetupGroup[] = [
  {
    id: "fubon",
    label: "Fubon",
    enabledKey: "FUBON_ENABLED",
    statementSelectionKey: "FUBON_TYPES",
    statementTypes: [{ id: "deposit" }, { id: "card" }],
  },
  {
    id: "esun",
    label: "E.SUN",
    enabledKey: "ESUN_ENABLED",
    statementSelectionKey: "ESUN_TYPES",
    statementTypes: [{ id: "deposit" }],
  },
];

test("credential setup rejects enabled groups without statement selections", () => {
  assert.equal(
    firstInvalidCredentialGroup(groups, { fubon: true, esun: false }, { fubon: [] })?.id,
    "fubon",
  );
  assert.equal(
    firstInvalidCredentialGroup(
      groups,
      { fubon: true, esun: true },
      { fubon: ["deposit"], esun: ["deposit"] },
    ),
    null,
  );
});

test("credential setup builds normalized updates and single-source policy", () => {
  assert.deepEqual(
    buildCredentialSetupPlan({
      groups,
      enabled: { fubon: true, esun: false },
      statementSelections: { fubon: ["deposit", "card"], esun: [] },
      credentialDrafts: { USER: " demo-user ", PASSWORD: "  " },
      selectedCredentialGroupId: "fubon",
      onboardingSingleSource: true,
      collectionGroupIds: new Set(["fubon", "esun"]),
    }),
    {
      updates: {
        FUBON_ENABLED: "true",
        FUBON_TYPES: "deposit,card",
        ESUN_ENABLED: "false",
        USER: "demo-user",
      },
      selectedCredentialGroupId: "fubon",
    },
  );
  assert.deepEqual(
    singleSourceUpdates(groups, "esun", new Set(["fubon", "esun"])),
    { FUBON_ENABLED: "false", ESUN_ENABLED: "true" },
  );
});
