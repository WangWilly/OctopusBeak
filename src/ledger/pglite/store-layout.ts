import type { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "./baseline.ts";
import { applyPgliteCashFlowTransferSchema } from "./cash-flow-transfer.ts";
import { applyPgliteKindDuplicateCleanup } from "./kind-duplicate-cleanup.ts";
import { applyPgliteKindRederivation } from "./kind-rederivation.ts";
import { applyPgliteMaicoinOperationalSchema } from "./maicoin-operational.ts";
import { applyPgliteManualAssetsSchema } from "./manual-assets.ts";
import { applyPgliteOperationalBaseline } from "./operational.ts";
import { applyPglitePreviewFinancialDataSchema } from "./preview-financial-data.ts";
import { applyPgliteReadIndexes } from "./read-indexes.ts";
import { applyPgliteTaxonomySeed } from "./taxonomy-seed.ts";
import { PGliteStore } from "./transaction.ts";

/**
 * Install everything a financial store holds, in order, and return the store.
 * Every store the app opens has the canonical ledger, operational, Maicoin,
 * preview, Manual Asset and Cash-flow transfer tables, so a page reads all
 * of them (ADR 0102).
 * Each step verifies its manifest and is safe to repeat on an existing store.
 */
export async function installFinancialStore(db: PGlite): Promise<PGliteStore> {
  await applyPgliteBaseline(db);
  const store = new PGliteStore(db);
  await applyPgliteOperationalBaseline(store);
  await applyPgliteMaicoinOperationalSchema(store);
  await applyPglitePreviewFinancialDataSchema(store);
  await applyPgliteManualAssetsSchema(store);
  await applyPgliteCashFlowTransferSchema(store);
  await applyPgliteTaxonomySeed(store);
  await applyPgliteReadIndexes(store);
  await applyPgliteKindDuplicateCleanup(store);
  await applyPgliteKindRederivation(store);
  return store;
}
