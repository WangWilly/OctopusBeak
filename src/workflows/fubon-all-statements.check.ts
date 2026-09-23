import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import {
  deriveFubonSourceConnectionKey,
  fubonStableLoginScope,
} from "./fubon-source-connection.ts";

const source = await readFile(
  new URL("./fubon-all-statements.ts", import.meta.url),
  "utf8",
);

assert.match(source, /function signOutFubon/);
assert.match(source, /activateControlWithoutPointer/);
assert.match(source, /logoutNow/);
assert.match(source, /BANK_STATEMENT_CAPABILITIES/);
assert.match(source, /allSupportedStatementTypeIds\(/);
assert.match(source, /BANK_STATEMENT_CAPABILITIES\.fubon/);
assert.match(source, /runSelectedStatements\(selectedIds, \[/);
assert.match(source, /deriveFubonCanonicalHumanAttestation/);
assert.match(source, /FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY/);
assert.match(source, /panFingerprintKey/);
assert.match(source, /canonicalLedgerDir/);
assert.doesNotMatch(source, /canonical(Source|Financial)LedgerDir/);
assert.doesNotMatch(source, /RepaymentRouteInventory/);
assert.doesNotMatch(source, /fubon_card_identity_fingerprint_key/);
assert.match(
  source,
  /typeId: "deposit"[\s\S]*typeId: "credit_card"[\s\S]*typeId: "loan"/,
);
assert.equal(source.match(/await signInFubon\(/g)?.length, 1);
assert.ok(
  source.indexOf("await signInFubon(page, session, input.credentials)") <
    source.indexOf("const run = await runSelectedStatements(selectedIds, ["),
);
assert.match(
  source,
  /finally \{[\s\S]*?stopSessionKeepAlive\(\);[\s\S]*?signOutFubon\(page\)/,
);

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
const workflow = module.default;
const runFubonAllStatements = module.runFubonAllStatements;
assert.equal(workflow.handler, runFubonAllStatements);

const selectionKey = "LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES";
const previousSelection = process.env[selectionKey];
const canonicalDirKey = "OCTOPUSBEAK_CANONICAL_LEDGER_DIR";
const previousCanonicalDir = process.env[canonicalDirKey];
const ledgerDirKey = "LEDGER_DIR";
const previousLedgerDir = process.env[ledgerDirKey];
const managedSecretKey = "LIBRETTO_CLOUD_FUBON_CARD_IDENTITY_FINGERPRINT_KEY";
const previousManagedSecret = process.env[managedSecretKey];
process.env[selectionKey] = "credit_card";
process.env[canonicalDirKey] = "/tmp/fubon-all-statements-canonical-check";
process.env[managedSecretKey] = "synthetic-managed-secret";
const calls: string[] = [];
const page = {
  on: () => calls.push("dialog-listener"),
};
const ctx = { page, session: "fubon-session" };
const admittedEvidence = {
  account: { valueDigest: "sha256:admitted" },
  pages: [],
};
const sourceOnlyEvidence = {
  account: { valueDigest: "sha256:source-only" },
  pages: [],
};
const statements = {
  files: ["deposit.csv"],
  evidence: [admittedEvidence, sourceOnlyEvidence],
  admissions: [
    {
      status: "financial-admitted",
      accountValueDigest: "sha256:admitted",
    },
    {
      status: "source-only",
      accountValueDigest: "sha256:source-only",
    },
  ],
};
const creditCards = { files: ["credit-card.csv"] };
const loans = { files: ["loan.csv"] };
let observedCanonicalDir: string | undefined;
let observedDepositSourceConnectionKey: string | undefined;
let observedLoanSourceConnectionKey: string | undefined;
let observedDepositSourceConnectionScope: string | undefined;
let observedLoanSourceConnectionScope: string | undefined;
let observedLoanCanonicalDir: string | undefined;
let observedPanFingerprintKey:
  { secret: string; keyVersion?: string } | undefined;
let observedCreditCardInput: Record<string, unknown> | undefined;
let output: unknown;
try {
  output = await runFubonAllStatements(
    ctx,
    {
      credentials: {
        fubon_user_id: "id",
        fubon_account: "account",
      },
      statements: {},
      creditCards: {},
      loans: {},
    },
    {
      signInFubon: async (actualPage: unknown, session: string) => {
        assert.equal(actualPage, page);
        assert.equal(session, ctx.session);
        calls.push("login");
      },
      keepBrowserWindowOutOfForeground: async (actualPage: unknown) => {
        assert.equal(actualPage, page);
        calls.push("background");
      },
      startFubonSessionKeepAlive: (actualPage: unknown) => {
        assert.equal(actualPage, page);
        calls.push("keepalive-start");
        return () => calls.push("keepalive-stop");
      },
      runSectionOutOfForeground: async (
        actualPage: unknown,
        section: string,
        run: () => Promise<unknown>,
      ) => {
        assert.equal(actualPage, page);
        calls.push(`section:${section}`);
        return run();
      },
      runFubonStatements: async (
        actualPage: unknown,
        _input: unknown,
        options?: {
          canonicalLedgerDir?: string;
          sourceConnectionKey?: string;
          sourceConnectionScope?: string;
        },
      ) => {
        assert.equal(actualPage, page);
        observedCanonicalDir = options?.canonicalLedgerDir;
        observedDepositSourceConnectionKey = options?.sourceConnectionKey;
        observedDepositSourceConnectionScope = options?.sourceConnectionScope;
        calls.push("deposit");
        return statements;
      },
      runFubonCreditCardStatements: async (
        actualPage: unknown,
        actualInput: unknown,
        options?: {
          panFingerprintKey?: { secret: string; keyVersion?: string };
        },
      ) => {
        assert.equal(actualPage, page);
        observedCreditCardInput = actualInput as Record<string, unknown>;
        observedPanFingerprintKey = options?.panFingerprintKey;
        calls.push("credit-card");
        return creditCards;
      },
      runFubonLoanStatements: async (
        actualPage: unknown,
        _input: unknown,
        options?: {
          canonicalLedgerDir?: string;
          sourceConnectionKey?: string;
          sourceConnectionScope?: string;
        },
      ) => {
        assert.equal(actualPage, page);
        observedLoanCanonicalDir = options?.canonicalLedgerDir;
        observedLoanSourceConnectionKey = options?.sourceConnectionKey;
        observedLoanSourceConnectionScope = options?.sourceConnectionScope;
        calls.push("loan");
        return loans;
      },
      signOutFubon: async (actualPage: unknown) => {
        assert.equal(actualPage, page);
        calls.push("logout");
      },
    },
  );
} finally {
  if (previousSelection === undefined) delete process.env[selectionKey];
  else process.env[selectionKey] = previousSelection;
  if (previousCanonicalDir === undefined) delete process.env[canonicalDirKey];
  else process.env[canonicalDirKey] = previousCanonicalDir;
  if (previousLedgerDir === undefined) delete process.env[ledgerDirKey];
  else process.env[ledgerDirKey] = previousLedgerDir;
  if (previousManagedSecret === undefined) delete process.env[managedSecretKey];
  else process.env[managedSecretKey] = previousManagedSecret;
}

assert.equal(observedCanonicalDir, "/tmp/fubon-all-statements-canonical-check");
assert.equal(observedLoanCanonicalDir, observedCanonicalDir);
assert.equal(
  observedDepositSourceConnectionKey,
  observedLoanSourceConnectionKey,
  "deposit and loan runs must receive the same stable Source Connection key",
);
assert.equal(
  observedDepositSourceConnectionScope,
  observedLoanSourceConnectionScope,
  "deposit and loan runs must receive the same stable login scope",
);
assert.equal(
  observedDepositSourceConnectionKey,
  module.deriveFubonSourceConnectionKey({
    fubon_user_id: "id",
    fubon_account: "account",
  }),
);
assert.equal(
  observedDepositSourceConnectionKey,
  module.deriveFubonSourceConnectionKey({
    fubon_user_id: " ID ",
    fubon_account: " ACCOUNT ",
    fubon_password: "rotated",
  }),
  "password rotation and formatting must not change Source Connection identity",
);
assert.notEqual(
  observedDepositSourceConnectionKey,
  module.deriveFubonSourceConnectionKey({
    fubon_user_id: "other-id",
    fubon_account: "account",
  }),
  "changing the provider login identity must start a new Source Connection",
);
assert.deepEqual(observedPanFingerprintKey, {
  secret: "synthetic-managed-secret",
});
assert.ok(observedCreditCardInput);
const derivedIdentity = module.deriveFubonCanonicalHumanAttestation(
  { fubon_user_id: " id ", fubon_account: " account " },
  "synthetic-managed-secret",
);
assert.equal(
  (observedCreditCardInput?.canonicalHumanAttestation as
    | { sourceConnectionKey?: string }
    | undefined)?.sourceConnectionKey,
  observedDepositSourceConnectionKey,
  "credit-card, deposit, and loan runs must receive one Source Connection key",
);
assert.deepEqual(
  derivedIdentity,
  module.deriveFubonCanonicalHumanAttestation(
    { fubon_user_id: "id", fubon_account: "account" },
    "synthetic-managed-secret",
  ),
  "the same normalized login scope and managed secret must remain stable",
);
assert.deepEqual(
  observedCreditCardInput?.canonicalHumanAttestation,
  derivedIdentity,
  "combined workflow must pass only opaque, automatically derived portfolio identity context",
);
assert.equal(
  derivedIdentity?.identityEpochKey,
  "fubon-credit-card-human-attested-v2",
  "portfolio identity semantics must use the v2 attestation epoch",
);
assert.notEqual(
  derivedIdentity?.sourceConnectionKey,
  module.deriveFubonCanonicalHumanAttestation(
    { fubon_user_id: "other-id", fubon_account: "account" },
    "synthetic-managed-secret",
  )?.sourceConnectionKey,
);
assert.notEqual(
  derivedIdentity?.humanAttestedAccountKey,
  module.deriveFubonCanonicalHumanAttestation(
    { fubon_user_id: "other-id", fubon_account: "account" },
    "synthetic-managed-secret",
  )?.humanAttestedAccountKey,
);
assert.equal(
  derivedIdentity?.sourceConnectionKey,
  module.deriveFubonCanonicalHumanAttestation(
    {
      fubon_user_id: " ID ",
      fubon_account: " ACCOUNT ",
      fubon_password: "rotated",
    },
    "synthetic-managed-secret",
  )?.sourceConnectionKey,
);
assert.equal(
  derivedIdentity?.sourceConnectionKey,
  module.deriveFubonCanonicalHumanAttestation(
    { fubon_user_id: "id", fubon_account: "account" },
    "different-managed-secret",
  )?.sourceConnectionKey,
  "managed-secret rotation must not change Source Connection identity",
);
assert.notEqual(
  derivedIdentity?.humanAttestedAccountKey,
  module.deriveFubonCanonicalHumanAttestation(
    { fubon_user_id: "id", fubon_account: "account" },
    "different-managed-secret",
  )?.humanAttestedAccountKey,
);
assert.doesNotMatch(
  JSON.stringify(derivedIdentity),
  /"id"|"account"|synthetic-managed-secret/iu,
  "derived identity must not return login details or the managed secret",
);
assert.doesNotMatch(
  JSON.stringify(output),
  /synthetic-managed-secret|"fubon_user_id"|"fubon_account"|"fubon_password"/iu,
  "combined workflow output must not expose login details or the managed secret",
);

assert.deepEqual(output, {
  statements,
  creditCards,
  loans,
  componentResults: [
    { typeId: "deposit", status: "success" },
    { typeId: "credit_card", status: "success" },
    { typeId: "loan", status: "success" },
  ],
});
assert.deepEqual(calls, [
  "login",
  "background",
  "keepalive-start",
  "section:statements",
  "deposit",
  "section:creditCards",
  "credit-card",
  "section:loans",
  "loan",
  "keepalive-stop",
  "logout",
]);

for (const selection of ["", "deposit,unknown"]) {
  process.env[selectionKey] = selection;
  process.env[canonicalDirKey] = DEFAULT_LEDGER_DIR;
  delete process.env[ledgerDirKey];
  const selectedCalls: string[] = [];
  let sourceOnlyOptions:
    | { canonicalLedgerDir?: string }
    | undefined;
  try {
    await runFubonAllStatements(
      ctx,
      {
        credentials: {
          fubon_user_id: "source-only-id",
          fubon_account: "source-only-account",
        },
        statements: {},
        creditCards: {},
        loans: {},
      },
      {
        signInFubon: async () => selectedCalls.push("login"),
        keepBrowserWindowOutOfForeground: async () => {},
        startFubonSessionKeepAlive: () => () => {},
        runSectionOutOfForeground: async (
          _page: unknown,
          section: string,
          run: () => Promise<unknown>,
        ) => {
          selectedCalls.push(`section:${section}`);
          return run();
        },
        runFubonStatements: async (
          _page: unknown,
          _input: unknown,
          options?: {
            canonicalLedgerDir?: string;
            sourceConnectionKey?: string;
            sourceConnectionScope?: string;
          },
        ) => {
          sourceOnlyOptions = options;
          selectedCalls.push("deposit");
          return statements;
        },
        runFubonCreditCardStatements: async () => {
          selectedCalls.push("credit-card");
          return creditCards;
        },
        runFubonLoanStatements: async () => {
          selectedCalls.push("loan");
          return loans;
        },
        signOutFubon: async () => {},
      },
    );
  } finally {
    if (previousSelection === undefined) delete process.env[selectionKey];
    else process.env[selectionKey] = previousSelection;
    if (previousCanonicalDir === undefined) delete process.env[canonicalDirKey];
    else process.env[canonicalDirKey] = previousCanonicalDir;
    if (previousLedgerDir === undefined) delete process.env[ledgerDirKey];
    else process.env[ledgerDirKey] = previousLedgerDir;
  }
  assert.deepEqual(sourceOnlyOptions, {
    canonicalLedgerDir: DEFAULT_LEDGER_DIR,
    sourceConnectionScope: fubonStableLoginScope({
      fubon_user_id: "source-only-id",
      fubon_account: "source-only-account",
    }),
    sourceConnectionKey: deriveFubonSourceConnectionKey({
      fubon_user_id: "source-only-id",
      fubon_account: "source-only-account",
    }),
  });
  assert.deepEqual(selectedCalls, [
    "login",
    "section:statements",
    "deposit",
    "section:creditCards",
    "credit-card",
    "section:loans",
    "loan",
  ]);
}

// Control characters in the canonical path are invalid and must fail before
// login. There is only one production ledger setting, so no alias conflict
// can be silently selected.
process.env[canonicalDirKey] = "\ninvalid";
let invalidLoginCalled = false;
try {
  await assert.rejects(
    () =>
      runFubonAllStatements(
        ctx,
        { credentials: {}, statements: {}, creditCards: {}, loans: {} },
        {
          signInFubon: async () => {
            invalidLoginCalled = true;
          },
        },
      ),
    /Invalid Fubon ledger directory/,
  );
} finally {
  if (previousSelection === undefined) delete process.env[selectionKey];
  else process.env[selectionKey] = previousSelection;
  if (previousCanonicalDir === undefined) delete process.env[canonicalDirKey];
  else process.env[canonicalDirKey] = previousCanonicalDir;
  if (previousLedgerDir === undefined) delete process.env[ledgerDirKey];
  else process.env[ledgerDirKey] = previousLedgerDir;
}
assert.equal(invalidLoginCalled, false);
