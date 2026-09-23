import type {
  CanonicalFinancialCommitAdmissionSummary,
  CanonicalFinancialCommitDiagnostic,
  CanonicalFinancialCommitItemResult,
  CanonicalFinancialCommitRunResult,
} from "../canonical/canonical-financial-commit-execution.ts";
import type {
  PGliteWorkflowClient,
  PGliteWorkflowCommand,
  PGliteWorkflowFailureCategory,
} from "./workflow-client.ts";

/** A serializable worker command is the only financial action in an item. */
export type PGliteWorkflowRunItem = Readonly<{
  provider: string;
  product: string;
  itemKey: string;
  command: PGliteWorkflowCommand;
  /** Build named follow-through commands after the financial commit succeeds. */
  relationCommands?: (value: unknown) => readonly PGliteWorkflowCommand[];
  onRelationResult?: (value: unknown) => void;
}>;

export type PGliteWorkflowRunRequest = Readonly<{
  client: PGliteWorkflowClient;
  items: Iterable<PGliteWorkflowRunItem> | AsyncIterable<PGliteWorkflowRunItem>;
  signal?: AbortSignal;
  provider?: string;
  product?: string;
}>;

type DiagnosticIdentity = Pick<PGliteWorkflowRunItem, "provider" | "product" | "itemKey">;
type ClassifiedFailure = Readonly<{
  kind: "item" | "fatal" | "cancelled";
  category?: PGliteWorkflowFailureCategory;
  code: string;
}>;

function safeIdentity(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/u.test(value)
    ? value
    : fallback;
}

function classify(error: unknown, signal?: AbortSignal): ClassifiedFailure {
  if (signal?.aborted) return { kind: "cancelled", code: "cancelled" };
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; category?: unknown };
    if (value.code === "cancelled") return { kind: "cancelled", code: "cancelled" };
    if (value.code === "operation-failed"
      && (value.category === "admission" || value.category === "stale"
        || value.category === "ineligible" || value.category === "conflict")) {
      return { kind: "item", category: value.category, code: value.category };
    }
  }
  return { kind: "fatal", code: "worker-failure" };
}

function diagnostic(
  identity: DiagnosticIdentity,
  stage: CanonicalFinancialCommitDiagnostic["stage"],
  code: string,
): CanonicalFinancialCommitDiagnostic {
  return Object.freeze({
    provider: safeIdentity(identity.provider, "provider"),
    product: safeIdentity(identity.product, "financial"),
    itemKey: safeIdentity(identity.itemKey, "item"),
    stage,
    errorCode: code,
    // Worker and transport exceptions can contain SQL or provider evidence.
    // The diagnostic uses only the fixed classification vocabulary.
    message: stage === "relation-resolution"
      ? "Post-commit relation resolution failed."
      : stage === "cancellation"
        ? "Financial workflow was cancelled."
        : "Financial workflow command failed.",
  });
}

function admissionSummaries(value: unknown): readonly CanonicalFinancialCommitAdmissionSummary[] {
  const mixed = value && typeof value === "object" && "admissions" in value
    ? value as { admissions?: unknown; financial?: unknown; deposits?: unknown }
    : null;
  const values = mixed
    ? [mixed.admissions, mixed.financial, mixed.deposits].flatMap((part) => Array.isArray(part) ? part : [])
    : Array.isArray(value) ? value : [value];
  if (values.length === 0) throw new Error("Financial command returned no source admissions.");
  return Object.freeze(values.map((candidate) => {
    if (!candidate || typeof candidate !== "object")
      throw new Error("Financial command returned no source admission receipt.");
    const receipt = candidate as {
      captureId?: unknown;
      commitSequence?: unknown;
      knowledgePoint?: unknown;
      knowledgeAt?: unknown;
    };
    const sequence = receipt.commitSequence ?? receipt.knowledgePoint ?? receipt.knowledgeAt;
    if (typeof receipt.captureId !== "string" || receipt.captureId.length === 0
      || !Number.isSafeInteger(sequence) || (sequence as number) < 0)
      throw new Error("Financial command returned an invalid source admission receipt.");
    return Object.freeze({ captureId: receipt.captureId, commitSequence: sequence as number });
  }));
}

