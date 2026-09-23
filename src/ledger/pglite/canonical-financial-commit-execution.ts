import type { PGliteStore } from "./transaction.ts";
import {
  commitPGliteCanonicalFinancialBatch,
  commitPGliteCanonicalFinancialCapture,
  type PGliteCanonicalCommitOptions,
  type PGliteCanonicalFinancialCommitBatchRequest,
  type PGliteCanonicalFinancialCommitRequest,
  type PGliteCanonicalFinancialCommitResult,
} from "./canonical-source-store.ts";
import {
  PGLITE_CANONICAL_FINANCIAL_COMMIT_BATCH_COMMAND,
  PGLITE_CANONICAL_FINANCIAL_COMMIT_COMMAND,
} from "./workflow-commands.ts";

/** Named worker command; arbitrary SQL and callback closures are excluded. */
export {
  PGLITE_CANONICAL_FINANCIAL_COMMIT_BATCH_COMMAND,
  PGLITE_CANONICAL_FINANCIAL_COMMIT_COMMAND,
};

export type PGliteCanonicalFinancialCommitCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_FINANCIAL_COMMIT_COMMAND;
  request: PGliteCanonicalFinancialCommitRequest;
}>;

export type PGliteCanonicalFinancialCommitBatchCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_FINANCIAL_COMMIT_BATCH_COMMAND;
  request: PGliteCanonicalFinancialCommitBatchRequest;
}>;

export type {
  PGliteCanonicalFinancialCommitBatchRequest,
  PGliteCanonicalFinancialCommitRequest,
  PGliteCanonicalFinancialCommitResult,
};

/** Execute one serializable named financial command on a worker-owned store. */
export function executePGliteCanonicalFinancialCommit(
  database: PGliteStore,
  command:
    | PGliteCanonicalFinancialCommitCommand
    | PGliteCanonicalFinancialCommitRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalFinancialCommitResult> {
  const request = "kind" in command
    ? command.request
    : command;
  return commitPGliteCanonicalFinancialCapture(database, request, options);
}

/** Execute a grouped named command without opening one transaction per item. */
export function executePGliteCanonicalFinancialCommitBatch(
  database: PGliteStore,
  command: PGliteCanonicalFinancialCommitBatchCommand | PGliteCanonicalFinancialCommitBatchRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<readonly PGliteCanonicalFinancialCommitResult[]> {
  const request = "kind" in command ? command.request : command;
  return commitPGliteCanonicalFinancialBatch(database, request, options);
}
