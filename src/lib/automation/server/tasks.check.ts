import assert from "node:assert/strict";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_MANAGED_SECRET_KEYS,
  AUTOMATION_NON_SECRET_KEYS,
  enabledAutomationTasks,
  taskById,
} from "./tasks.ts";

const task = taskById("exchange-rates");

assert.ok(task);
assert.equal(task.kind, "sync");
assert.equal(task.credentialGroupId, undefined);
assert.deepEqual(task.credentialKeys, []);
assert.deepEqual(task.command, [
  "node",
  "--no-warnings",
  "--experimental-strip-types",
  "src/ledger/sync-exchange-rates.ts",
]);
const yuantaAllStatements = taskById("yuanta-all-statements");
assert.ok(yuantaAllStatements);
assert.equal(yuantaAllStatements.id, "yuanta-all-statements");
assert.equal(yuantaAllStatements.script, "run:yuanta-all-statements");
assert.deepEqual(yuantaAllStatements.command, [
  "libretto",
  "run",
  "src/workflows/yuanta-all-statements.ts",
  "--headless",
  "--params",
  '{"statements":{"telemetry":true}}',
]);
const fubonAuthMenuDiagnostic = taskById("fubon-auth-menu-diagnostic");
assert.ok(fubonAuthMenuDiagnostic);
assert.equal(fubonAuthMenuDiagnostic.credentialGroupId, "fubon");
assert.equal(fubonAuthMenuDiagnostic.script, "run:fubon-auth-menu-diagnostic");
assert.deepEqual(fubonAuthMenuDiagnostic.command, [
  "libretto",
  "run",
  "src/workflows/fubon-auth-menu-diagnostic.ts",
  "--headless",
]);
const fubonApprovedLoanMenuDiagnostic = taskById(
  "fubon-approved-loan-menu-diagnostic",
);
assert.ok(fubonApprovedLoanMenuDiagnostic);
assert.equal(fubonApprovedLoanMenuDiagnostic.credentialGroupId, "fubon");
assert.deepEqual(fubonApprovedLoanMenuDiagnostic.command, [
  "libretto",
  "run",
  "src/workflows/fubon-auth-menu-diagnostic.ts",
  "--headless",
  "--params",
  '{"expandApprovedMenu":"loan"}',
]);
const yuantaAuthMenuDiagnostic = taskById("yuanta-auth-menu-diagnostic");
assert.ok(yuantaAuthMenuDiagnostic);
assert.equal(yuantaAuthMenuDiagnostic.credentialGroupId, "yuanta");
assert.equal(yuantaAuthMenuDiagnostic.script, "run:yuanta-auth-menu-diagnostic");
assert.deepEqual(yuantaAuthMenuDiagnostic.command, [
  "libretto",
  "run",
  "src/workflows/yuanta-auth-menu-diagnostic.ts",
  "--headless",
]);
const yuantaApprovedFunctionOverviewDiagnostic = taskById(
  "yuanta-approved-function-overview-diagnostic",
);
assert.ok(yuantaApprovedFunctionOverviewDiagnostic);
assert.equal(yuantaApprovedFunctionOverviewDiagnostic.credentialGroupId, "yuanta");
assert.deepEqual(yuantaApprovedFunctionOverviewDiagnostic.command, [
  "libretto",
  "run",
  "src/workflows/yuanta-auth-menu-diagnostic.ts",
  "--headless",
  "--params",
  '{"expandApprovedMenu":"function-overview"}',
]);
const cathayAllStatements = taskById("cathay-all-statements");
assert.ok(cathayAllStatements);
assert.equal(cathayAllStatements.id, "cathay-all-statements");
assert.equal(cathayAllStatements.script, "run:cathay-all-statements");
assert.deepEqual(cathayAllStatements.command, [
  "libretto",
  "run",
  "src/workflows/cathay-all-statements.ts",
  "--headless",
  "--params",
  '{"telemetry":true}',
]);
assert.deepEqual(
  AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "yuanta")
    ?.statementTypes,
  [
    { id: "deposit" },
    { id: "foreign_currency" },
    { id: "credit_card" },
    { id: "loan" },
    { id: "fund" },
  ],
);
const hncbStatements = taskById("hncb-statements");
assert.ok(hncbStatements);
assert.equal(hncbStatements.id, "hncb-statements");
assert.equal(hncbStatements.script, "run:hncb-statements");
assert.deepEqual(hncbStatements.command, [
  "libretto",
  "run",
  "src/workflows/hncb-statements.ts",
  "--headless",
]);
const ctbcStatements = taskById("ctbc-statements");
assert.ok(ctbcStatements);
assert.equal(ctbcStatements.id, "ctbc-statements");
assert.equal(ctbcStatements.script, "run:ctbc-statements");
assert.deepEqual(ctbcStatements.command, [
  "libretto",
  "run",
  "src/workflows/ctbc-statements.ts",
  "--headless",
  "--params",
  '{"telemetry":true}',
]);
const postStatements = taskById("post-statements");
assert.ok(postStatements);
assert.equal(postStatements.id, "post-statements");
assert.equal(postStatements.script, "run:post-statements");
assert.deepEqual(postStatements.command, [
  "libretto",
  "run",
  "src/workflows/post-statements.ts",
  "--headless",
  "--params",
  '{"telemetry":true}',
]);
assert.deepEqual(
  AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "sinopac")
    ?.statementTypes,
  [{ id: "accounts" }],
);
assert.deepEqual(
  AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "fubon")
    ?.statementTypes,
  [{ id: "deposit" }, { id: "credit_card" }, { id: "loan" }],
);
const fubonGroup = AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "fubon");
assert.ok(fubonGroup);
assert.equal(
  fubonGroup.credentialFields.some((field) =>
    field.key.includes("IDENTITY_FINGERPRINT"),
  ),
  false,
);
assert.deepEqual(AUTOMATION_MANAGED_SECRET_KEYS, [
  "LIBRETTO_CLOUD_FUBON_CARD_IDENTITY_FINGERPRINT_KEY",
]);
assert.deepEqual(
  taskById("fubon-all-statements")?.credentialKeys,
  fubonGroup.credentialFields.map((field) => field.key),
);
assert.equal(
  AUTOMATION_NON_SECRET_KEYS.includes("LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES"),
  true,
);
for (const group of AUTOMATION_CREDENTIAL_GROUPS) {
  assert.deepEqual(
    group.credentialKeys,
    group.credentialFields.map((field) => field.key),
  );
  assert.ok(group.displayName.en);
  assert.ok(group.displayName["zh-TW"]);
  assert.ok(group.setupGuide.summary.en);
  assert.ok(group.setupGuide.summary["zh-TW"]);
  assert.ok(group.setupGuide.links.length > 0);
  for (const guideLink of group.setupGuide.links) {
    const urls = [guideLink.url, guideLink.englishUrl].filter(
      Boolean,
    ) as string[];
    for (const value of urls) {
      const url = new URL(value);
      assert.equal(url.protocol, "https:");
      assert.ok(guideLink.allowedHosts.includes(url.hostname));
    }
  }
}

