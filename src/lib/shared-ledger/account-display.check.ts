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
    stream: "credit-card",
    accountNo: "sha256:account-b",
    accountType: "credit" as const,
  },
  {
    accountId: "account-a",
    integrationNamespace: "yuanta",
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
      stream: "domestic-deposit",
      accountNo: "001234567890",
      accountType: "depository",
    },
    {
      accountId: "account-b",
      integrationNamespace: "cathay",
      stream: "domestic-deposit",
      accountNo: "000000789012",
      accountType: "depository",
    },
    {
      accountId: "loan-account",
      integrationNamespace: "yuanta",
      stream: "loan",
      accountNo: "000000000123",
      accountType: "loan",
    },
    {
      accountId: "broker-account",
      integrationNamespace: "yuanta-trade",
      stream: "brokerage",
      accountNo: "000000004567",
      accountType: "investment",
    },
  ]);
  assert.equal(displays.get("account-a")?.label, "Cathay United Bank · Bank account · 001234567890");
  assert.equal(displays.get("account-b")?.label, "Cathay United Bank · Bank account · 000000789012");
  assert.equal(displays.get("loan-account")?.label, "Yuanta Bank · Loan · 000000000123");
  assert.equal(displays.get("broker-account")?.label, "Yuanta Securities · Brokerage account · 000000004567");
});

test("missing MaiCoin identifiers remain human and distinct without exposing a source key", () => {
  const displays = buildAccountDisplayMap([
    {
      accountId: "account-b",
      integrationNamespace: "maicoin",
      stream: "crypto",
      accountNo: null,
      accountType: "investment",
      investmentSubtype: "crypto_exchange",
    },
    {
      accountId: "account-a",
      integrationNamespace: "maicoin",
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
      label: "yuanta 001234567890",
      integrationNamespace: "yuanta",
      stream: "domestic-deposit",
      accountNo: "001234567890",
    }),
    "Yuanta Bank · Bank account · 001234567890",
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
