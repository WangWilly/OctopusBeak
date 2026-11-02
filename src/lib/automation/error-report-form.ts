import type { ErrorReportInput, ErrorReportPayload, ErrorReportResult } from "./server/error-report.ts";
import type { AutomationTaskRow } from "./types.ts";

/** ADR 0081: which failure the person is reporting; the note and email come from the form. */
export type ErrorReportTarget = Omit<ErrorReportInput, "note" | "email">;
export type ErrorReportFailure = Extract<ErrorReportResult, { ok: false }>["reason"];
export type ErrorReportStatus =
  | Readonly<{ kind: "editing" }>
  | Readonly<{ kind: "sending" }>
  | Readonly<{ kind: "sent"; id: string }>
  | Readonly<{ kind: "failed"; reason: ErrorReportFailure }>;

export const PREVIEW_DELAY_MS = 300;

export function errorReportTarget(task: Pick<AutomationTaskRow, "id" | "events">, code: string): ErrorReportTarget {
  // The last operating stage, as the host's failure classification reads it.
  const stage = task.events.findLast((event) => event.stage !== "finalization")?.stage ?? null;
  return { taskId: task.id, code, stage };
}

/** A send in flight keeps the dialog open so its result has somewhere to land. */
export function closeAllowed(status: ErrorReportStatus): boolean {
  return status.kind !== "sending";
}

export function sendAllowed(status: ErrorReportStatus): boolean {
  return status.kind === "editing" || status.kind === "failed";
}

export async function sendErrorReport(
  send: (input: ErrorReportInput) => Promise<ErrorReportResult>,
  input: ErrorReportInput,
): Promise<ErrorReportStatus> {
  const result = await send(input).catch((): ErrorReportResult => ({ ok: false, reason: "network" }));
  return result.ok ? { kind: "sent", id: result.id } : { kind: "failed", reason: result.reason };
}

/** An email still being typed is malformed; the preview shows it once it is complete. */
export function previewEmail(email: string): string {
  return email.includes("@") ? email : "";
}

/**
 * Asks for the preview once typing pauses. A preview that answers after a newer one was asked
 * for, or after cancel(), is dropped.
 */
export function createPreviewRefresher(
  preview: (input: ErrorReportInput) => Promise<ErrorReportPayload>,
  show: (payload: ErrorReportPayload | null) => void,
  delayMs = PREVIEW_DELAY_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0;
  return {
    schedule(input: ErrorReportInput) {
      clearTimeout(timer);
      const current = ++version;
      timer = setTimeout(() => {
        void preview({ ...input, email: previewEmail(input.email) })
          .catch(() => null)
          .then((payload) => {
            if (current === version) show(payload);
          });
      }, delayMs);
    },
    cancel() {
      clearTimeout(timer);
      version += 1;
    },
  };
}
