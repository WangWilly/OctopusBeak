import { PGlite } from "@electric-sql/pglite";
import {
  applyPglitePreviewFinancialDataSchema,
  createPGlitePreviewFinancialData,
  type PGlitePreviewFinancialDataPort,
} from "../../ledger/pglite/preview-financial-data.ts";
import { PGliteStore } from "../../ledger/pglite/transaction.ts";

/** A real preview data port on a fresh in-memory PGlite, for checks that need closure or row moves. */
export async function withPreviewStore(run: (port: PGlitePreviewFinancialDataPort) => Promise<void>): Promise<void> {
  const store = new PGliteStore(await PGlite.create());
  try {
    await applyPglitePreviewFinancialDataSchema(store);
    await run(createPGlitePreviewFinancialData(store));
  } finally {
    await store.close();
  }
}
