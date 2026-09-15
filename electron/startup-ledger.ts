import { openCanonicalDatabaseHandle } from "../src/ledger/canonical/canonical-database.ts";
import {
  initializeCanonicalRuntime,
  type CanonicalResetDatabaseHandle,
  type CanonicalResetSeams,
} from "./canonical-reset.ts";

export type StartupLedgerSeams = CanonicalResetSeams;

/**
 * Initialize and validate the canonical financial store before the renderer,
 * scheduler, or any financial query boundary can be created.
 */
export function initializeCanonicalRuntimeBeforeWindow(
  userData: string = process.env.OCTOPUSBEAK_USER_DATA ?? process.cwd(),
  seams: StartupLedgerSeams = {
    openCanonical: (ledgerDir) => {
      const db = openCanonicalDatabaseHandle(ledgerDir);
      const handle: CanonicalResetDatabaseHandle = {
        close: () => db.close(),
      };
      return handle;
    },
  },
) {
  return initializeCanonicalRuntime({
    userData,
    canonicalLedgerDir:
      process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
      process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR,
    seams,
  });
}
