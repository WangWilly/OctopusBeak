import { derived, writable } from "svelte/store";
import { assetsCopy } from "../assets/copy.ts";
import { automationCopy } from "../automation/copy.ts";
import { institutionNames } from "../institutions/institutions.ts";
import { liabilitiesCopy } from "../liabilities/copy.ts";
import { manualAssetsCopy } from "../manual-assets/copy.ts";
import { onboardingCopy } from "../onboarding/copy.ts";
import { overviewCopy } from "../overview/copy.ts";
import { previewCopy } from "../preview-sources/copy.ts";
import { settingsCopy } from "../settings/copy.ts";
import { accountsCopy } from "../shared-accounts/copy.ts";
import { shellCopy } from "../shared-shell/copy.ts";
import { spendingCopy } from "../spending/copy.ts";
import { welcomeCopy } from "../welcome/copy.ts";
import type { Locale } from "./locale.ts";
import { sharedCopy } from "./shared-copy.ts";

export { localeLabels, locales, type Locale } from "./locale.ts";

const storageKey = "octopusbeak-locale";

/**
 * One locale's copy, assembled from the features that own it. Each section's
 * text lives in its feature's `copy.ts`; this table only says where.
 */
function translationFor(locale: Locale) {
  return {
    common: sharedCopy[locale].common,
    nav: shellCopy[locale].nav,
    overview: overviewCopy[locale].overview,
    assets: assetsCopy[locale].assets,
    liabilities: liabilitiesCopy[locale].liabilities,
    spending: spendingCopy[locale].spending,
    purchaseSpending: spendingCopy[locale].purchaseSpending,
    spendingInsight: spendingCopy[locale].spendingInsight,
    spendingReview: spendingCopy[locale].spendingReview,
    accounts: accountsCopy[locale].accounts,
    historyTable: accountsCopy[locale].historyTable,
    manualAssets: manualAssetsCopy[locale].manualAssets,
    preview: previewCopy[locale].preview,
    chart: sharedCopy[locale].chart,
    accountHistory: accountsCopy[locale].accountHistory,
    transactions: accountsCopy[locale].transactions,
    statements: accountsCopy[locale].statements,
    positions: accountsCopy[locale].positions,
    automation: automationCopy[locale].automation,
    usageStatisticsPrompt: settingsCopy[locale].usageStatisticsPrompt,
    firstRunWelcome: welcomeCopy[locale].firstRunWelcome,
    onboarding: onboardingCopy[locale].onboarding,
    settings: settingsCopy[locale].settings,
    institutions: institutionNames(locale),
    accountProducts: accountsCopy[locale].accountProducts,
    unidentifiedAccount: accountsCopy[locale].unidentifiedAccount,
  };
}

export const translations = {
  en: translationFor("en"),
  "zh-TW": translationFor("zh-TW"),
} as const;

export type Translation = ReturnType<typeof translationFor>;

export function normalizeLocale(value: unknown): Locale {
  const text = String(value ?? "").toLowerCase();
  if (
    text === "zh-tw" ||
    text === "zh-hant" ||
    text.startsWith("zh-") ||
    text === "zh"
  )
    return "zh-TW";
  if (text === "en" || text.startsWith("en-")) return "en";
  return "en";
}

function readLocale(): Locale {
  if (
    typeof localStorage !== "undefined" &&
    typeof localStorage.getItem === "function"
  ) {
    const browserLanguage =
      typeof navigator !== "undefined" ? navigator.language : "en";
    return normalizeLocale(localStorage.getItem(storageKey) ?? browserLanguage);
  }
  return "en";
}

export const locale = writable<Locale>(readLocale());
export const t = derived(locale, (value) => translations[value]);

export function setLocale(value: Locale) {
  locale.set(value);
}


locale.subscribe((value) => {
  if (
    typeof localStorage !== "undefined" &&
    typeof localStorage.setItem === "function"
  ) {
    localStorage.setItem(storageKey, value);
  }
  if (typeof document !== "undefined")
    document.documentElement.lang = value === "zh-TW" ? "zh-Hant" : "en";
});
