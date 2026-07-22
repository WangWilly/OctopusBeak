export type StatementComponentResult = {
  typeId: string;
  status: "success" | "failed" | "skipped";
  fileCount?: number;
  error?: string;
};

export type StatementRunSummary = {
  status: "completed" | "partial" | "failed";
  results: StatementComponentResult[];
};

export const STATEMENT_RUN_SUMMARY_PREFIX = "automation-statement-summary: ";

export function aggregateStatementResults(results: readonly StatementComponentResult[]) {
  const succeeded = results.some((result) => result.status === "success");
  const failed = results.some((result) => result.status === "failed");
  if (succeeded && failed) return "partial" as const;
  if (succeeded) return "completed" as const;
  return "failed" as const;
}

export function statementRunSummaryLine(results: StatementComponentResult[]) {
  return STATEMENT_RUN_SUMMARY_PREFIX + JSON.stringify({
    status: aggregateStatementResults(results),
    results,
  } satisfies StatementRunSummary);
}

export function parseStatementRunSummary(text: string): StatementRunSummary | null {
  const line = text.split(/\r?\n/).findLast((item) => item.startsWith(STATEMENT_RUN_SUMMARY_PREFIX));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice(STATEMENT_RUN_SUMMARY_PREFIX.length)) as StatementRunSummary;
    if (!Array.isArray(value.results) || !["completed", "partial", "failed"].includes(value.status)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}
