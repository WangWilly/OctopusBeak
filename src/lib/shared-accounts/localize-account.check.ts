import assert from "node:assert/strict";
import test from "node:test";
import { translations } from "../i18n/i18n.ts";
import type { AccountRowDto } from "../shared-ledger/types.ts";
import { accountModalTitle, localizeAccount } from "./localize-account.ts";

function account(overrides: Partial<AccountRowDto>): AccountRowDto {
  return {
    id: "account-a",
    label: "Cathay United Bank · Bank account · Account 1",
    institution: "Cathay United Bank",
    institutionKey: "cathay",
    product: "Bank account",
    group: "asset",
    kind: "bank",
    typeLabel: "Bank",
    amountLines: [],
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: null,
    valueAvailability: "available",
    ...overrides,
  };
}

test("an account without an identifier reads its fallback in the interface language", () => {
  const unidentified = account({ unidentifiedOrdinal: 1 });
  assert.equal(localizeAccount(unidentified, translations["zh-TW"]).label, "國泰世華銀行 · 銀行帳戶 · 帳戶 1");
  assert.equal(localizeAccount(unidentified, translations.en).label, "Cathay United Bank · Bank account · Account 1");
});

test("a provider identifier that happens to read like the fallback stays untouched", () => {
  const identified = account({ label: "Cathay United Bank · Bank account · Account 1" });
  assert.equal(localizeAccount(identified, translations["zh-TW"]).label, "國泰世華銀行 · 銀行帳戶 · Account 1");
});

test("an account modal titles an unidentified account without digits", () => {
  assert.equal(accountModalTitle(account({ unidentifiedOrdinal: 1 }), translations["zh-TW"]), "國泰世華銀行 · 銀行帳戶");
  assert.equal(
    accountModalTitle(account({ label: "Cathay United Bank · Bank account · 5678" }), translations["zh-TW"]),
    "國泰世華銀行 · 銀行帳戶 · 5678",
  );
});
