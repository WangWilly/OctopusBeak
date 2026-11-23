/**
 * The local ledger refuses to open because an index it needs is corrupt and
 * could not be rebuilt, or could not be checked (ADR 0147). Retrying cannot
 * repair it by itself; the person may set it aside and start a new ledger.
 */
export const LEDGER_UNUSABLE_CODE = "ledger-indexes-unrepairable";

export class LedgerUnusableError extends Error {
  readonly code = LEDGER_UNUSABLE_CODE;
}

export function isLedgerUnusable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === LEDGER_UNUSABLE_CODE;
}
