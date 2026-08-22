export type StatementComponentResult = {
  typeId: string;
  status: "success" | "failed" | "skipped";
  /** A skipped component can be absent from the provider, or simply not selected. */
  skipReason?: "absent" | "not_selected";
  fileCount?: number;
  error?: string;
};

export type StatementRunSummary = {
  status: "completed" | "partial" | "failed";
  results: StatementComponentResult[];
};

export const STATEMENT_RUN_SUMMARY_PREFIX = "automation-statement-summary: ";
const STATEMENT_RUN_ERROR_MAX_LENGTH = 100;

export function aggregateStatementResults(
  results: readonly StatementComponentResult[],
) {
  const succeeded = results.some((result) => result.status === "success");
  const failed = results.some((result) => result.status === "failed");
  if (succeeded && failed) return "partial" as const;
  if (succeeded) return "completed" as const;
  if (
    results.some(
      (result) => result.status === "skipped" && result.skipReason === "absent",
    )
  ) {
    return "completed" as const;
  }
  return "failed" as const;
}

export function statementRunSummaryLine(
  results: readonly StatementComponentResult[],
) {
  const boundedResults = boundStatementErrors(results);
  return (
    STATEMENT_RUN_SUMMARY_PREFIX +
    JSON.stringify({
      status: aggregateStatementResults(boundedResults),
      results: boundedResults,
    } satisfies StatementRunSummary)
  );
}

function isStatementComponentResult(
  value: unknown,
): value is StatementComponentResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.typeId === "string" &&
    result.typeId.trim().length > 0 &&
    ["success", "failed", "skipped"].includes(String(result.status)) &&
    (result.skipReason === undefined ||
      ["absent", "not_selected"].includes(String(result.skipReason))) &&
    (result.fileCount === undefined || typeof result.fileCount === "number") &&
    (result.error === undefined || typeof result.error === "string")
  );
}

export function parseStatementRunSummary(
  text: string,
): StatementRunSummary | null {
  for (const line of text.split(/\r?\n/).toReversed()) {
    const summary = parseStatementRunSummaryLine(line);
    if (summary) return summary;
  }
  return null;
}

function boundStatementErrors(results: readonly StatementComponentResult[]) {
  return results.map((result) =>
    result.error && result.error.length > STATEMENT_RUN_ERROR_MAX_LENGTH
      ? {
          ...result,
          error: `${result.error.slice(0, STATEMENT_RUN_ERROR_MAX_LENGTH - 3)}...`,
        }
      : result,
  );
}

function parseStatementRunSummaryLine(
  line: string,
): StatementRunSummary | null {
  if (!line.startsWith(STATEMENT_RUN_SUMMARY_PREFIX)) return null;
  try {
    return parseStatementRunSummaryValue(
      JSON.parse(line.slice(STATEMENT_RUN_SUMMARY_PREFIX.length)),
    );
  } catch {
    return null;
  }
}

function parseStatementRunSummaryValue(
  value: unknown,
): StatementRunSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.results)) return null;
  const status = String(record.status);
  if (!["completed", "partial", "failed"].includes(status)) return null;
  if (!record.results.every(isStatementComponentResult)) return null;
  const results = record.results;
  if (status !== aggregateStatementResults(results)) return null;
  return { status: status as StatementRunSummary["status"], results };
}