function resultStatus(results: readonly CanonicalFinancialCommitItemResult<unknown>[], fatal: boolean, cancelled: boolean) {
  if (cancelled) return "cancelled" as const;
  if (fatal) return "failed" as const;
  const committed = results.filter((item) => item.status === "committed").length;
  if (committed === results.length) return "completed" as const;
  return committed > 0 ? "partially-completed" as const : "failed" as const;
}

/**
 * Run provider items through the parent worker without opening a child DB.
 * Each command owns its own transaction; relation commands are deliberately
 * post-commit and fail-soft. Cancellation never erases a committed receipt.
 */
export async function executePGliteWorkflowRun(
  request: PGliteWorkflowRunRequest,
): Promise<CanonicalFinancialCommitRunResult<unknown>> {
  const results: CanonicalFinancialCommitItemResult<unknown>[] = [];
  const diagnostics: CanonicalFinancialCommitDiagnostic[] = [];
  const fallback = {
    provider: request.provider ?? "provider",
    product: request.product ?? "financial",
    itemKey: "run",
  };
  let fatal = false;
  let cancelled = false;
  try {
    for await (const item of request.items) {
      if (request.signal?.aborted) {
        cancelled = true;
        diagnostics.push(diagnostic(item, "cancellation", "cancelled"));
        break;
      }
      if (!item || typeof item !== "object" || !item.command || typeof item.command.kind !== "string") {
        const problem = diagnostic(fallback, "admission", "invalid-item");
        diagnostics.push(problem);
        results.push(Object.freeze({ ...fallback, status: "failed", failureKind: "item", diagnostics: [problem] }));
        continue;
      }
      let value: unknown;
      try {
        value = await request.client.commit(item.command, { signal: request.signal });
      } catch (error) {
        const failure = classify(error, request.signal);
        if (failure.kind === "cancelled") {
          cancelled = true;
          diagnostics.push(diagnostic(item, "cancellation", failure.code));
          break;
        }
        const problem = diagnostic(item, failure.kind === "item" ? "commit" : "run", failure.code);
        diagnostics.push(problem);
        results.push(Object.freeze({
          itemKey: item.itemKey,
          provider: item.provider,
          product: item.product,
          status: "failed",
          failureKind: failure.kind,
          diagnostics: [problem],
        }));
        if (failure.kind === "fatal") {
          fatal = true;
          break;
        }
        continue;
      }
      let summaries: readonly CanonicalFinancialCommitAdmissionSummary[];
      try {
        summaries = admissionSummaries(value);
      } catch {
        // The worker reported success, so the item remains committed even if
        // its response violated the receipt contract. Never retry that item.
        const problem = diagnostic(item, "run", "invalid-receipt");
        diagnostics.push(problem);
        results.push(Object.freeze({
          itemKey: item.itemKey,
          provider: item.provider,
          product: item.product,
          status: "committed",
          admissionSummaries: Object.freeze([]),
          value,
          relationWarnings: Object.freeze([]),
        }));
        fatal = true;
        break;
      }
      const warnings: CanonicalFinancialCommitDiagnostic[] = [];
      try {
        for (const command of item.relationCommands?.(value) ?? []) {
          const relationResult = await request.client.commit(command);
          item.onRelationResult?.(relationResult);
        }
      } catch {
        const warning = diagnostic(item, "relation-resolution", "relation-failed");
        warnings.push(warning);
        diagnostics.push(warning);
      }
      results.push(Object.freeze({
        itemKey: item.itemKey,
        provider: item.provider,
        product: item.product,
        status: "committed",
        admissionSummaries: summaries,
        value,
        relationWarnings: Object.freeze(warnings),
      }));
      if (request.signal?.aborted) {
        cancelled = true;
        diagnostics.push(diagnostic(item, "cancellation", "cancelled"));
        break;
      }
    }
  } catch {
    fatal = true;
    diagnostics.push(diagnostic(fallback, "run", "run-failure"));
  }
  const committedCount = results.filter((item) => item.status === "committed").length;
  return Object.freeze({
    status: resultStatus(results, fatal, cancelled),
    items: Object.freeze(results),
    diagnostics: Object.freeze(diagnostics),
    committedCount,
    failedCount: results.length - committedCount,
  });
}
