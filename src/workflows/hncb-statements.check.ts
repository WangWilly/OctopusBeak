import assert from "node:assert/strict";
import type { Frame, Page } from "playwright";
import {
  ensureHncbStatementForm,
  normalizeHncbTransactionRows,
} from "./hncb-statements.ts";

const normalizedRows = normalizeHncbTransactionRows([
  ["交易日期", "交易時間", "帳務日期"],
  ["0113/08/19", "12:34:56", "0113/08/20"],
  ["2025/08/19", "12:34:56", "2025/08/20"],
  ["1900/01/01", "12:34:56", "1900/01/02"],
]);
assert.deepEqual(normalizedRows.map((row) => row.slice(0, 3)), [
  ["2024/08/19", "12:34:56", "2024/08/20"],
  ["2025/08/19", "12:34:56", "2025/08/20"],
  ["1900/01/01", "12:34:56", "1900/01/02"],
]);

const page = {} as Page;
const currentFrame = {} as Frame;
const reopenedFrame = {} as Frame;

let reopened = false;
assert.equal(
  await ensureHncbStatementForm(
    page,
    async () => currentFrame,
    async () => {
      reopened = true;
      return reopenedFrame;
    },
  ),
  currentFrame,
);
assert.equal(reopened, false);

let observedTimeout = 0;
assert.equal(
  await ensureHncbStatementForm(
    page,
    async (_page, timeoutMs) => {
      observedTimeout = timeoutMs ?? 0;
      throw new Error("statement form missing");
    },
    async () => reopenedFrame,
  ),
  reopenedFrame,
);
assert.equal(observedTimeout, 5_000);
