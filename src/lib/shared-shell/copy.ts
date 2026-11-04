import type { Locale } from "../i18n/locale.ts";

const en = {
  nav: {
    overview: "Overview",
    assets: "Assets",
    liabilities: "Liabilities",
    spending: "Spending",
    automation: "Automation",
    settings: "Settings",
    primary: "Primary",
    homeAria: "OctopusBeak home",
    personalPortfolio: "Personal portfolio",
    expandSidebar: "Expand sidebar",
    collapseSidebar: "Collapse sidebar",
  },
  usageStatisticsPrompt: {
    title: "Help improve OctopusBeak?",
    body: "When turned on, one anonymous report is sent each day so we can see how many people keep using OctopusBeak and which data sources run into problems.",
    sentLabel: "What is sent:",
    sent: "The app version, operating system version, language, the week you first opened the app, and how many times each data source failed and with which error code.",
    neverSentLabel: "What is never sent:",
    neverSent: "Financial data, sign-in details, run results, or anything that identifies you or this computer.",
    note: "Change this any time in Settings › Usage statistics.",
    accept: "Turn on usage statistics",
    decline: "No thanks",
  },
};

const zh: typeof en = {
  nav: {
    overview: "總覽",
    assets: "資產",
    liabilities: "負債",
    spending: "消費",
    automation: "自動化",
    settings: "設定",
    primary: "主選單",
    homeAria: "OctopusBeak 首頁",
    personalPortfolio: "個人資產組合",
    expandSidebar: "展開側邊欄",
    collapseSidebar: "收合側邊欄",
  },
  usageStatisticsPrompt: {
    title: "協助改善 OctopusBeak？",
    body: "開啟後，每天會傳送一次匿名回報，讓我們知道有多少人持續使用 OctopusBeak，以及哪些資料來源出了問題。",
    sentLabel: "傳送的內容：",
    sent: "App 版本、作業系統版本、語言、你第一次開啟的週次，以及各資料來源失敗的次數與錯誤代碼。",
    neverSentLabel: "不傳送的內容：",
    neverSent: "任何帳務資料、登入資料、執行結果，或能辨識你或這台電腦的資訊。",
    note: "隨時在「設定 › 使用統計」變更。",
    accept: "開啟使用統計",
    decline: "不用了",
  },
};

export type ShellCopy = typeof en;

/** The app shell's copy: navigation and the usage statistics prompt. */
export const shellCopy = { en, "zh-TW": zh } satisfies Record<Locale, ShellCopy>;
