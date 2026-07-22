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

function isStatementComponentResult(value: unknown): value is StatementComponentResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return typeof result.typeId === "string"
    && result.typeId.trim().length > 0
    && ["success", "failed", "skipped"].includes(String(result.status))
    && (result.fileCount === undefined || typeof result.fileCount === "number")
    && (result.error === undefined || typeof result.error === "string");
}

export function parseStatementRunSummary(text: string): StatementRunSummary | null {
  for (const line of text.split(/\r?\n/).toReversed()) {
    if (!line.startsWith(STATEMENT_RUN_SUMMARY_PREFIX)) continue;
    try {
      const value = JSON.parse(line.slice(STATEMENT_RUN_SUMMARY_PREFIX.length)) as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.results)) {
        continue;
      }
      if (!["completed", "partial", "failed"].includes(String(value.status))) continue;
      if (!value.results.every(isStatementComponentResult)) continue;
      const results = value.results;
      if (value.status !== aggregateStatementResults(results)) continue;
      return { status: value.status as StatementRunSummary["status"], results };
    } catch {
      continue;
    }
  }
  return null;
}
