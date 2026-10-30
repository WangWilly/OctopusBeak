import { TYPED_WORKFLOW_ERROR_CODES } from "../workflow-failures.ts";
import { WORKFLOW_STAGES } from "../task-row.ts";
import type { WorkflowFailureDiagnostic } from "./workflow-failure-diagnostics.ts";

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
const TASK_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,189}\.[^\s@<>"]{2,}$/u;
const CODES = new Set<string>(TYPED_WORKFLOW_ERROR_CODES);
const STAGES = new Set<string>(WORKFLOW_STAGES);
/** Six or more digits, possibly split by spaces or dashes, look like an account or card number. */
const LONG_NUMBER = /\d(?:[\s-]?\d){5,}/gu;
const REQUEST_TIMEOUT_MS = 10_000;

/** The receiver masks again; masking here means the preview shows exactly what leaves the Mac. */
export function maskNumbers(note: string): string {
  return note.replace(LONG_NUMBER, "[已遮蔽]");
}

const latest = new Map<string, WorkflowFailureDiagnostic>();

/** The host's latest failure record per task, in memory only; a restart forgets it. */
export function rememberFailureDiagnostic(taskId: string, record: WorkflowFailureDiagnostic | null): void {
  if (record) latest.set(taskId, record);
  else latest.delete(taskId);
}

export function forgetFailureDiagnostics(): void {
  latest.clear();
}

/** The report endpoint sits beside the ping endpoint on the same receiver. */
export function errorReportUrl(pingUrl: string): string {
  return pingUrl ? pingUrl.replace(/\/v1\/ping$/u, "/v1/report") : "";
}

export class InvalidErrorReport extends Error {}

export function buildErrorReport(
  input: ErrorReportInput,
  context: { appVersion: string; osVersion: string; locale: "zh-TW" | "en" },
): ErrorReportPayload {
  if (!TASK_ID.test(input.taskId)) throw new InvalidErrorReport("unknown task");
  if (!CODES.has(input.code)) throw new InvalidErrorReport("unknown failure code");
  if (input.stage !== null && !STAGES.has(input.stage)) throw new InvalidErrorReport("unknown stage");
  if (typeof input.note !== "string" || [...input.note].length > MAX_NOTE_LENGTH) throw new InvalidErrorReport("note is too long");
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (email !== "" && (email.length > 254 || !EMAIL.test(email))) throw new InvalidErrorReport("email is malformed");
  const record = latest.get(input.taskId);
  // A record from another failure of the same task would describe the wrong error.
  const matching = record && record.errorCode === input.code ? record : null;
  return {
    schema: 1,
    appVersion: context.appVersion,
    osVersion: context.osVersion,
    arch: "arm64",
    locale: context.locale,
    source: input.taskId,
    code: input.code,
    stage: input.stage,
    diagnostic: matching
      ? {
          source: matching.source,
          errorCode: matching.errorCode,
          ...(matching.stage ? { stage: matching.stage } : {}),
          ...(matching.statementType ? { statementType: matching.statementType } : {}),
          ...(matching.operation ? { operation: matching.operation } : {}),
          ...(matching.reason ? { reason: matching.reason } : {}),
          chain: matching.error.chain,
        }
      : null,
    note: maskNumbers(input.note.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").trim()),
    email,
  };
}

/** Posts one report. Never logs the payload. */
export async function sendErrorReport(url: string, payload: ErrorReportPayload, fetchImpl: typeof fetch = fetch): Promise<ErrorReportResult> {
  if (!url) return { ok: false, reason: "unavailable" };
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (response.status === 201) {
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
    return typeof body?.id === "string" ? { ok: true, id: body.id } : { ok: false, reason: "network" };
  }
  await response.body?.cancel();
  if (response.status === 429) return { ok: false, reason: "rate-limited" };
  if (response.status === 400) return { ok: false, reason: "invalid" };
  return { ok: false, reason: "unavailable" };
}
