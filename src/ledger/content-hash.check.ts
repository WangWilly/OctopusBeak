import assert from "node:assert/strict";
import { contentHashForRow } from "./content-hash.ts";

const base = {
  "基金識別": "FS01218041-77A6",
  "基金名稱": "安聯智慧城市收益ＢＭｆ９固月",
  "交易編號": "FS01218041",
  "投資日期": "2026/03/19",
  "投資金額": "913,727台幣",
};

assert.equal(
  contentHashForRow("yuanta", "fund-statements", {
    ...base,
    "查詢期間": "2025/06/25-2026/06/24",
  }),
  contentHashForRow("yuanta", "fund-statements", {
    ...base,
    "查詢期間": "2025/06/27-2026/06/26",
  }),
);

assert.notEqual(
  contentHashForRow("yuanta", "fund-statements", {
    ...base,
    "投資金額": "913,727台幣",
  }),
  contentHashForRow("yuanta", "fund-statements", {
    ...base,
    "投資金額": "900,000台幣",
  }),
);
