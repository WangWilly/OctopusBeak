import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cardIdentitySecretVerifier } from "../../shared-identity/card-identity-secret.ts";
import {
  CARD_IDENTITY_VERIFIER_FILE,
  provisionCardIdentitySecretAtStartup,
  readCardIdentityVerifier,
} from "./card-identity-verifier.ts";
import {
  AUTOMATION_CREDENTIALS_FILE,
  AUTOMATION_CREDENTIALS_FORMAT,
  CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY,
  createAutomationCredentialStore,
  type AutomationCredentialCodec,
} from "./config-files.ts";
import { eraseSignInDetails } from "./sign-in-erasure.ts";

const codec: AutomationCredentialCodec = {
  encrypt: (text) => Buffer.from(text, "utf8").toString("base64"),
  decrypt: (payload) => Buffer.from(payload, "base64").toString("utf8"),
};
/** As after a Keychain reset: the envelope is intact, but nothing can decrypt it. */
const lostKeychain: AutomationCredentialCodec = {
  encrypt: codec.encrypt,
  decrypt: () => {
    throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
  },
};

async function withUserData(run: (root: string) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), "card-identity-verifier-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("startup gives a new install its Card identity secret and records only its verifier", () => withUserData((root) => {
  const credentials = createAutomationCredentialStore(join(root, AUTOMATION_CREDENTIALS_FILE), codec);
  const verifierPath = join(root, CARD_IDENTITY_VERIFIER_FILE);
  const logged: string[] = [];

  provisionCardIdentitySecretAtStartup(credentials, verifierPath, (code) => logged.push(code));

  const secret = credentials.read()[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]!;
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(readCardIdentityVerifier(verifierPath), { verifier: cardIdentitySecretVerifier(secret), created: true });
  assert.doesNotMatch(readFileSync(verifierPath, "utf8"), new RegExp(secret, "u"), "the worker's file never holds the secret");
  assert.deepEqual(logged, []);

  provisionCardIdentitySecretAtStartup(credentials, verifierPath, (code) => assert.fail(code));
  assert.equal(credentials.read()[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY], secret, "a second start keeps the secret");
  assert.deepEqual(readCardIdentityVerifier(verifierPath), { verifier: cardIdentitySecretVerifier(secret), created: true }, "and remembers it created it");
}));

test("a secret already in credentials.json when the record is first written counts as found", () => withUserData((root) => {
  const credentials = createAutomationCredentialStore(join(root, AUTOMATION_CREDENTIALS_FILE), codec);
  const secret = "b".repeat(43);
  credentials.write({ [CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]: secret });
  const verifierPath = join(root, CARD_IDENTITY_VERIFIER_FILE);

  provisionCardIdentitySecretAtStartup(credentials, verifierPath, (code) => assert.fail(code));

  assert.deepEqual(readCardIdentityVerifier(verifierPath), { verifier: cardIdentitySecretVerifier(secret), created: false });
}));

test("startup with credentials the Keychain cannot decrypt opens and leaves them untouched", () => withUserData((root) => {
  const path = join(root, AUTOMATION_CREDENTIALS_FILE);
  const verifierPath = join(root, CARD_IDENTITY_VERIFIER_FILE);
  const readable = createAutomationCredentialStore(path, codec);
  provisionCardIdentitySecretAtStartup(readable, verifierPath, () => {});
  const envelope = readFileSync(path, "utf8");
  const verifier = readFileSync(verifierPath, "utf8");
  const logged: string[] = [];

  provisionCardIdentitySecretAtStartup(createAutomationCredentialStore(path, lostKeychain), verifierPath, (code) => logged.push(code));

  assert.deepEqual(logged, ["automation-card-identity-secret-unprovisioned"]);
  assert.equal(readFileSync(path, "utf8"), envelope, "the unreadable envelope stays until the person clears it");
  assert.equal(readFileSync(verifierPath, "utf8"), verifier);
}));

test("startup with credentials that are not JSON opens and leaves them untouched", () => withUserData((root) => {
  const path = join(root, AUTOMATION_CREDENTIALS_FILE);
  writeFileSync(path, "{ truncated");
  const logged: string[] = [];

  provisionCardIdentitySecretAtStartup(createAutomationCredentialStore(path, codec), join(root, CARD_IDENTITY_VERIFIER_FILE), (code) => logged.push(code));

  assert.deepEqual(logged, ["automation-card-identity-secret-unprovisioned"]);
  assert.equal(readFileSync(path, "utf8"), "{ truncated");
  assert.equal(existsSync(join(root, CARD_IDENTITY_VERIFIER_FILE)), false);
}));

test("clearing unreadable sign-in details replaces them and records the new secret's verifier", () => withUserData((root) => {
  const path = join(root, AUTOMATION_CREDENTIALS_FILE);
  const verifierPath = join(root, CARD_IDENTITY_VERIFIER_FILE);
  provisionCardIdentitySecretAtStartup(createAutomationCredentialStore(path, codec), verifierPath, () => {});
  const before = readCardIdentityVerifier(verifierPath);
  // The Keychain is reset: the old envelope can no longer be decrypted, and new writes use the new key.
  writeFileSync(path, JSON.stringify({ format: AUTOMATION_CREDENTIALS_FORMAT, data: "bG9zdA==" }));
  const credentials = createAutomationCredentialStore(path, codec);
  assert.throws(() => credentials.read());

  // A legacy .env whose credential lines waited for readable credentials.
  writeFileSync(join(root, ".env"), "# keep\nLIBRETTO_CLOUD_FUBON_PASSWORD=legacy-pw\nUNKNOWN=value\n");

  eraseSignInDetails({ credentials, userDataDirectory: root });

  assert.equal(readFileSync(join(root, ".env"), "utf8"), "# keep\nUNKNOWN=value\n", "a cleared credential cannot migrate back");
  const secret = credentials.read()[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]!;
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(readCardIdentityVerifier(verifierPath), { verifier: cardIdentitySecretVerifier(secret), created: true });
  assert.notEqual(readCardIdentityVerifier(verifierPath)?.verifier, before?.verifier, "the ledger sees the new secret and asks for a Canonical Reset");
}));

test("clearing sign-in details that cannot be reached keeps them and fails", () => withUserData((root) => {
  const path = join(root, AUTOMATION_CREDENTIALS_FILE);
  const credentials = createAutomationCredentialStore(path, codec);
  provisionCardIdentitySecretAtStartup(credentials, join(root, CARD_IDENTITY_VERIFIER_FILE), () => {});
  const envelope = readFileSync(path, "utf8");
  chmodSync(path, 0o000);
  try {
    assert.throws(() => eraseSignInDetails({ credentials, userDataDirectory: root }), { code: "EACCES" });
  } finally {
    chmodSync(path, 0o600);
  }
  assert.equal(readFileSync(path, "utf8"), envelope, "an unreachable file is not mistaken for an undecodable one");
}));

test("a missing or damaged verifier record reads as none", () => withUserData((root) => {
  const verifierPath = join(root, CARD_IDENTITY_VERIFIER_FILE);
  assert.equal(readCardIdentityVerifier(verifierPath), undefined);
  writeFileSync(verifierPath, "not-a-verifier\n");
  assert.equal(readCardIdentityVerifier(verifierPath), undefined);
  writeFileSync(verifierPath, JSON.stringify({ verifier: "a".repeat(64) }));
  assert.equal(readCardIdentityVerifier(verifierPath), undefined);
}));
