import assert from "node:assert/strict";
import test from "node:test";
import { taskLabelParts } from "./task-display.ts";

test("a task name's parenthesized English name becomes its own line", () => {
  assert.deepEqual(taskLabelParts("台北富邦銀行（Taipei Fubon Bank）"), { name: "台北富邦銀行", aside: "Taipei Fubon Bank" });
  assert.deepEqual(taskLabelParts("Cathay United Bank (國泰世華銀行)"), { name: "Cathay United Bank", aside: "國泰世華銀行" });
  assert.deepEqual(taskLabelParts("LINE Bank"), { name: "LINE Bank", aside: null });
  assert.deepEqual(taskLabelParts("匯率同步"), { name: "匯率同步", aside: null });
});
