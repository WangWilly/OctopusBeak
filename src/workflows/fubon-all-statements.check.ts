import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const source = await readFile(new URL("./fubon-all-statements.ts", import.meta.url), "utf8");
assert.doesNotMatch(source, /from ["']libretto["']|export default workflow\(/u);
assert.doesNotMatch(source, /export async function runFubonAllStatements\(/u);
assert.match(source, /export async function runFubonAllStatementsWorkflow\(/u);

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-fubon-all-statements-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const module = await server
  .ssrLoadModule("/src/workflows/fubon-all-statements.ts")
  .finally(() => server.close());

assert.equal(typeof module.runFubonAllStatementsWorkflow, "function");
assert.equal("default" in module, false, "the App provider has no Libretto workflow default export");

const credentials = { fubon_user_id: "synthetic-id", fubon_account: "synthetic-account" };
const sourceConnectionKey = module.deriveFubonSourceConnectionKey(credentials);
assert.equal(typeof sourceConnectionKey, "string");
assert.equal(
  sourceConnectionKey,
  module.deriveFubonSourceConnectionKey({
    fubon_user_id: " SYNTHETIC-ID ",
    fubon_account: " SYNTHETIC-ACCOUNT ",
    fubon_password: "rotated-secret",
  }),
  "password rotation and login formatting do not change Source Connection identity",
);
assert.notEqual(
  sourceConnectionKey,
  module.deriveFubonSourceConnectionKey({
    fubon_user_id: "other-id",
    fubon_account: "synthetic-account",
  }),
  "a changed provider login identity starts a new Source Connection",
);

const attestation = module.deriveFubonCanonicalHumanAttestation(
  credentials,
  "synthetic-managed-secret",
);
assert.equal(attestation?.sourceConnectionKey, sourceConnectionKey);
assert.equal(attestation?.identityEpochKey, "fubon-credit-card-human-attested-v2");
assert.notEqual(
  attestation?.humanAttestedAccountKey,
  module.deriveFubonCanonicalHumanAttestation(
    credentials,
    "rotated-managed-secret",
  )?.humanAttestedAccountKey,
);
