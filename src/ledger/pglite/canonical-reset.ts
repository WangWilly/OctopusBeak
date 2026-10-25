import { randomUUID } from "node:crypto";
import {
  CANONICAL_SOURCE_ROUTE_REGISTRY,
  canonicalSourceRouteRegistration,
  type CanonicalSourceRouteRegistration,
} from "../canonical/canonical-source-route-registry.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * Every table a Canonical Reset keeps; every other table in the store holds
 * financial state and is emptied. Kept are schema metadata, the trusted source
 * contract catalog and reference data the baseline installs, and Preserved
 * Operational Configuration: exchange rates and the automation run history the
 * schedulers read to decide whether an occurrence already ran.
 */
export const CANONICAL_RESET_PRESERVED_TABLES: ReadonlySet<string> = new Set([
  "pglite_baseline_metadata",
  "pglite_invariant_manifest",
  "pglite_operational_baseline_metadata",
  "pglite_operational_migrations",
  "schema_migrations",
  "source_contract_catalog",
  "source_contract_rule_tuples",
  "automatic_enrichment_authority_routes",
  "canonical_grouped_role_contracts",
  "enrichment_producer_versions",
  "taxonomy_applicability",
  "taxonomy_codes",
  "taxonomy_localizations",
  "taxonomy_producer_compatibility",
  "taxonomy_versions",
  "exchange_rates",
  "automation_task_runs",
  "automation_task_run_commit_attempts",
  "automation_task_prerequisite_notices",
]);

const quoted = (identifier: string) => `"${identifier.replaceAll("\"", "\"\"")}"`;

/**
 * Replace all financial state with an empty canonical store in one
 * transaction, so a crash leaves either the old store or the empty one and a
 * retry finishes the job.
 */
export async function resetPGliteCanonicalStore(store: PGliteStore): Promise<void> {
  await store.transaction(async (transaction) => {
    const tables = await transaction.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    const latest = (await transaction.query<{ sequence: number | string; recorded_at_utc_us: number | string | null }>(
      "SELECT COALESCE(MAX(commit_sequence), 0) AS sequence, MAX(recorded_at_utc_us) AS recorded_at_utc_us FROM canonical_commits",
    )).rows[0];
    const financial = tables.rows
      .map(({ table_name }) => table_name)
      .filter((table) => !CANONICAL_RESET_PRESERVED_TABLES.has(table));
    // TRUNCATE skips the per-row append-only guards and gives each table new
    // storage, so the deleted rows leave the table files at commit.
    await transaction.exec(`TRUNCATE ${financial.map(quoted).join(", ")}`);
    // The knowledge version is MAX(commit_sequence). An empty rebuild commit
    // keeps it increasing, so no cache or page keyed by a version from before
    // the reset can match one after it, and live views observe the change.
    await transaction.query(
      `INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
       VALUES ($1, $2, $3, 'automatic/pglite-canonical-reset/v1', 'projection_rebuild')`,
      [
        Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex")),
        Number(latest?.sequence ?? 0) + 1,
        Math.max(Date.now() * 1000, Number(latest?.recorded_at_utc_us ?? 0) + 1),
      ],
    );
  });
  await store.exec("CHECKPOINT");
}

type SupersededEpoch = Readonly<{ namespace: string; stream: string; epoch_key: string }>;

function supersededEpochs(registrations: readonly CanonicalSourceRouteRegistration[]): readonly SupersededEpoch[] {
  return registrations.flatMap((registration) =>
    (registration.supersededIdentityEpochs ?? []).map((epochKey) => ({
      namespace: registration.integrationNamespace,
      stream: registration.stream,
      epoch_key: epochKey,
    })));
}

const ALL_SUPERSEDED_EPOCHS = JSON.stringify(supersededEpochs(CANONICAL_SOURCE_ROUTE_REGISTRY));

/** Source Connections holding a Financial Account under any of the epochs in `$1`. */
const SUPERSEDED_ACCOUNTS_SQL = `
  SELECT DISTINCT connection.integration_namespace, connection.source_connection_key
    FROM financial_accounts account
    JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
    JOIN identity_epochs epoch ON epoch.identity_epoch_id = account.identity_epoch_id
   WHERE (connection.integration_namespace, account.stream, epoch.epoch_key) IN (
     SELECT * FROM jsonb_to_recordset($1::jsonb) AS superseded(namespace TEXT, stream TEXT, epoch_key TEXT)
   )`;

/**
 * Whether the capture's Source Connection still holds a Financial Account
 * under an identity epoch its route declares superseded (ADR 0062). Such a
 * capture would admit a second account beside the old one, so it waits for a
 * Canonical Reset.
 */
export async function canonicalResetRequiredFor(
  transaction: Pick<PGliteTransaction, "query">,
  capture: Readonly<{ routeKey: string; integrationNamespace: string; sourceConnectionKey: string }>,
): Promise<boolean> {
  const route = canonicalSourceRouteRegistration(capture.routeKey);
  const rows = await transaction.query(
    `${SUPERSEDED_ACCOUNTS_SQL} AND connection.integration_namespace = $2 AND connection.source_connection_key = $3`,
    [JSON.stringify(supersededEpochs(route ? [route] : [])), capture.integrationNamespace, capture.sourceConnectionKey],
  );
  return rows.rows.length > 0;
}

/** Integration namespaces whose captures the store refuses until a Canonical Reset. */
export async function canonicalResetRequiredNamespaces(
  store: Pick<PGliteStore, "query">,
): Promise<readonly string[]> {
  const rows = await store.query<{ integration_namespace: string }>(SUPERSEDED_ACCOUNTS_SQL, [ALL_SUPERSEDED_EPOCHS]);
  return [...new Set(rows.rows.map((row) => row.integration_namespace))].sort();
}
