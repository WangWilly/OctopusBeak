import type { CardIdentitySecret } from "../../lib/shared-identity/card-identity-secret.ts";
import { applyOperationalMigrations } from "./operational-migrations.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * Which Card identity secret each integration namespace's credit-card
 * accounts were derived from (ADR 0149), as a one-way verifier.
 */
export const CARD_IDENTITY_SECRET_TABLES = ["card_identity_secrets"] as const;

const CARD_IDENTITY_SECRET_MIGRATIONS = [{
  id: "card-identity-secrets-v1",
  sql: `CREATE TABLE card_identity_secrets (
    integration_namespace TEXT PRIMARY KEY CHECK (integration_namespace <> ''),
    verifier TEXT NOT NULL CHECK (verifier ~ '^[0-9a-f]{64}$')
  );`,
}] as const;

export function applyPgliteCardIdentitySecretSchema(store: PGliteStore): Promise<void> {
  return applyOperationalMigrations(
    store,
    "Card identity secrets",
    CARD_IDENTITY_SECRET_MIGRATIONS,
    CARD_IDENTITY_SECRET_TABLES,
  );
}

type Reader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;

type Standing = "matches" | "adopt" | "split";

/**
 * A namespace splits when it holds credit-card accounts and they came from
 * another secret: its record names another verifier, or it has no record yet
 * and this install created the current secret, so the accounts cannot have
 * come from it. A namespace with no card account, or an unrecorded one whose
 * secret was found in place, adopts the current verifier.
 */
function standing(recorded: string | undefined, holdsCards: boolean, current: CardIdentitySecret): Standing {
  if (recorded === current.verifier) return "matches";
  if (!holdsCards) return "adopt";
  if (recorded === undefined && !current.created) return "adopt";
  return "split";
}

/** Integration namespaces holding a credit-card account, which a new Card identity secret would split. */
export async function cardAccountNamespaces(reader: Reader): Promise<readonly string[]> {
  return [...await namespacesHoldingCards(reader)].sort();
}

async function namespacesHoldingCards(reader: Reader): Promise<ReadonlySet<string>> {
  const rows = await reader.query<{ integration_namespace: string }>(
    `SELECT DISTINCT connection.integration_namespace
       FROM financial_accounts account
       JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
      WHERE account.stream = 'credit-card'`,
  );
  return new Set(rows.rows.map((row) => row.integration_namespace));
}

async function recordedVerifiers(reader: Reader): Promise<ReadonlyMap<string, string>> {
  const rows = await reader.query<{ integration_namespace: string; verifier: string }>(
    "SELECT integration_namespace, verifier FROM card_identity_secrets",
  );
  return new Map(rows.rows.map((row) => [row.integration_namespace, row.verifier]));
}

/**
 * Admits a card capture in `namespace` under the `current` secret: returns
 * false when the namespace's card accounts came from another secret, so the
 * capture would admit a second account beside each of them. Otherwise it
 * records the current verifier for the namespace. An unknown `current`
 * admits and records nothing.
 */
export async function admitCardIdentitySecret(
  transaction: Reader,
  namespace: string,
  current: CardIdentitySecret | undefined,
): Promise<boolean> {
  if (current === undefined) return true;
  const recorded = (await recordedVerifiers(transaction)).get(namespace);
  const holdsCards = (await namespacesHoldingCards(transaction)).has(namespace);
  const verdict = standing(recorded, holdsCards, current);
  if (verdict === "split") return false;
  if (verdict === "adopt") {
    await transaction.query(
      `INSERT INTO card_identity_secrets(integration_namespace, verifier) VALUES ($1, $2)
         ON CONFLICT (integration_namespace) DO UPDATE SET verifier = EXCLUDED.verifier`,
      [namespace, current.verifier],
    );
  }
  return true;
}

/** Namespaces whose card accounts came from a secret other than `current`. Reads only. */
export async function cardIdentitySecretSplitNamespaces(
  reader: Reader,
  current: CardIdentitySecret | undefined,
): Promise<readonly string[]> {
  if (current === undefined) return [];
  const recorded = await recordedVerifiers(reader);
  return [...await namespacesHoldingCards(reader)]
    .filter((namespace) => standing(recorded.get(namespace), true, current) === "split")
    .sort();
}
