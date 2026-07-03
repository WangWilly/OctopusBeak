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

function keys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
}

assert.deepEqual(keys(translations["zh-TW"]).sort(), keys(translations.en).sort());
