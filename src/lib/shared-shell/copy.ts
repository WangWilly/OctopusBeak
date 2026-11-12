import type { Locale } from "../i18n/locale.ts";

const en = {
  nav: {
    overview: "Overview",
    assets: "Assets",
    liabilities: "Liabilities",
    spending: "Spending",
    cashFlow: "Cash flow",
    automation: "Automation",
    settings: "Settings",
    primary: "Primary",
    homeAria: "OctopusBeak home",
    personalPortfolio: "Personal portfolio",
    expandSidebar: "Expand sidebar",
    collapseSidebar: "Collapse sidebar",
  },
};

const zh: typeof en = {
  nav: {
    overview: "總覽",
    assets: "資產",
    liabilities: "負債",
    spending: "消費",
    cashFlow: "收支流水",
    automation: "自動化",
    settings: "設定",
    primary: "主選單",
    homeAria: "OctopusBeak 首頁",
    personalPortfolio: "個人資產組合",
    expandSidebar: "展開側邊欄",
    collapseSidebar: "收合側邊欄",
  },
};

export type ShellCopy = typeof en;

/** The app shell's navigation copy. */
export const shellCopy = { en, "zh-TW": zh } satisfies Record<Locale, ShellCopy>;
