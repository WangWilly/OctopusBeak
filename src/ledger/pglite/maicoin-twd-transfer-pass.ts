import { createHash } from "node:crypto";
import { resolvePGliteMaicoinTwdTransfersInTransaction } from "./relations.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * ADR 0145: a store that already holds a MaiCoin TWD movement and its bank
 * row gets their funding relation, and the bank row its Kind, on the next
 * open, without a re-sync. Later captures resolve the match as they land.
 */
const PASS_ID = "maicoin-twd-funding-relations-v1";

export async function applyPgliteMaicoinTwdTransferPass(store: PGliteStore): Promise<void> {
  await store.transaction(async (transaction) => {
    const applied = await transaction.query("SELECT 1 FROM pglite_operational_migrations WHERE migration_key = $1", [PASS_ID]);
    if (applied.rows.length > 0) return;
    const projected = (await transaction.query("SELECT 1 FROM active_projection_generation WHERE singleton_id = 1")).rows.length > 0;
    if (projected) await resolvePGliteMaicoinTwdTransfersInTransaction(transaction);
    await transaction.query(
      "INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)",
      [PASS_ID, createHash("sha256").update(PASS_ID).digest("hex")],
    );
  });
}
