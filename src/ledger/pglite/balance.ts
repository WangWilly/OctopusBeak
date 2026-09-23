import type { PGliteStore } from "./transaction.ts";
import {
  commitPGliteCanonicalFinancialCapture,
  type PGliteCanonicalCommitOptions,
  type PGliteCanonicalFinancialCommitResult,
  type PGliteCanonicalFinancialCommitRequest,
} from "./canonical-source-store.ts";
import type {
  PGliteCanonicalFinancialAccountInput,
  PGliteCanonicalBalanceObservationInput,
  PGliteCanonicalSourceEvidence,
} from "./source-admission-validation.ts";
import { PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND } from "./workflow-commands.ts";

/** Named worker command for a provider current-balance capture. */
export { PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND };

export type PGliteCanonicalBalanceCaptureRequest = Readonly<{
  capture: PGliteCanonicalSourceEvidence;
  account: PGliteCanonicalFinancialAccountInput;
  observations: readonly PGliteCanonicalBalanceObservationInput[];
  recordedAtUtcUs?: number;
}>;

export type PGliteCanonicalBalanceCaptureCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND;
  request: PGliteCanonicalBalanceCaptureRequest;
}>;

export type PGliteCanonicalBalanceCommitResult = Readonly<{
  status: "canonical-live";
  captureId: string;
  accountId: string;
  commitSequence: number;
  observationCount: number;
  revisionCount: number;
  deduplicatedRevisionCount: number;
}>;

function toFinancialRequest(
  request: PGliteCanonicalBalanceCaptureRequest,
): PGliteCanonicalFinancialCommitRequest {
  return {
    capture: request.capture,
    account: request.account,
    transactions: [],
    balanceObservations: request.observations,
    requireExistingAccount: true,
    recordedAtUtcUs: request.recordedAtUtcUs,
  };
}

function uuidText(value: unknown): string {
  if (typeof value === "string") {
    const clean = value.replace(/^\\x/u, "").toLowerCase();
    if (/^[0-9a-f]{32}$/u.test(clean))
      return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(clean)) return clean;
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const clean = Buffer.from(value).toString("hex");
    if (clean.length === 32)
      return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
  }
  throw new Error("PGlite balance account identity is not a UUID.");
}

async function readBalanceCommit(
  store: PGliteStore,
  request: PGliteCanonicalBalanceCaptureRequest,
  result: PGliteCanonicalFinancialCommitResult,
): Promise<PGliteCanonicalBalanceCommitResult> {
  const rows = await store.query<{
    account_id: unknown;
    capture_id: unknown;
    revision_count: number | string;
  }>(
    `SELECT scope.account_id, source_capture.capture_id,
            COUNT(revision.revision_id)::int AS revision_count
       FROM source_captures source_capture
       JOIN capture_scopes scope ON scope.capture_id = source_capture.capture_id
       LEFT JOIN balance_observation_revisions revision
         ON revision.capture_id = source_capture.capture_id
      WHERE source_capture.capture_key = $1
      GROUP BY scope.account_id, source_capture.capture_id`,
    [request.capture.captureId],
  );
  const row = rows.rows[0];
  if (!row?.account_id)
    throw new Error("PGlite balance commit did not retain its account scope.");
  const revisionCount = Number(row.revision_count);
  return {
    status: "canonical-live",
    captureId: result.captureId,
    accountId: uuidText(row.account_id),
    commitSequence: result.commitSequence,
    observationCount: request.observations.length,
    revisionCount,
    deduplicatedRevisionCount: request.observations.length - revisionCount,
  };
}

/** Commit current balance observations and their source evidence atomically. */
export async function commitPGliteCanonicalBalanceCapture(
  store: PGliteStore,
  request: PGliteCanonicalBalanceCaptureRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalBalanceCommitResult> {
  const result = await commitPGliteCanonicalFinancialCapture(
    store,
    toFinancialRequest(request),
    options,
  );
  return readBalanceCommit(store, request, result);
}

/** Execute a serializable named balance command on the worker-owned store. */
export function executePGliteCanonicalBalanceCapture(
  store: PGliteStore,
  command:
    | PGliteCanonicalBalanceCaptureCommand
    | PGliteCanonicalBalanceCaptureRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalBalanceCommitResult> {
  const request = "kind" in command ? command.request : command;
  return commitPGliteCanonicalBalanceCapture(store, request, options);
}
