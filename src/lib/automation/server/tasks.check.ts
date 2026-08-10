import assert from "node:assert/strict";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
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
assert.deepEqual(
  AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "fubon")?.statementTypes,
  [{ id: "deposit" }, { id: "credit_card" }, { id: "loan" }],
);
assert.equal(
  AUTOMATION_NON_SECRET_KEYS.includes("LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES"),
  true,
);
for (const group of AUTOMATION_CREDENTIAL_GROUPS) {
  assert.deepEqual(group.credentialKeys, group.credentialFields.map((field) => field.key));
  assert.ok(group.displayName.en);
  assert.ok(group.displayName["zh-TW"]);
  assert.ok(group.setupGuide.summary.en);
  assert.ok(group.setupGuide.summary["zh-TW"]);
  assert.ok(group.setupGuide.links.length > 0);
  for (const guideLink of group.setupGuide.links) {
    const urls = [guideLink.url, guideLink.englishUrl].filter(Boolean) as string[];
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
  AUTOMATION_CREDENTIAL_GROUPS.flatMap((group) => group.credentialFields.map((field) => [field.key, field] as const)),
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
const yuantaSecuritiesFields = AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "yuanta-trade")?.credentialFields ?? [];
assert.equal(yuantaSecuritiesFields.some((field) => field.key.endsWith("_ACCOUNT")), false);
assert.equal(fieldsByKey.get("LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD")?.input, "password");
assert.deepEqual(fieldsByKey.get("LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD")?.label, {
  en: "Yuanta Securities password",
  "zh-TW": "元大證券登入密碼",
});
assert.equal(fieldsByKey.get("LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH")?.input, "certificate-file");
assert.equal(fieldsByKey.get("LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD")?.input, "password");
assert.equal(fieldsByKey.get("MAX_SUB_ACCOUNT")?.redaction, "none");
assert.equal(
  AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "yuanta-trade")
    ?.credentialFields.find((credentialField) => credentialField.key.endsWith("CA_PATH"))?.input,
  "certificate-file",
);
assert.equal(
  enabledAutomationTasks(Object.fromEntries([
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
  ].map((id) => [id, false]))).some(({ id }) => id === task.id),
  true,
);
