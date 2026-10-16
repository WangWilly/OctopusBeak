import type { CanonicalSourceAccountIdentifierKind } from "../canonical/canonical-source-evidence.ts";
import type { PGliteStore } from "./transaction.ts";

export type AccountIdentityContinuityRequest = Readonly<{
  integrationNamespace: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  stream: string;
  identifier: Readonly<{ kind: CanonicalSourceAccountIdentifierKind; value: string }>;
}>;

export type AccountIdentityContinuity =
  | Readonly<{ status: "unseen" }>
  | Readonly<{ status: "continued"; sourceAccountKey: string }>
  | Readonly<{ status: "ambiguous"; accountCount: number }>;

/**
 * The admitted account that already carries this evidenced identifier in one
 * connection, epoch, and stream. A provider may rewrite the value its source
 * account key hashes; the identifier is what stays fixed (ADR 0049).
 */
export async function resolvePGliteAccountIdentityContinuity(
  store: Pick<PGliteStore, "query">,
  request: AccountIdentityContinuityRequest,
): Promise<AccountIdentityContinuity> {
  const rows = await store.query<{ source_account_key: string }>(
    `SELECT DISTINCT account.source_account_key
       FROM financial_account_identifier_observations observation
       JOIN financial_accounts account ON account.account_id = observation.account_id
       JOIN identity_epochs epoch ON epoch.identity_epoch_id = account.identity_epoch_id
       JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
      WHERE connection.integration_namespace = $1
        AND connection.source_connection_key = $2
        AND epoch.epoch_key = $3
        AND account.stream = $4
        AND observation.identifier_kind = $5
        AND observation.identifier_value = $6
      ORDER BY account.source_account_key`,
    [
      request.integrationNamespace,
      request.sourceConnectionKey,
      request.identityEpochKey,
      request.stream,
      request.identifier.kind,
      request.identifier.value,
    ],
  );
  const [only, ...rest] = rows.rows;
  if (!only) return { status: "unseen" };
  if (rest.length === 0) return { status: "continued", sourceAccountKey: only.source_account_key };
  return { status: "ambiguous", accountCount: rows.rows.length };
}
