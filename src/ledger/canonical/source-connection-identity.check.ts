import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_CONNECTION_IDENTITY_CONTRACT_VERSION,
  SOURCE_CONNECTION_SCOPE_SEPARATOR,
  assembleStableSourceLoginScope,
  deriveSourceConnectionIdentityKey,
  normalizeStableSourceLoginIdentity,
  requireSourceConnectionIdentity,
  validateSourceConnectionIdentity,
} from "./source-connection-identity.ts";

test("stable login scope owns field normalization, separator, and missing policy", () => {
  assert.equal(
    assembleStableSourceLoginScope([
      { name: "user", value: " user-001 " },
      { name: "account", value: " main-account " },
    ]),
    `USER-001${SOURCE_CONNECTION_SCOPE_SEPARATOR}MAIN-ACCOUNT`,
  );
  assert.equal(
    assembleStableSourceLoginScope([
      { name: "user", value: "user-001" },
      { name: "account", value: "" },
    ], "undefined"),
    undefined,
  );
  assert.throws(
    () =>
      assembleStableSourceLoginScope([
        { name: "user", value: "user-001" },
        { name: "account", value: undefined },
      ]),
    /account/u,
  );
  assert.throws(
    () =>
      assembleStableSourceLoginScope([
        { name: "user", value: "user\u00001" },
        { name: "account", value: "main-account" },
      ]),
    /control character/u,
  );
});

test("workflow Source Connection validation requires a matching caller scope and key", () => {
  const scope = `USER-001${SOURCE_CONNECTION_SCOPE_SEPARATOR}ACCOUNT-001`;
  const key = deriveSourceConnectionIdentityKey("fubon", scope);
  assert.deepEqual(
    requireSourceConnectionIdentity("fubon", "Fubon deposit", {
      sourceConnectionScope: ` ${scope} `,
      sourceConnectionKey: ` ${key} `,
    }),
    { sourceConnectionScope: scope, sourceConnectionKey: key },
  );
  assert.throws(
    () => requireSourceConnectionIdentity("fubon", "Fubon deposit", {}),
    /stable caller-supplied Source Connection scope and key/u,
  );
  assert.throws(
    () =>
      requireSourceConnectionIdentity("fubon", "Fubon deposit", {
        sourceConnectionScope: scope,
        sourceConnectionKey: deriveSourceConnectionIdentityKey(
          "fubon",
          `${scope}-OTHER`,
        ),
      }),
    /do not identify the same login/u,
  );
});

test("canonical Source Connection validation reports exact fail-closed defects", () => {
  const scope = `USER-001${SOURCE_CONNECTION_SCOPE_SEPARATOR}ACCOUNT-001`;
  const expectedKey = deriveSourceConnectionIdentityKey("yuanta", scope);
  assert.deepEqual(validateSourceConnectionIdentity("yuanta", {}), {
    sourceConnectionScope: null,
    sourceConnectionKey: null,
    defects: [
      "source-connection-scope-invalid",
      "source-connection-key-invalid",
    ],
  });
  assert.deepEqual(
    validateSourceConnectionIdentity("yuanta", {
      sourceConnectionScope: scope,
      sourceConnectionKey: deriveSourceConnectionIdentityKey(
        "yuanta",
        `${scope}-OTHER`,
      ),
    }),
    {
      sourceConnectionScope: scope,
      sourceConnectionKey: null,
      defects: ["source-connection-key-mismatch"],
    },
  );
  assert.deepEqual(
    validateSourceConnectionIdentity("yuanta", {
      sourceConnectionScope: ` ${scope} `,
      sourceConnectionKey: ` ${expectedKey} `,
    }),
    {
      sourceConnectionScope: scope,
      sourceConnectionKey: expectedKey,
      defects: [],
    },
  );
});

test("source connection identity is deterministic, product-independent, and secret-free", () => {
  assert.equal(
    SOURCE_CONNECTION_IDENTITY_CONTRACT_VERSION,
    "source-connection/identity/v1",
  );
  const first = deriveSourceConnectionIdentityKey("fubon", {
    loginId: " user-001 ",
    customerNo: "a-17",
  });
  const sameIdentityDifferentPropertyOrder = deriveSourceConnectionIdentityKey(
    "fubon",
    { customerNo: "A-17", loginId: "USER-001" },
  );
  assert.equal(first, sameIdentityDifferentPropertyOrder);
  // Product stream, session, and authentication mechanics are not inputs to
  // this helper: deposit and loan callers use the same provider login object.
  assert.equal(
    deriveSourceConnectionIdentityKey("fubon", ["USER-001", "A-17"]),
    deriveSourceConnectionIdentityKey("fubon", [" user-001 ", "a-17"]),
  );
  assert.notEqual(
    first,
    deriveSourceConnectionIdentityKey("fubon", {
      loginId: "user-002",
      customerNo: "a-17",
    }),
  );
  assert.notEqual(first, deriveSourceConnectionIdentityKey("yuanta", {
    loginId: "user-001",
    customerNo: "a-17",
  }));
  assert.equal(
    normalizeStableSourceLoginIdentity({ b: "  two  words ", a: "x" }),
    "A=X\u001fB=TWO WORDS",
  );
});
