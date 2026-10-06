import type { CreditCardStatementDto } from "../shared-ledger/types.ts";

export type StatementStatus = { kind: "past-due" } | { kind: "due"; days: number } | { kind: "unknown" };

const DAY_MS = 86_400_000;

/** The newest revision of each statement, newest statement first. */
export function latestStatementRevisions(statements: readonly CreditCardStatementDto[]): CreditCardStatementDto[] {
  const latest = new Map<string, CreditCardStatementDto>();
  for (const statement of statements) {
    const current = latest.get(statement.statementId);
    if (!current || statement.revisionNumber > current.revisionNumber) latest.set(statement.statementId, statement);
  }
  return [...latest.values()].sort((left, right) => right.cycleEnd.localeCompare(left.cycleEnd));
}

/** Whether the due date has passed; payment itself is not observed. */
export function statementStatus(statement: CreditCardStatementDto, today: string): StatementStatus {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(statement.dueDate)) return { kind: "unknown" };
  if (statement.dueDate < today) return { kind: "past-due" };
  return { kind: "due", days: Math.round((Date.parse(`${statement.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS) };
}

export function statementYears(statements: readonly CreditCardStatementDto[]): number[] {
  return [...new Set(statements.map((statement) => Number(statement.cycleEnd.slice(0, 4))))].sort((left, right) => right - left);
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

export function statementsCsv(
  statements: readonly CreditCardStatementDto[],
  headers: Readonly<{
    cycleStart: string;
    cycleEnd: string;
    issueDate: string;
    dueDate: string;
    minimumPayment: string;
    statementBalance: string;
    currency: string;
    transactions: string;
    statementId: string;
  }>,
): string {
  const lines = [
    [
      headers.cycleStart,
      headers.cycleEnd,
      headers.issueDate,
      headers.dueDate,
      headers.minimumPayment,
      headers.statementBalance,
      headers.currency,
      headers.transactions,
      headers.statementId,
    ],
    ...statements.map((statement) => [
      statement.cycleStart,
      statement.cycleEnd,
      statement.issueDate,
      statement.dueDate,
      statement.minimumPayment ? String(statement.minimumPayment.value) : "",
      String(statement.statementBalance.value),
      statement.statementBalance.currency,
      String(statement.memberships.length),
      statement.statementId,
    ]),
  ];
  // The byte-order mark lets spreadsheet apps read the file as UTF-8.
  return `﻿${lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
