import type { Locale } from "./locale.ts";

const en = {
  common: {
    loading: "Loading...",
    close: "Close",
    refresh: "Refresh data",
    refreshing: "Refreshing data",
    newData: "New data available",
    refreshFailed: "Refresh failed",
    cancel: "Cancel",
    missing: "missing",
    ready: "Ready",
    runningCount: (count: number) => `${count} running`,
    businessDay: (date: string) => `Business day ${date}`,
    importedAt: (value: string) => `Imported ${value}`,
    notYet: "not yet",
    days30: "30 days",
    balance: "Balance",
    valuesVisible: "Values Visible",
    page: (current: number, total: number) => `Page ${current} / ${total}`,
    pagerCount: (start: number, end: number, total: number) =>
      `${start}-${end} of ${total}`,
    all: "All",
    retry: "Retry",
    financialLiveUnavailable: "Live financial data is temporarily unavailable; showing the latest available data.",
  },
  chart: {
    trendAria: (label: string, currency: string) =>
      `${label} trend ${currency}`,
    labelAria: (label: string, currency: string) => `${label} ${currency}`,
    legendAria: (label: string) => `${label} legend`,
    noHistory: (currency: string) => `No ${currency} history`,
    singleDay: (date: string) => `Only ${date} is recorded. The trend appears after a second day of records.`,
    total: "Total",
    seriesNet: "Net",
    seriesAssets: "Assets",
    seriesLiabilities: "Liabilities",
  },
};

const zh: typeof en = {
  common: {
    loading: "載入中...",
    close: "關閉",
    refresh: "更新資料",
    refreshing: "更新資料中",
    newData: "有新資料",
    refreshFailed: "更新失敗",
    cancel: "取消",
    missing: "未設定",
    ready: "就緒",
    runningCount: (count) => `${count} 個執行中`,
    businessDay: (date) => `營業日 ${date}`,
    importedAt: (value) => `已匯入 ${value}`,
    notYet: "尚未匯入",
    days30: "30 天",
    balance: "餘額",
    valuesVisible: "顯示數值",
    page: (current, total) => `第 ${current} / ${total} 頁`,
    pagerCount: (start, end, total) => `${start}-${end}，共 ${total} 筆`,
    all: "全部",
    retry: "重試",
    financialLiveUnavailable: "即時財務資料暫時無法更新，正在顯示最近可用資料。",
  },
  chart: {
    trendAria: (label, currency) => `${label} 趨勢 ${currency}`,
    labelAria: (label, currency) => `${label} ${currency}`,
    legendAria: (label) => `${label} 圖例`,
    noHistory: (currency) => `尚無 ${currency} 歷史`,
    singleDay: (date) => `目前只有 ${date} 的紀錄，再多一天的紀錄就會顯示走勢。`,
    total: "合計",
    seriesNet: "淨值",
    seriesAssets: "資產",
    seriesLiabilities: "負債",
  },
};

export type SharedCopy = typeof en;

/** Copy every page reads: shared words, formats and chart labels. */
export const sharedCopy = { en, "zh-TW": zh } satisfies Record<Locale, SharedCopy>;
