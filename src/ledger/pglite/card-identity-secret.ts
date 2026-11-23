import { createHash } from "node:crypto";
import { applyOperationalMigrations } from "./operational-migrations.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * The ledger's record of which Card identity secret its credit-card accounts
 * were derived from (ADR 0149). It holds a one-way verifier, never the secret.
 */
export const CARD_IDENTITY_SECRET_TABLES = ["card_identity_secret"] as const;

const CARD_IDENTITY_SECRET_MIGRATIONS = [{
  id: "card-identity-secret-v1",
  sql: `CREATE TABLE card_identity_secret (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    verifier TEXT NOT NULL CHECK (verifier ~ '^[0-9a-f]{64}$')
  );`,
}] as const;

export function applyPgliteCardIdentitySecretSchema(store: PGliteStore): Promise<void> {
  return applyOperationalMigrations(
    store,
    "Card identity secret",
    CARD_IDENTITY_SECRET_MIGRATIONS,
    CARD_IDENTITY_SECRET_TABLES,
  );
}

/** The verifier the ledger compares; it cannot be turned back into the secret. */
export function cardIdentitySecretVerifier(secret: string): string {
  return createHash("sha256").update("octopusbeak/card-identity-secret-verifier/v1\0").update(secret).digest("hex");
}

type Reader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;

/**
 * Integration namespaces whose credit-card accounts were derived from a
 * secret other than `current`. A capture in one of them would admit a second
 * account beside each existing one, so it waits for a Canonical Reset.
 *
 * With `adopt`, which a commit passes, the ledger records `current` when it
 * has no record yet, or when no credit-card account would split. An unknown
 * `current` changes nothing.
 */
export async function cardIdentitySecretSplitNamespaces(
  transaction: Reader,
  current: string | undefined,
  { adopt }: Readonly<{ adopt: boolean }>,
): Promise<readonly string[]> {
  if (current === undefined) return [];
  const recorded = (await transaction.query<{ verifier: string }>(
    "SELECT verifier FROM card_identity_secret WHERE singleton",
  )).rows[0]?.verifier;
  if (recorded === current) return [];
  const holders = recorded === undefined ? [] : (await transaction.query<{ integration_namespace: string }>(
    `SELECT DISTINCT connection.integration_namespace
       FROM financial_accounts account
       JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
      WHERE account.stream = 'credit-card'
      ORDER BY connection.integration_namespace`,
  )).rows.map((row) => row.integration_namespace);
  if (holders.length > 0 || !adopt) return holders;
  await transaction.query(
    `INSERT INTO card_identity_secret(singleton, verifier) VALUES (TRUE, $1)
       ON CONFLICT (singleton) DO UPDATE SET verifier = EXCLUDED.verifier`,
    [current],
  );
  return [];
}
