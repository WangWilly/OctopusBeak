import type { CanonicalResetSeams } from "./canonical-reset.ts";

export type StartupLedgerSeams = CanonicalResetSeams;

/**
 * Initialize and validate the canonical financial store before the renderer,
 * scheduler, or any financial query boundary can be created.
 */
export async function initializeCanonicalRuntimeBeforeWindow(
  userData: string = process.env.OCTOPUSBEAK_USER_DATA ?? process.cwd(),
  seams?: StartupLedgerSeams,
) {
  const { initializeCanonicalRuntime } = await import("./canonical-reset.ts");
  return initializeCanonicalRuntime({
    userData,
    canonicalLedgerDir:
      process.env.OCTOPUSBEAK_CANONICAL_LEDGER_DIR ?? process.env.LEDGER_DIR,
    ...(seams ? { seams } : {}),
  });
}
