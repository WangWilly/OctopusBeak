import { openLedgerDatabase } from "../src/ledger/db/client.ts";
import { openCanonicalDatabase } from "../src/ledger/canonical/canonical-database.ts";

type StartupDatabaseHandle = { close: () => void };

export type StartupLedgerSeams = {
  beforeOpen: () => void;
  open: (dir?: string) => StartupDatabaseHandle;
  openCanonical: (dir?: string) => StartupDatabaseHandle;
};

function resolveLegacyLedgerDir(explicitDir?: string): string {
  return (
    explicitDir ??
    process.env.OCTOPUSBEAK_LEDGER_DIR ??
    process.env.LEDGER_DIR ??
    "data/ledger"
  );
}

function resolveCanonicalLedgerDir(
  explicitDir: string | undefined,
  legacyDir: string,
): string {
  if (explicitDir !== undefined) return explicitDir;
  return (
    process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
    process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR ??
    legacyDir
  );
}

export function migrateLedgerBeforeWindow(
  ledgerDir?: string,
  seams: StartupLedgerSeams = {
    beforeOpen: () => {},
    open: (dir?: string) => openLedgerDatabase(dir),
    openCanonical: (dir?: string) => openCanonicalDatabase(dir ?? "data/ledger"),
  },
) {
  const legacyLedgerDir = resolveLegacyLedgerDir(ledgerDir);
  const canonicalLedgerDir = resolveCanonicalLedgerDir(
    ledgerDir,
    legacyLedgerDir,
  );
  seams.beforeOpen();
  const legacyDb = seams.open(legacyLedgerDir);
  legacyDb.close();
  const canonicalDb = seams.openCanonical(canonicalLedgerDir);
  canonicalDb.close();
}
