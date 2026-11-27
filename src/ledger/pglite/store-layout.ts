import type { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "./baseline.ts";
import { applyPgliteCaptureManifestSchema } from "./capture-manifest.ts";
import { applyPgliteCardIdentitySecretSchema } from "./card-identity-secret.ts";
import { applyPgliteCashFlowTransferSchema } from "./cash-flow-transfer.ts";
import { applyPgliteInvestmentStatementFactsSchema } from "./investment-statement-facts.ts";
import { applyPgliteKindDuplicateCleanup } from "./kind-duplicate-cleanup.ts";
import { applyPgliteKindRederivation } from "./kind-rederivation.ts";
import { applyPgliteMaicoinOperationalSchema } from "./maicoin-operational.ts";
import { applyPgliteMaicoinTwdTransferPass } from "./maicoin-twd-transfer-pass.ts";
import { applyPgliteManualAssetsSchema } from "./manual-assets.ts";
import { applyPgliteOperationalBaseline } from "./operational.ts";
import { applyPglitePreviewFinancialDataSchema } from "./preview-financial-data.ts";
import { applyPgliteReadIndexes } from "./read-indexes.ts";
import { applyPgliteTaxonomySeed } from "./taxonomy-seed.ts";
import { PGliteStore } from "./transaction.ts";

/**
 * Install everything a financial store holds, in order, and return the store.
 * Every store the app opens has the canonical ledger with its capture
 * manifests (ADR 0152), and the operational, Maicoin, preview, Manual Asset
 * and Cash-flow transfer tables, so a page reads all of them (ADR 0102).
 * Each step verifies its manifest and is safe to repeat on an existing store.
 */
export async function installFinancialStore(db: PGlite): Promise<PGliteStore> {
  await applyPgliteBaseline(db);
  const store = new PGliteStore(db);
  await applyPgliteCaptureManifestSchema(store);
  await applyPgliteInvestmentStatementFactsSchema(store);
  await applyPgliteOperationalBaseline(store);
  await applyPgliteMaicoinOperationalSchema(store);
  await applyPglitePreviewFinancialDataSchema(store);
  await applyPgliteManualAssetsSchema(store);
  await applyPgliteCashFlowTransferSchema(store);
  await applyPgliteCardIdentitySecretSchema(store);
  await applyPgliteTaxonomySeed(store);
  await applyPgliteReadIndexes(store);
  await applyPgliteKindDuplicateCleanup(store);
  await applyPgliteKindRederivation(store);
  await applyPgliteMaicoinTwdTransferPass(store);
  return store;
}
