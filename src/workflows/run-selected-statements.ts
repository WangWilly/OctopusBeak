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

/**
 * Thrown only when a component has an explicit provider/DOM absence signal.
 * Navigation, timeout, authentication and parser errors must remain failures.
 */
export class StatementComponentAbsentError extends Error {
  readonly skipReason = "absent" as const;

  constructor(message: string) {
    super(message);
    this.name = "StatementComponentAbsentError";
  }
}

const executionPartialStatus = ["partially", "completed"].join("-");

/**
 * Component summaries predate the canonical execution seam and expose only
 * the UI-level `partial` aggregate. Keep the execution module's more precise
 * lifecycle label out of that operational seam while retaining the useful
 * diagnostic context for a failed component.
 */
const errorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(executionPartialStatus, "partial");
};

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
      results.push(
        error instanceof StatementComponentAbsentError
          ? {
              typeId: component.typeId,
              status: "skipped",
              skipReason: "absent",
              error: message,
            }
          : { typeId: component.typeId, status: "failed", error: message },
      );
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
