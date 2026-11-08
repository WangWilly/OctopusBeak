import type { WorkflowFailureDiagnostic } from "./server/workflow-failure-diagnostics.ts";

/**
 * ADR 0081: an Error report the person sends by hand from a failed run. It carries the sanitized
 * failure record the host already builds (enumerated codes and the app's own stack frames, never a
 * message or a value), plus a note and an email the person typed. Nothing is sent without a click.
 */
export type ErrorReportPayload = {
  schema: 1;
  appVersion: string;
  osVersion: string;
  arch: "arm64";
  locale: "zh-TW" | "en";
  source: string;
  code: string;
  stage: string | null;
  diagnostic: ErrorReportDiagnostic | null;
  note: string;
  email: string;
};

/** The diagnostic minus its run id and time, which the report does not need. */
export type ErrorReportDiagnostic = Omit<WorkflowFailureDiagnostic, "version" | "occurredAt" | "workflowId" | "taskRunId" | "error"> & {
  chain: WorkflowFailureDiagnostic["error"]["chain"];
};

export type ErrorReportInput = Readonly<{ taskId: string; code: string; stage: string | null; note: string; email: string }>;

export type ErrorReportResult =
  | { ok: true; id: string }
  | { ok: false; reason: "invalid" | "rate-limited" | "unavailable" | "network" };

export const MAX_NOTE_LENGTH = 1000;
