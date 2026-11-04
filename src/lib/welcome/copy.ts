import type { Locale } from "../i18n/locale.ts";

const en = {
  firstRunWelcome: {
    languageHeading: "Welcome",
    languagePrompt: "Choose your language",
    introductionTitle: "Ready to let go? Let your data fall into place.",
    introductionBody:
      "See the whole picture clearly, organize every detail intelligently, and feel at ease with your finances.",
    tour: [
      {
        title: "Clear and simple",
        subtitle: "Every asset, one view",
        features: [
          { title: "Net worth at a glance", body: "Your net worth, synced automatically" },
          { title: "Automatic currency conversion", body: "Every holding shown in TWD, no mental math" },
          { title: "Snapshot history", body: "A daily record, so trends are easy to look back on" },
        ],
        callout: { label: "Net worth", value: "TWD 2,352,813", detail: "Imported 2026/11/01 00:15" },
      },
      {
        title: "Account sync",
        subtitle: "One route to historical changes",
        features: [
          { title: "Every transaction synced", body: "Banks, funds, brokerages, and crypto in one sync" },
          { title: "Switch by type", body: "Jump from all assets to the account you need" },
          { title: "Trace every balance change", body: "See what makes up your balance at a glance" },
        ],
        callout: { label: "Total assets", value: "TWD 2,371,759", detail: "Last 30 days +21,070 · +0.9%" },
      },
      {
        title: "Spending, tracked",
        subtitle: "Live fully, spend with confidence",
        features: [
          { title: "E-invoices imported automatically", body: "Every invoice syncs on its own" },
          { title: "Spending sorted automatically", body: "Dining, groceries, and transport, already categorized" },
          { title: "Month over month", body: "See where this month and last month went" },
        ],
        callout: { label: "October 2026 spending", value: "TWD 51,713", detail: "Daily average TWD 1,668" },
      },
    ],
    automationTitle: "Ready to let go?",
    automationBody:
      "Your financial records, collected automatically. No more spreadsheets by hand.",
    automationHighlights: [
      { title: "Stays on this device", body: "Sign-in details and keys stay local" },
      { title: "Updates daily", body: "Balances, transactions, and invoices sync on their own" },
      { title: "Turn off anytime", body: "Disable any service in Settings" },
    ],
    supportedInstitutions: "Works with",
    moreInstitutions: "and more",
    startSetup: "Start setup",
    maybeLater: "Maybe later",
    continue: "Continue",
    activateIntroduction: "Continue from the OctopusBeak introduction",
    previous: "Previous page",
    next: "Next",
    skipIntroduction: "Skip intro",
    languageOptions: "Language options",
    progress: (current: number, total: number) => `Page ${current} of ${total}`,
  },
};

const zh: typeof en = {
  firstRunWelcome: {
    languageHeading: "歡迎",
    languagePrompt: "選擇介面語言",
    introductionTitle: "準備放手，讓資料自己就位。",
    introductionBody: "清晰看見全貌，智慧整理每一筆，安心掌握你的財務。",
    tour: [
      {
        title: "清晰簡潔",
        subtitle: "一個視野，所有資產",
        features: [
          { title: "淨部位一眼看懂", body: "自動同步淨資產" },
          { title: "多幣別自動換算", body: "不用擔心購買力換算，資產以 TWD 呈現" },
          { title: "快照歷史", body: "每天留下一筆紀錄，走勢清楚可回顧" },
        ],
        callout: { label: "淨部位", value: "TWD 2,352,813", detail: "已匯入 2026/11/01 00:15" },
      },
      {
        title: "帳戶同步",
        subtitle: "歷史追蹤，路徑直達",
        features: [
          { title: "同步每筆交易", body: "銀行、基金、券商、加密資產一起同步" },
          { title: "依類型快速切換", body: "從全部資產快速找到你的目標帳戶" },
          { title: "餘額變化有跡可循", body: "清楚的餘額組成，一目瞭然" },
        ],
        callout: { label: "資產總額", value: "TWD 2,371,759", detail: "近 30 天 +21,070 · +0.9%" },
      },
      {
        title: "財務追蹤",
        subtitle: "精彩生活，安心消費",
        features: [
          { title: "電子發票自動匯入", body: "自動同步每一張發票" },
          { title: "消費自動分類", body: "餐飲、日常採買、交通移動，分好類別" },
          { title: "每月對照", body: "這個月和上個月花在哪，一看便知" },
        ],
        callout: { label: "2026 年 10 月消費", value: "TWD 51,713", detail: "本月日均 TWD 1,668" },
      },
    ],
    automationTitle: "準備放手了嗎？",
    automationBody: "帳務資料自動收集，再也不用親自填進試算表。",
    automationHighlights: [
      { title: "只存在這台裝置", body: "登入資料與金鑰只在本機" },
      { title: "每天自動更新", body: "餘額、交易與發票自動同步" },
      { title: "隨時可以停用", body: "每個服務都能在設定中個別關閉" },
    ],
    supportedInstitutions: "支援",
    moreInstitutions: "等金融機構",
    startSetup: "開始設定",
    maybeLater: "稍後再說",
    continue: "繼續",
    activateIntroduction: "從 OctopusBeak 品牌介紹繼續",
    previous: "上一頁",
    next: "下一步",
    skipIntroduction: "略過介紹",
    languageOptions: "語言選項",
    progress: (current, total) => `第 ${current} 頁，共 ${total} 頁`,
  },
};

export type WelcomeCopy = typeof en;

/** The first-run welcome's copy. */
export const welcomeCopy = { en, "zh-TW": zh } satisfies Record<Locale, WelcomeCopy>;
