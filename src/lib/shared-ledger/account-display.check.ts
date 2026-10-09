import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAccountDisplayMap,
  containsInternalAccountIdentifier,
  safeSourceGapLabel,
  sourceGapCounts,
} from "./account-display.ts";

const opaqueAccounts = [
  {
    accountId: "account-b",
    integrationNamespace: "yuanta",
    institutionKey: "yuanta-bank" as const,
    stream: "credit-card",
    accountNo: "sha256:account-b",
    accountType: "credit" as const,
  },
  {
    accountId: "account-a",
    integrationNamespace: "yuanta",
    institutionKey: "yuanta-bank" as const,
    stream: "credit-card",
    accountNo: "sha256:account-a",
    accountType: "credit" as const,
  },
];

test("canonical account display hides opaque identity and numbers credit accounts", () => {
  const displays = buildAccountDisplayMap(opaqueAccounts);
  const first = displays.get("account-a")?.label;
  const second = displays.get("account-b")?.label;
  assert.equal(first, "Yuanta Bank · Credit card account · Account 1");
  assert.equal(second, "Yuanta Bank · Credit card account · Account 2");
  assert.notEqual(first, second);
  assert.doesNotMatch(`${first} ${second}`, /sha256:/iu);
  assert.equal(displays.get("account-a")?.institution, "Yuanta Bank");
  assert.equal(displays.get("account-a")?.product, "Credit card account");
});

test("source-proven credit portfolio numbers remain complete without becoming card masks", () => {
  const displays = buildAccountDisplayMap([
    {
      accountId: "account-a",
      integrationNamespace: "yuanta",
      institutionKey: "yuanta-bank" as const,
      stream: "credit-card",
      accountNo: "PORTFOLIO-00001234",
      accountType: "credit",
    },
  ]);
  assert.equal(displays.get("account-a")?.label, "Yuanta Bank · Credit card account · PORTFOLIO-00001234");
  assert.doesNotMatch(displays.get("account-a")?.label ?? "", /\*\*\*\*/u);
});

test("associated credit-card masks decorate a credit account without exposing a PAN", () => {
  const displays = buildAccountDisplayMap([
    {
      accountId: "account-a",
      integrationNamespace: "fubon",
      institutionKey: "fubon" as const,
      stream: "credit-card",
      accountNo: null,
      accountType: "credit",
      cardMasks: ["****5678", "****1234", "not-a-card-number"],
    },
  ]);
  assert.equal(
    displays.get("account-a")?.label,
    "Taipei Fubon Bank · Credit card account · ****1234, ****5678",
  );
  assert.doesNotMatch(displays.get("account-a")?.label ?? "", /sha256:|\b\d{13,19}\b/iu);
});

test("credit masks supplement a proven portfolio identifier", () => {
  const displays = buildAccountDisplayMap([
    {
      accountId: "account-a",
      integrationNamespace: "esun",
      institutionKey: "esun" as const,
      stream: "credit-card",
      accountNo: "PORTFOLIO-0001",
      accountType: "credit",
      cardMasks: ["****9876"],
    },
  ]);
  assert.equal(
    displays.get("account-a")?.label,
    "E.SUN Bank · Credit card account · PORTFOLIO-0001, ****9876",
  );
});

test("provider account numbers remain complete, including leading zeroes", () => {
  const displays = buildAccountDisplayMap([
    {
      accountId: "account-a",
      integrationNamespace: "cathay",
      institutionKey: "cathay" as const,
      stream: "domestic-deposit",
      accountNo: "001234567",
      accountType: "depository",
    },
    {
      accountId: "account-b",
      integrationNamespace: "cathay",
      institutionKey: "cathay" as const,
      stream: "domestic-deposit",
      accountNo: "000789012",
      accountType: "depository",
    },
    {
      accountId: "loan-account",
      integrationNamespace: "yuanta",
      institutionKey: "yuanta-bank" as const,
      stream: "loan",
      accountNo: "000000123",
      accountType: "loan",
    },
    {
      accountId: "broker-account",
      integrationNamespace: "yuanta-trade",
      institutionKey: "yuanta-securities" as const,
      stream: "brokerage",
      accountNo: "000004567",
      accountType: "investment",
    },
  ]);
  assert.equal(displays.get("account-a")?.label, "Cathay United Bank · Bank account · 001234567");
  assert.equal(displays.get("account-b")?.label, "Cathay United Bank · Bank account · 000789012");
  assert.equal(displays.get("loan-account")?.label, "Yuanta Bank · Loan · 000000123");
  assert.equal(displays.get("broker-account")?.label, "Yuanta Securities · Brokerage account · 000004567");
});

test("missing MaiCoin identifiers remain human and distinct without exposing a source key", () => {
  const displays = buildAccountDisplayMap([
    {
      accountId: "account-b",
      integrationNamespace: "maicoin",
      institutionKey: "maicoin" as const,
      stream: "crypto",
      accountNo: null,
      accountType: "investment",
      investmentSubtype: "crypto_exchange",
    },
    {
      accountId: "account-a",
      integrationNamespace: "maicoin",
      institutionKey: "maicoin" as const,
      stream: "crypto",
      accountNo: null,
      accountType: "investment",
      investmentSubtype: "crypto_exchange",
    },
  ]);
  assert.equal(displays.get("account-a")?.label, "MaiCoin · Crypto account · Account 1");
  assert.equal(displays.get("account-b")?.label, "MaiCoin · Crypto account · Account 2");
  assert.doesNotMatch(`${displays.get("account-a")?.label} ${displays.get("account-b")?.label}`, /sha256:/iu);
});

