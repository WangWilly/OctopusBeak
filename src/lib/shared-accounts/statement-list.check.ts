import assert from "node:assert/strict";
import test from "node:test";

import type { CreditCardStatementDto } from "../shared-ledger/types.ts";
import { latestStatementRevisions, statementStatus, statementYears, statementsCsv } from "./statement-list.ts";

const statement = (cycleEnd: string, revisionNumber = 1, extra: Partial<CreditCardStatementDto> = {}): CreditCardStatementDto => ({
  statementId: `esun-${cycleEnd.slice(0, 7)}`,
  statementRevisionId: `esun-${cycleEnd.slice(0, 7)}-r${revisionNumber}`,
  statementKey: `esun-${cycleEnd.slice(0, 7)}`,
  revisionNumber,
  cycleStart: `${cycleEnd.slice(0, 8)}01`,
  cycleEnd,
  issueDate: cycleEnd,
  dueDate: cycleEnd,
  currency: "TWD",
  statementBalance: { currency: "TWD", value: 1000 * revisionNumber },
  minimumPayment: { currency: "TWD", value: 100 },
  memberships: [],
  ...extra,
});

test("each statement keeps only its newest revision, newest statement first", () => {
  const rows = latestStatementRevisions([statement("2026-08-15"), statement("2026-09-15", 1), statement("2026-09-15", 2)]);
  assert.deepEqual(rows.map((row) => row.statementRevisionId), ["esun-2026-09-r2", "esun-2026-08-r1"]);
});

test("status follows the due date", () => {
  assert.deepEqual(statementStatus(statement("2026-09-15", 1, { dueDate: "2026-10-01" }), "2026-10-06"), { kind: "past-due" });
  assert.deepEqual(statementStatus(statement("2026-09-15", 1, { dueDate: "2026-10-06" }), "2026-10-06"), { kind: "due", days: 0 });
  assert.deepEqual(statementStatus(statement("2026-09-15", 1, { dueDate: "2026-10-16" }), "2026-10-06"), { kind: "due", days: 10 });
  assert.deepEqual(statementStatus(statement("2026-09-15", 1, { dueDate: "" }), "2026-10-06"), { kind: "unknown" });
});

test("years run newest first from each statement's closing date", () => {
  assert.deepEqual(statementYears([statement("2025-12-15"), statement("2026-01-15"), statement("2026-02-15")]), [2026, 2025]);
});

test("the CSV export lists each statement's dates and amounts", () => {
  const csv = statementsCsv([statement("2026-09-15", 2, { cycleStart: "2026-08-16", dueDate: "2026-10-01", minimumPayment: null })], {
    cycleStart: "週期起", cycleEnd: "週期迄", issueDate: "開立日", dueDate: "繳款截止日", minimumPayment: "最低應繳",
    statementBalance: "對帳單金額", currency: "幣別", transactions: "交易筆數", statementId: "對帳單 ID",
  });
  assert.equal(csv, "﻿週期起,週期迄,開立日,繳款截止日,最低應繳,對帳單金額,幣別,交易筆數,對帳單 ID\r\n2026-08-16,2026-09-15,2026-09-15,2026-10-01,,2000,TWD,0,esun-2026-09\r\n");
});
