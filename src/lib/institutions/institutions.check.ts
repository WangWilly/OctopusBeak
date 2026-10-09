import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { translations as dictionaries } from "../i18n/i18n.ts";
import { localizeAccount } from "../shared-accounts/localize-account.ts";
import type { AccountRowDto } from "../shared-ledger/types.ts";
import {
  INSTITUTION_KEYS,
  INSTITUTIONS,
  institutionForBankCode,
  institutionForBrokerBranch,
  institutionForNamespace,
  sourceLogo,
  sourceLogoForTask,
  institutionLogoFile,
  institutionLogo,
  institutionNames,
  intermediarySource,
  accountProduct,
  sourceInstitution,
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
  assert.equal(sourceLogoForTask("cathay-all-statements"), "cathay");
  assert.equal(sourceLogoForTask("sync-maicoin"), "maicoin");
  assert.equal(sourceLogoForTask("einvoice-personal-invoices"), "einvoice");
  assert.equal(sourceLogoForTask("exchange-rates"), null);
});

test("TDCC is an Intermediary source with its own logo, never an Institution", () => {
  assert.equal(institutionForNamespace("tdcc"), null);
  assert.equal(sourceLogo("tdcc"), "tdcc");
  assert.equal(sourceLogo("yuanta-trade"), "yuanta-securities");
  assert.equal(sourceLogoForTask("sync-tdcc"), "tdcc");
  assert.ok(existsSync(new URL(`../../../site/assets/logos/${institutionLogoFile("tdcc")}`, import.meta.url)), "the TDCC logo exists");
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

  const unknown = account({ institution: "Fixture Bank", institutionKey: undefined, label: "Fixture Bank · Bank account · 1" });
  assert.equal(localizeAccount(unknown, dictionaries["zh-TW"]).institution, "Fixture Bank");
  assert.equal(localizeAccount(unknown, dictionaries["zh-TW"]).label, "Fixture Bank · 銀行帳戶 · 1");
});

test("a TDCC account localizes its stored Institution and shows its logo only when that Institution has one", () => {
  const taishin = account({
    label: "Taishin International Bank · Bank account · 200123456",
    institution: "Taishin International Bank",
    institutionKey: "bank-812",
    viaSource: "tdcc",
  });
  const zh = localizeAccount(taishin, dictionaries["zh-TW"]);
  assert.equal(zh.institution, "台新國際商業銀行");
  assert.equal(zh.label, "台新國際商業銀行 · 銀行帳戶 · 200123456");
  assert.equal(dictionaries["zh-TW"].accounts.viaSource.tdcc, "經由集保e手掌握");
  assert.equal(dictionaries.en.accounts.viaSource.tdcc, "via TDCC e-Passbook");
  assert.equal(institutionLogo("bank-812"), null);
  assert.equal(institutionLogo("fubon"), "fubon");

  const broker = account({ label: "永豐金 · Investment account · 1", institution: "永豐金", institutionKey: "broker-9A00", product: "Investment account" });
  assert.equal(localizeAccount(broker, dictionaries.en).institution, "永豐金");
  assert.equal(localizeAccount(broker, dictionaries["zh-TW"]).label, "永豐金 · 投資帳戶 · 1");
  assert.equal(intermediarySource("tdcc"), "tdcc");
  assert.equal(intermediarySource("fubon"), null);
});

test("a FISC bank code resolves to one Institution and a code outside the table resolves to none", () => {
  assert.equal(institutionForBankCode("013"), "cathay");
  assert.equal(institutionForBankCode("822"), "ctbc");
  assert.equal(institutionForBankCode("004"), "bank-004");
  assert.equal(INSTITUTIONS.get("bank-004")?.name["zh-TW"], "臺灣銀行");
  assert.equal(INSTITUTIONS.get("bank-004")?.kind, "bank");
  assert.equal(institutionForBankCode("815"), null, "a merged bank's retired code is unknown");
  assert.equal(institutionForBankCode("060"), null, "a bills finance company holds no deposit accounts");
  assert.equal(institutionForBankCode("13"), null);
});

test("a TWSE broker branch resolves to its firm, case-sensitively", () => {
  assert.equal(institutionForBrokerBranch("9800"), "yuanta-securities");
  assert.equal(institutionForBrokerBranch("981a"), "yuanta-securities");
  assert.equal(institutionForBrokerBranch("9A9A"), "broker-9A00");
  assert.equal(institutionForBrokerBranch("1021"), "broker-1020");
  assert.equal(institutionForBrokerBranch("888B"), "broker-8880");
  assert.equal(INSTITUTIONS.get("broker-9A00")?.kind, "broker");
  assert.equal(institutionForBrokerBranch("ZZZZ"), null);
});

test("TDCC is an Intermediary source with no Institution of its own", () => {
  assert.equal(sourceInstitution("tdcc")?.kind, "intermediary");
  assert.deepEqual(sourceInstitution("cathay"), { kind: "direct", institution: "cathay", investmentStreams: {} });
  assert.equal(sourceInstitution("toString"), null);
  assert.equal(institutionForNamespace("tdcc"), null);
});

test("every logo institution names a catalog Institution in both locales", () => {
  for (const key of INSTITUTION_KEYS) assert.ok(INSTITUTIONS.has(key), key);
  assert.equal(institutionNames("en").cathay, "Cathay United Bank");
  assert.equal(institutionNames("zh-TW")["yuanta-securities"], "元大證券");
});

test("an account's product comes from its account type and its source's investment stream", () => {
  const product = (integrationNamespace: string, stream: string, accountType: string) =>
    accountProduct({ integrationNamespace, stream, accountType });
  assert.equal(product("cathay", "domestic-deposit", "depository"), "deposit");
  assert.equal(product("cathay", "foreign-currency-deposit", "depository"), "deposit");
  assert.equal(product("tdcc", "domestic-deposit", "depository"), "deposit");
  assert.equal(product("yuanta-trade", "investment", "investment"), "securities");
  assert.equal(product("yuanta-fund", "investment", "investment"), "fund");
  assert.equal(product("tdcc", "investment", "investment"), "securities");
  assert.equal(product("tdcc", "investment-fund", "investment"), "fund");
  assert.equal(product("maicoin", "investment", "investment"), null, "crypto is not a product TDCC reports");
  assert.equal(product("yuanta-trade", "investment-margin", "loan"), null);
  assert.equal(product("cathay", "credit-card", "credit"), null);
  assert.equal(product("tdcc", "toString", "investment"), null);
});
