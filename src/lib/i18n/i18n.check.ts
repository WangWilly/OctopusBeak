import assert from "node:assert/strict";
import { localeLabels, normalizeLocale, translations } from "./i18n.ts";

assert.equal(normalizeLocale("zh-TW"), "zh-TW");
assert.equal(normalizeLocale("zh-Hant"), "zh-TW");
assert.equal(normalizeLocale("en-US"), "en");
assert.equal(normalizeLocale("fr"), "en");

assert.equal(localeLabels.en, "English");
assert.equal(localeLabels["zh-TW"], "繁體中文");
assert.equal(translations.en.settings.title, "Settings");
assert.equal(translations["zh-TW"].settings.title, "設定");
assert.equal(translations.en.settings.displaySize, "Display size");
assert.equal(translations["zh-TW"].settings.displaySize, "顯示大小");
assert.equal(translations.en.settings.languageDescription, "Choose the language used by OctopusBeak.");
assert.equal(translations["zh-TW"].settings.languageDescription, "選擇 OctopusBeak 使用的語言。");
assert.equal(translations.en.settings.displaySizeDescription, "Adjust the overall size of OctopusBeak.");
assert.equal(translations["zh-TW"].settings.displaySizeDescription, "調整 OctopusBeak 的整體顯示大小。");
assert.doesNotMatch(JSON.stringify(translations), /Electron app/i);
assert.equal(translations.en.settings.scaleRange(75, 150), "Minimum 75% · Maximum 150%");
assert.equal(translations["zh-TW"].settings.scaleRange(75, 150), "最小 75% · 最大 150%");
assert.equal(translations.en.nav.spending, "Spending");
assert.equal(translations["zh-TW"].nav.spending, "消費");
assert.equal(translations.en.spending.title, "Personal spending");
assert.equal(translations["zh-TW"].spending.title, "個人消費");
assert.equal(translations["zh-TW"].spending.monthlyEyebrow, "每月消費");
assert.equal(translations["zh-TW"].spending.dailyEyebrow, "每日明細");
assert.equal(translations["zh-TW"].spending.invoiceEyebrow, "發票資料");

function keys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
}

assert.deepEqual(keys(translations["zh-TW"]).sort(), keys(translations.en).sort());
