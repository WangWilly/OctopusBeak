import {
  statementRunSummaryLine,
  type StatementComponentResult,
} from "../lib/automation/statement-run-summary.ts";

type StatementComponent = {
  typeId: string;
  prepare?: () => Promise<void>;
  run: () => Promise<unknown>;
  fileCount?: (output: unknown) => number;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function runSelectedStatements(
  selectedIds: readonly string[],
  components: readonly StatementComponent[],
) {
  const selected = new Set(selectedIds);
  const results: StatementComponentResult[] = [];
  const outputs: Record<string, unknown> = {};

  for (const component of components) {
    if (!selected.has(component.typeId)) {
      results.push({ typeId: component.typeId, status: "skipped" });
      continue;
    }

    const startedAt = Date.now();
    console.log("bank-statement-component-start", {
      typeId: component.typeId,
      startedAt,
    });
    try {
      await component.prepare?.();
      const output = await component.run();
      outputs[component.typeId] = output;
      results.push({
        typeId: component.typeId,
        status: "success",
        ...(component.fileCount
          ? { fileCount: component.fileCount(output) }
          : {}),
      });
      console.log("bank-statement-component-complete", {
        typeId: component.typeId,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = errorMessage(error);
      results.push({ typeId: component.typeId, status: "failed", error: message });
      console.error("bank-statement-component-failed", {
        typeId: component.typeId,
        durationMs: Date.now() - startedAt,
        message,
      });
    }
  }

  console.log(statementRunSummaryLine(results));
  return { results, outputs };
}
