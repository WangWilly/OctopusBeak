import assert from "node:assert/strict";
import test from "node:test";
import { translations } from "../i18n/i18n.ts";
import { cashFlowCsv, cashFlowCsvName, cashFlowCsvRows, exactDecimalText } from "./csv.ts";
import type { CashFlowRow } from "./model.ts";

const zh = translations["zh-TW"];
const account = { id: "a", source: "canonical", institutionKey: null, stream: null, mask: "4821", name: null } as const;

function row(id: string, overrides: Partial<CashFlowRow> & Pick<CashFlowRow, "direction" | "cashFlow">): CashFlowRow {
  return {
    transactionId: id,
    source: "canonical",
    accountId: "a",
    date: "2026-10-05",
    amount: { coefficient: "461", scale: 0, currency: "TWD" },
    kind: null,
    details: { description: null, counterparty: null, note: null, time: null, account, edit: null },
    transferLinkId: null,
    ...overrides,
  };
}

const share = (coefficient: string, scale = 0) => [{ category: null, group: null, amount: { coefficient, scale } }] as const;
const water = row("water", {
  direction: "outflow",
  cashFlow: { class: "outflow", categories: share("461") },
  details: { description: "台北自來水事業處 水費", counterparty: null, note: "每月固定", time: "16:05", account, edit: null },
});
const salary = row("salary", {
  direction: "inflow",
  date: "2026-10-04",
  amount: { coefficient: "6200050", scale: 2, currency: "TWD" },
  cashFlow: { class: "inflow", group: "income.employment.salary" },
  details: { description: "薪資, 十月", counterparty: null, note: "他說 \"謝謝\"\n第二行", time: null, account, edit: null },
});
const usd = row("usd", {
  direction: "outflow",
  amount: { coefficient: "1999", scale: 2, currency: "USD" },
  cashFlow: { class: "outflow", categories: share("1999", 2) },
  details: { description: "App", counterparty: null, note: null, time: null, account, edit: null },
});
const pairOut = row("out", { direction: "outflow", amount: { coefficient: "20000", scale: 0, currency: "TWD" }, cashFlow: { class: "not_counted", reason: "transfer" }, transferLinkId: "out/in" });
const pairIn = row("in", { direction: "inflow", amount: { coefficient: "20000", scale: 0, currency: "TWD" }, cashFlow: { class: "not_counted", reason: "transfer" }, transferLinkId: "out/in" });
const unpaired = row("lone", { direction: "outflow", amount: { coefficient: "100", scale: 0, currency: "TWD" }, cashFlow: { class: "not_counted", reason: "transfer" } });
const card = row("card", { direction: "outflow", cashFlow: { class: "not_counted", reason: "card_payment" } });
const unresolved = row("unknown", { direction: "outflow", cashFlow: { class: "unresolved" } });
const rows = [water, pairOut, pairIn, unpaired, card, unresolved, salary, usd];

/** Parse RFC 4180 text the way a spreadsheet would, to prove the quoting round-trips. */
function parse(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") { cell += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else cell += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { record.push(cell); cell = ""; }
    else if (char === "\r" && text[index + 1] === "\n") { record.push(cell); records.push(record); record = []; cell = ""; index += 1; }
    else cell += char;
  }
  return records;
}

test("the file starts with a UTF-8 byte-order mark and has no balance column", () => {
  const csv = cashFlowCsv(rows, "flow", zh);
  assert.deepEqual([...Buffer.from(csv, "utf8").subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const [header] = parse(csv.slice(1));
  assert.deepEqual(header, ["日期", "時間", "說明", "分類", "帳戶", "金額", "幣別", "備註", "原始說明"]);
  assert.ok(!header!.some((column) => column.includes("餘額")));
});

test("counted rows only, outflows negative, amounts exact in their own currency", () => {
  const records = parse(cashFlowCsv(rows, "flow", zh).slice(1)).slice(1);
  assert.deepEqual(records.map((record) => [record[0], record[5], record[6]]), [
    ["2026-10-05", "-461", "TWD"],
    ["2026-10-04", "62000.50", "TWD"],
    ["2026-10-05", "-19.99", "USD"],
  ], "transfers, card payments and undecided Kinds are not cash flow; nothing is converted or rounded");
  assert.deepEqual(records[0], ["2026-10-05", "16:05", "台北自來水事業處 水費", "未分類", "帳戶 4821", "-461", "TWD", "每月固定", "台北自來水事業處 水費"]);
});

test("commas, quotes and newlines are quoted so the cell reads back unchanged", () => {
  const csv = cashFlowCsv([salary], "flow", zh);
  assert.match(csv, /"他說 ""謝謝""\n第二行"/u);
  const [, record] = parse(csv.slice(1));
  assert.equal(record![2], "薪資, 十月");
  assert.equal(record![7], "他說 \"謝謝\"\n第二行");
});

test("text a spreadsheet would run as a formula stays text, and amounts stay numbers", () => {
  const formula = { ...salary, details: { ...salary.details, note: "=HYPERLINK(\"x\")", description: "+886 轉入" } };
  const [, record] = parse(cashFlowCsv([formula], "flow", zh).slice(1));
  assert.equal(record![7], "'=HYPERLINK(\"x\")");
  assert.equal(record![8], "'+886 轉入");
  assert.ok(parse(cashFlowCsv(rows, "flow", zh).slice(1)).slice(1).some((cells) => /^-\d/u.test(cells[5] ?? "")), "a negative amount is not prefixed");
});

test("with transfers, both sides of a pair share one pairing id and an unpaired side has none", () => {
  const records = parse(cashFlowCsv(rows, "flow_and_transfers", zh).slice(1));
  assert.equal(records[0]!.at(-1), "配對編號");
  const byAmount = records.slice(1).map((record) => [record[5], record.at(-1)]);
  assert.deepEqual(byAmount, [
    ["-461", ""],
    ["-20000", "T1"],
    ["20000", "T1"],
    ["-100", ""],
    ["62000.50", ""],
    ["-19.99", ""],
  ], "a card payment is not an internal transfer");
  assert.deepEqual(cashFlowCsvRows(rows, "flow_and_transfers").map((entry) => entry.transactionId), ["water", "out", "in", "lone", "salary", "usd"]);
});

test("exporting the search results exports only the rows given", () => {
  const records = parse(cashFlowCsv([water], "flow", zh).slice(1));
  assert.equal(records.length, 2);
  assert.equal(cashFlowCsv([], "flow", zh), "﻿日期,時間,說明,分類,帳戶,金額,幣別,備註,原始說明\r\n");
});

test("exact decimals keep their scale and sign without a float", () => {
  assert.equal(exactDecimalText({ coefficient: "5", scale: 3 }), "0.005");
  assert.equal(exactDecimalText({ coefficient: "-12345678901234567890", scale: 2 }), "-123456789012345678.90");
  assert.equal(exactDecimalText({ coefficient: "0", scale: 2 }), "0.00");
  assert.equal(exactDecimalText({ coefficient: "-0", scale: 0 }), "0");
});

test("the file name carries the period's dates", () => {
  assert.equal(cashFlowCsvName(zh, { startDate: "2026-10-01", endDate: "2026-10-05" }), "收支流水_20261001-20261005");
});