const taiwanIdKeys = [
  "LIBRETTO_CLOUD_FUBON_USER_ID",
  "LIBRETTO_CLOUD_ESUN_USER_ID",
  "LIBRETTO_CLOUD_YUANTA_USER_ID",
  "LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID",
  "LIBRETTO_CLOUD_CATHAY_USER_ID",
  "LIBRETTO_CLOUD_HNCB_USER_ID",
  "LIBRETTO_CLOUD_CTBC_USER_ID",
  "LIBRETTO_CLOUD_POST_USER_ID",
  "LIBRETTO_CLOUD_SINOPAC_USER_ID",
  "LIBRETTO_CLOUD_LINEBANK_USER_ID",
];
const onlineBankingCodeKeys = [
  "LIBRETTO_CLOUD_FUBON_ACCOUNT",
  "LIBRETTO_CLOUD_ESUN_ACCOUNT",
  "LIBRETTO_CLOUD_YUANTA_ACCOUNT",
  "LIBRETTO_CLOUD_CATHAY_ACCOUNT",
  "LIBRETTO_CLOUD_HNCB_ACCOUNT",
  "LIBRETTO_CLOUD_CTBC_ACCOUNT",
  "LIBRETTO_CLOUD_POST_ACCOUNT",
  "LIBRETTO_CLOUD_SINOPAC_ACCOUNT",
  "LIBRETTO_CLOUD_LINEBANK_ACCOUNT",
];
const fieldsByKey = new Map(
  AUTOMATION_CREDENTIAL_GROUPS.flatMap((group) =>
    group.credentialFields.map((field) => [field.key, field] as const),
  ),
);

assert.equal(taiwanIdKeys.length, 10);
assert.equal(onlineBankingCodeKeys.length, 9);
for (const key of taiwanIdKeys) {
  assert.equal(fieldsByKey.get(key)?.input, "text");
  assert.equal(fieldsByKey.get(key)?.redaction, "partial");
}
for (const key of onlineBankingCodeKeys) {
  assert.equal(fieldsByKey.get(key)?.input, "password");
  assert.equal(fieldsByKey.get(key)?.redaction, "full");
}
const yuantaSecuritiesFields =
  AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "yuanta-trade")
    ?.credentialFields ?? [];
assert.equal(
  yuantaSecuritiesFields.some((field) => field.key.endsWith("_ACCOUNT")),
  false,
);
assert.equal(
  fieldsByKey.get("LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD")?.input,
  "password",
);
assert.deepEqual(
  fieldsByKey.get("LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD")?.label,
  {
    en: "Yuanta Securities password",
    "zh-TW": "元大證券登入密碼",
  },
);
assert.equal(
  fieldsByKey.get("LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH")?.input,
  "certificate-file",
);
assert.equal(
  fieldsByKey.get("LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD")?.input,
  "password",
);
assert.equal(fieldsByKey.get("MAX_SUB_ACCOUNT")?.redaction, "none");
assert.equal(
  AUTOMATION_CREDENTIAL_GROUPS.find(
    (group) => group.id === "yuanta-trade",
  )?.credentialFields.find((credentialField) =>
    credentialField.key.endsWith("CA_PATH"),
  )?.input,
  "certificate-file",
);
assert.equal(
  enabledAutomationTasks(
    Object.fromEntries(
      [
        "fubon",
        "esun",
        "yuanta",
        "yuanta-trade",
        "cathay",
        "hncb",
        "ctbc",
        "post",
        "sinopac",
        "linebank",
        "einvoice",
        "maicoin",
      ].map((id) => [id, false]),
    ),
  ).some(({ id }) => id === task.id),
  true,
);
