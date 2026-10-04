import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { translations as dictionaries } from "../i18n/i18n.ts";
import { localizeAccount } from "../shared-accounts/localize-account.ts";
import type { AccountRowDto } from "../shared-ledger/types.ts";
import {
  INSTITUTION_KEYS,
  institutionForNamespace,
  institutionForTask,
  institutionLogoFile,
} from "./institutions.ts";

test("every institution has a downloaded logo and a name in both locales", () => {
  for (const key of INSTITUTION_KEYS) {
    const file = new URL(`../../../site/assets/logos/${institutionLogoFile(key)}`, import.meta.url);
    assert.ok(existsSync(file), `${key} logo must exist in site/assets/logos`);
    assert.ok(dictionaries.en.institutions[key], `${key} needs an English name`);
    assert.ok(dictionaries["zh-TW"].institutions[key], `${key} needs a Traditional Chinese name`);
  }
});

test("collection namespaces and automation tasks resolve to their institution", () => {
  assert.equal(institutionForNamespace("yuanta"), "yuanta-bank");
  assert.equal(institutionForNamespace("yuanta-fund"), "yuanta-bank");
  assert.equal(institutionForNamespace("yuanta-trade"), "yuanta-securities");
  assert.equal(institutionForNamespace("fubon"), "fubon");
  assert.equal(institutionForNamespace("unknown-bank"), null);
  assert.equal(institutionForNamespace(undefined), null);
  assert.equal(institutionForTask("cathay-all-statements"), "cathay");
  assert.equal(institutionForTask("sync-maicoin"), "maicoin");
  assert.equal(institutionForTask("einvoice-personal-invoices"), "einvoice");
  assert.equal(institutionForTask("exchange-rates"), null);
});

const account = (overrides: Partial<AccountRowDto> = {}): AccountRowDto => ({
  id: "account-1",
  label: "Cathay United Bank · Bank account · 1234",
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
});

test("accounts show the institution and product in the interface language", () => {
  const zh = localizeAccount(account(), dictionaries["zh-TW"]);
  assert.equal(zh.institution, "國泰世華銀行");
  assert.equal(zh.product, "銀行帳戶");
  assert.equal(zh.label, "國泰世華銀行 · 銀行帳戶 · 1234");

  assert.deepEqual(localizeAccount(account(), dictionaries.en), account());

  const unknown = account({ institution: "Fixture Bank", institutionKey: "fixture-bank", label: "Fixture Bank · Bank account · 1" });
  assert.equal(localizeAccount(unknown, dictionaries["zh-TW"]).institution, "Fixture Bank");
  assert.equal(localizeAccount(unknown, dictionaries["zh-TW"]).label, "Fixture Bank · 銀行帳戶 · 1");
});