test("source gap fallback never renders a source connection key or opaque account token", () => {
  const label = safeSourceGapLabel({
    label: "yuanta sha256:legacy-account",
    integrationNamespace: "yuanta",
    stream: "credit-card",
    accountNo: "sha256:legacy-account",
  });
  assert.equal(label, "Yuanta Bank · Credit card account");
  assert.doesNotMatch(label, /sha256:/iu);
  assert.equal(
    safeSourceGapLabel({
      label: "yuanta sha256:legacy-portfolio-key",
      integrationNamespace: "yuanta",
      stream: "credit-card",
      accountNo: "PORTFOLIO-00001234",
    }),
    "Yuanta Bank · Credit card account · PORTFOLIO-00001234",
  );
  assert.equal(safeSourceGapLabel({ label: "sha256:source-connection" }), "Source not identified");
  assert.equal(
    safeSourceGapLabel({
      label: "yuanta 001234567",
      integrationNamespace: "yuanta",
      stream: "domestic-deposit",
      accountNo: "001234567",
    }),
    "Yuanta Bank · Bank account · 001234567",
  );
  assert.equal(containsInternalAccountIdentifier("sha256:source-connection"), true);
  assert.equal(containsInternalAccountIdentifier("Account 2026"), false);
});

test("source gap counts distinguish account values from uncollected sources", () => {
  assert.deepEqual(sourceGapCounts([
    { reason: "current-value-not-observed" },
    { reason: "current-value-not-observed" },
    { reason: "source-not-collected" },
    { reason: "canonical-read-unavailable" },
  ]), {
    currentValue: 2,
    sourceNotCollected: 1,
    canonicalReadUnavailable: 1,
  });
});

test("an Intermediary-source account shows its stored Institution, never the source namespace", () => {
  const displays = buildAccountDisplayMap([
    {
      accountId: "taishin-settlement",
      integrationNamespace: "tdcc",
      institutionKey: "bank-812",
      stream: "domestic-deposit",
      accountNo: "200123456",
      accountType: "depository",
    },
    {
      accountId: "sinopac-broker",
      integrationNamespace: "tdcc",
      institutionKey: "broker-9A00",
      stream: "investment",
      accountNo: "9A00-1234567",
      accountType: "investment",
    },
  ]);
  assert.deepEqual(displays.get("taishin-settlement"), {
    label: "Taishin International Bank · Bank account · 200123456",
    institution: "Taishin International Bank",
    product: "Bank account",
  });
  assert.equal(displays.get("sinopac-broker")?.institution, "永豐金");
  assert.equal(displays.get("sinopac-broker")?.label, "永豐金 · Investment account · 9A00-1234567");
  assert.doesNotMatch([...displays.values()].map((display) => display.label).join(" "), /tdcc/iu);
});

test("same-numbered TDCC accounts at different Institutions take no duplicate ordinal", () => {
  const settlement = (accountId: string, institutionKey: "cathay" | "bank-812") => ({
    accountId,
    integrationNamespace: "tdcc",
    institutionKey,
    stream: "domestic-deposit",
    accountNo: "200123456",
    accountType: "depository" as const,
  });
  const displays = buildAccountDisplayMap([settlement("a", "cathay"), settlement("b", "bank-812")]);
  assert.equal(displays.get("a")?.label, "Cathay United Bank · Bank account · 200123456");
  assert.equal(displays.get("b")?.label, "Taishin International Bank · Bank account · 200123456");
});

test("a covered Intermediary-source account leaves its direct-source twin's label as it was", () => {
  const direct = {
    accountId: "fubon-direct",
    integrationNamespace: "fubon",
    institutionKey: "fubon" as const,
    stream: "domestic-deposit",
    accountNo: "00112233",
    accountType: "depository" as const,
  };
  const alone = buildAccountDisplayMap([direct]).get("fubon-direct");
  const withCovered = buildAccountDisplayMap([
    direct,
    { ...direct, accountId: "fubon-via-tdcc", integrationNamespace: "tdcc" },
  ]);
  assert.deepEqual(withCovered.get("fubon-direct"), alone);
  assert.equal(alone?.label, "Taipei Fubon Bank · Bank account · 00112233");
  assert.equal(withCovered.get("fubon-via-tdcc")?.label, "Taipei Fubon Bank · Bank account · 00112233");
});

test("an Intermediary-source gap names the account's Institution, or the source when no account exists", () => {
  assert.equal(
    safeSourceGapLabel({ integrationNamespace: "tdcc", institutionKey: "bank-812", stream: "investment-fund" }),
    "Taishin International Bank · Fund",
  );
  assert.equal(safeSourceGapLabel({ integrationNamespace: "tdcc", stream: "investment-fund" }), "TDCC e-Passbook · Fund");
  assert.equal(
    safeSourceGapLabel({ label: "TDCC e-Passbook · fund", integrationNamespace: "tdcc", stream: "investment-fund" }),
    "TDCC e-Passbook · fund",
  );
  assert.equal(safeSourceGapLabel({ integrationNamespace: "unknown-source", stream: "domestic-deposit" }), "Source not identified");
});
