/**
 * The canonical and operational baseline versions this App opens. They live
 * apart from the baselines themselves so the main process can check a
 * Cleanup Backup's versions without loading PGlite (ADR 0157).
 */
export const PGLITE_BASELINE_VERSION = 5;
export const PGLITE_OPERATIONAL_BASELINE_VERSION = 5;

export const LEDGER_BASELINE_VERSIONS = Object.freeze({
  canonical: PGLITE_BASELINE_VERSION,
  operational: PGLITE_OPERATIONAL_BASELINE_VERSION,
});
