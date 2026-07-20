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
assert.equal(translations.en.settings.scheduleSettings, "Timezone & schedule");
assert.equal(translations["zh-TW"].settings.scheduleSettings, "時區與排程設定");
assert.equal(translations.en.settings.languageDisplaySettings, "Language & display");
assert.equal(translations["zh-TW"].settings.languageDisplaySettings, "語言與顯示設定");
assert.doesNotMatch(JSON.stringify(translations), /Electron app/i);
assert.equal(translations.en.settings.scaleRange(75, 150), "Minimum 75% · Maximum 150%");
assert.equal(translations["zh-TW"].settings.scaleRange(75, 150), "最小 75% · 最大 150%");
assert.equal(translations.en.nav.spending, "Spending");
assert.equal(translations["zh-TW"].nav.spending, "消費");
assert.equal(translations.en.spending.title, "Personal spending");
assert.equal(translations["zh-TW"].spending.title, "個人消費");
assert.equal(translations.en.spending.chartDragHint, "Drag or horizontal scroll to browse · Pinch to zoom");
assert.equal(translations["zh-TW"].spending.chartDragHint, "拖曳或左右滾輪瀏覽 · 觸控板縮放");
assert.equal(
  translations.en.spending.chartVisibleRange("Jan 2026", "Dec 2026"),
  "Visible: Jan 2026–Dec 2026",
);
assert.equal(
  translations["zh-TW"].spending.chartVisibleRange("2026年1月", "2026年12月"),
  "目前顯示：2026年1月–2026年12月",
);
assert.equal(translations.en.spending.chartReset, "Reset view");
assert.equal(translations["zh-TW"].spending.chartReset, "重設檢視");
assert.equal(translations.en.spending.chartRangeAria, "Chart range");
assert.equal(translations["zh-TW"].spending.chartRangeAria, "圖表範圍");
assert.equal(translations.en.spending.chartRangeLabel(12), "12 months");
assert.equal(translations["zh-TW"].spending.chartRangeLabel(12), "12 個月");
assert.equal(translations["zh-TW"].spending.monthlyEyebrow, "每月消費");
assert.equal(translations["zh-TW"].spending.dailyEyebrow, "每日明細");
assert.equal(translations["zh-TW"].spending.invoiceEyebrow, "發票資料");
assert.equal(translations.en.automation.latestTime("Asia/Taipei"), "Latest (Asia/Taipei)");
assert.equal(translations.en.automation.historyStartedTime("Asia/Taipei"), "Started (Asia/Taipei)");
assert.equal(translations.en.automation.historyFinishedTime("Asia/Taipei"), "Finished (Asia/Taipei)");
assert.equal(translations["zh-TW"].automation.latestTime("Asia/Taipei"), "最新（Asia/Taipei）");
assert.equal(translations["zh-TW"].automation.historyStartedTime("Asia/Taipei"), "開始（Asia/Taipei）");
assert.equal(translations["zh-TW"].automation.historyFinishedTime("Asia/Taipei"), "完成（Asia/Taipei）");
assert.equal(translations.en.automation.runningTaskHeading(1), "1 task is running");
assert.equal(translations.en.automation.runningTaskHeading(2), "2 tasks are running");
assert.equal(translations.en.automation.syncDialogDescription(1), "1 independent task will start at the same time.");
assert.equal(translations.en.automation.syncDialogDescription(2), "2 independent tasks will start at the same time.");
assert.equal(translations.en.automation.showAllTasks(1), "Show all 1 task");
assert.equal(translations.en.automation.showAllTasks(2), "Show all 2 tasks");
assert.equal(translations.en.historyTable.rateDates(["2026-07-11"]), "Rate date: 2026-07-11");
assert.equal(
  translations.en.historyTable.rateDates(["2026-07-10", "2026-07-11"]),
  "Rate dates: 2026-07-10, 2026-07-11",
);
assert.equal(
  translations["zh-TW"].historyTable.rateDates(["2026-07-10", "2026-07-11"]),
  "匯率日期：2026-07-10、2026-07-11",
);

function keys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
}

assert.deepEqual(keys(translations["zh-TW"]).sort(), keys(translations.en).sort());
