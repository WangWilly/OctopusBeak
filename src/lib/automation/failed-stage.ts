import { SourceTextIntegrityError } from "./source-text.ts";
import type { TypedWorkflowErrorCode } from "./workflow-failures.ts";
import type { WorkflowContext } from "./workflow-executor.ts";

/**
 * Names a product failure from the failed stage its collector reported, the
 * way the host classifies a run from its events (ADR 0058 tier 6). A collector
 * that reports a decoding or validation failure and then throws a plain error
 * keeps that code once the Product collection run owns the failure.
 */
export function failedStageClassifier(context: WorkflowContext): Readonly<{
  context: WorkflowContext;
  classifyFailure: (error: unknown) => TypedWorkflowErrorCode | undefined;
}> {
  let decodingFailed = false;
  let validationFailed = false;
  return {
    context: {
      ...context,
      async event(stage, outcome, code, counts) {
        if (outcome === "failed" && stage === "decoding") decodingFailed = true;
        if (outcome === "failed" && stage === "validation") validationFailed = true;
        await context.event(stage, outcome, code, counts);
      },
    },
    classifyFailure(error) {
      if (error instanceof SourceTextIntegrityError || decodingFailed) return "source-integrity-failed";
      if (validationFailed) return "source-validation-failed";
      return undefined;
    },
  };
}
