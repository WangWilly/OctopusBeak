import { createHash } from "node:crypto";
import { refreshPGliteCurrentProjectionInTransaction } from "./projection.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * Kind derivations that changed after a store's rows were projected. Each
 * entry re-derives every current Kind once, so rows captured before a new
 * producer or rule get their Kind on the next open, without a re-sync. A
 * store with no projected rows only records the entries. An entry is never
 * edited or removed; a later change adds one.
 *
 * The pass re-derives every row rather than the rows the change touches: the
 * Kind selection reads a transaction's whole assertion history, and filtering
 * that by a long list of transactions costs more than reading it once.
 */
const KIND_REDERIVATIONS = [
  // ADR 0138: investment and loan rows read their Kind from their recorded
  // event, and a deposit outflow a one-to-one loan repayment relation names
  // reads payment.loan.
  "kind-rederivation-account-events-v1",
  // Cathay's own deposit labels, Cathay foreign-currency deposits, TDCC
  // settlement deposits read by their maintaining Institution, and the bank
  // labels for currency exchange, investment settlement, dividends and
  // deposit interest, with payload keys no longer read as words.
  "kind-rederivation-deposit-kind-gaps-v1",
  // ADR 0141: interest charged and bank, card and loan fees take the
  // interest-and-fees category, derived from the Kind each row already has.
  "kind-rederivation-interest-and-fees-category-v1",
  // A card outflow whose issuer label names the card's interest or fee reads
  // interest.charged or fee.card, and so takes the interest-and-fees category.
  "kind-rederivation-credit-card-charge-kinds-v1",
] as const;

const signature = (id: string) => createHash("sha256").update(id).digest("hex");

export async function applyPgliteKindRederivation(store: PGliteStore): Promise<void> {
  await store.transaction(async (transaction) => {
    const applied = await transaction.query<{ migration_key: string }>(
      "SELECT migration_key FROM pglite_operational_migrations WHERE migration_key = ANY($1::text[])",
      [[...KIND_REDERIVATIONS]],
    );
    const done = new Set(applied.rows.map((row) => row.migration_key));
    const pending = KIND_REDERIVATIONS.filter((id) => !done.has(id));
    if (pending.length === 0) return;
    const latest = (await transaction.query<{ commit_id: Uint8Array; commit_sequence: number | string }>(
      "SELECT commit_id, commit_sequence FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1",
    )).rows[0];
    const projected = (await transaction.query("SELECT 1 FROM active_projection_generation WHERE singleton_id = 1")).rows.length > 0;
    if (latest && projected)
      await refreshPGliteCurrentProjectionInTransaction(transaction, {
        commitId: latest.commit_id,
        cutoffSequence: Number(latest.commit_sequence),
        transactionIds: [],
        refreshEnrichmentAll: true,
      });
    for (const id of pending)
      await transaction.query(
        "INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)",
        [id, signature(id)],
      );
  });
}
