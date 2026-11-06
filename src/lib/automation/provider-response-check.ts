/**
 * The checks a current-state snapshot makes before it reads a row (ADR 0109).
 * A failed check names itself with one of these, so a failure diagnostic can
 * say which check rejected the source without carrying its message.
 */
export const SNAPSHOT_CHECKS = [
  "response-endpoint",
  "response-method",
  "response-status",
  "response-content-type",
  "response-cache-control",
  "response-date",
  "evidence-json",
  "row-parse",
] as const;

export type SnapshotCheck = (typeof SNAPSHOT_CHECKS)[number];

const snapshotChecks: ReadonlySet<string> = new Set(SNAPSHOT_CHECKS);

export function isSnapshotCheck(value: unknown): value is SnapshotCheck {
  return typeof value === "string" && snapshotChecks.has(value);
}

/**
 * A current-state snapshot check that rejected its source. It keeps the name
 * `Error`: the check names the failure, and the message reads as before.
 */
export class SnapshotCheckError extends Error {
  readonly check: SnapshotCheck;

  constructor(check: SnapshotCheck, message: string, options?: ErrorOptions) {
    super(message, options);
    this.check = check;
  }
}
