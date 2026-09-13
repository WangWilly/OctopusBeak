import { DatabaseSync } from "node:sqlite";
import {
  CREDIT_CARD_DIRECTION_ENRICHMENT_CONTRACT_VERSION,
  CREDIT_CARD_DIRECTION_ENRICHMENT_EVIDENCE_KIND,
  CREDIT_CARD_DIRECTION_ENRICHMENT_PRODUCER_ID,
  CREDIT_CARD_DIRECTION_ENRICHMENT_PRODUCER_VERSION,
  CREDIT_CARD_DIRECTION_ENRICHMENT_ROUTE_SCOPES,
} from "./transaction-taxonomy.ts";
import {
  blob,
  idToString,
} from "./canonical-schema-implementation.ts";
import { openCanonicalDatabase } from "./canonical-database.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import {
  commitCanonicalAutomaticEnrichmentRun,
  commitCanonicalAutomaticEnrichmentRunInTransaction,
  type CanonicalEnrichmentCommitResult,
  type CanonicalEnrichmentOutput,
  type CanonicalEnrichmentRunInput,
} from "./canonical-enrichment.ts";

const CREDIT_CARD_STREAM = "credit-card" as const;
const DEFAULT_RULE_LINEAGE = `${CREDIT_CARD_DIRECTION_ENRICHMENT_CONTRACT_VERSION}/direction-fallback`;

export type CreditCardDirectionEnrichmentScope = Readonly<{
  integrationNamespace: "yuanta" | "esun" | "fubon";
  sourceConnectionKey: string;
  identityEpoch: string;
}>;

export type CreditCardDirectionEnrichmentOptions = Readonly<{
  observedAt?: string;
  ruleLineage?: string;
}>;

type CurrentCreditCardTransaction = Readonly<{
  transactionId: string;
  sourceRecordId: string;
  direction: string;
  sourceConnectionKey: string;
  identityEpoch: string;
}>;

type CurrentKind = Readonly<{
  origin: string;
  value: string;
}>;

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required.`);
  return value.trim();
}

function canonicalIdBlob(value: string, label: string): Buffer {
  const normalized = value.trim().replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/iu.test(normalized))
    throw new Error(`${label} is not a canonical ID.`);
  return blob(Buffer.from(normalized, "hex"));
}

function canonicalIdKey(value: string, label: string): string {
  return canonicalIdBlob(value, label).toString("hex");
}

function readCurrentTransactions(
  db: DatabaseSync,
  scope: CreditCardDirectionEnrichmentScope,
): CurrentCreditCardTransaction[] {
  const projection = createCanonicalProjectionRuntime(db).read({
    kind: "current",
    families: ["transactions", "financial-accounts"],
    scope: { sourceConnectionKey: scope.sourceConnectionKey },
  });
  const projectedAccounts = projection.families["financial-accounts"].filter(
    (account) =>
      account.integrationNamespace === scope.integrationNamespace &&
      account.sourceConnectionKey === scope.sourceConnectionKey &&
      account.stream === CREDIT_CARD_STREAM,
  );
  if (projectedAccounts.length === 0) return [];

  // The Runtime intentionally exposes the stable identity IDs but not the
  // epoch key. Resolve that display/contract metadata from canonical facts;
  // projection rows remain the sole source for selecting current records.
  const accountPlaceholders = projectedAccounts.map(() => "?").join(",");
  const accountRows = db.prepare(`
    SELECT account.account_id,
           connection.integration_namespace,
           connection.source_connection_key,
           account.stream,
           epoch.epoch_key AS identity_epoch
      FROM financial_accounts account
      JOIN source_connections connection
        ON connection.source_connection_id = account.source_connection_id
      JOIN identity_epochs epoch
        ON epoch.identity_epoch_id = account.identity_epoch_id
     WHERE account.account_id IN (${accountPlaceholders})
  `).all(
    ...projectedAccounts.map((account) => canonicalIdBlob(account.accountId, "Projected account ID")),
  ) as Array<Record<string, unknown>>;
  const accountsById = new Map(
    accountRows.map((row) => [
      canonicalIdKey(idToString(blob(row.account_id)), "Canonical account ID"),
      {
        integrationNamespace: requiredText(row.integration_namespace, "Credit-card integration namespace"),
        sourceConnectionKey: requiredText(row.source_connection_key, "Credit-card source connection key"),
        stream: requiredText(row.stream, "Credit-card account stream"),
        identityEpoch: requiredText(row.identity_epoch, "Credit-card identity epoch"),
      },
    ]),
  );
  const selectedTransactions = projection.families.transactions.filter((transaction) => {
    const account = accountsById.get(canonicalIdKey(transaction.accountId, "Projected transaction account ID"));
    return account?.integrationNamespace === scope.integrationNamespace &&
      account.sourceConnectionKey === scope.sourceConnectionKey &&
      account.stream === CREDIT_CARD_STREAM &&
      account.identityEpoch === scope.identityEpoch;
  });
  if (selectedTransactions.length === 0) return [];

  // A projection transaction carries its current revision ID, while the
  // retained source-record ID belongs to the immutable revision fact.
  const revisionPlaceholders = selectedTransactions.map(() => "?").join(",");
  const revisionRows = db.prepare(`
    SELECT revision.transaction_id, revision.revision_id, revision.source_record_id
      FROM transaction_revisions revision
     WHERE revision.revision_id IN (${revisionPlaceholders})
  `).all(
    ...selectedTransactions.map((transaction) => canonicalIdBlob(transaction.revisionId, "Projected revision ID")),
  ) as Array<Record<string, unknown>>;
  const sourceRecordByRevision = new Map(
    revisionRows.map((row) => [
      `${canonicalIdKey(idToString(blob(row.transaction_id)), "Canonical transaction ID")}:${canonicalIdKey(idToString(blob(row.revision_id)), "Canonical revision ID")}`,
      idToString(blob(row.source_record_id)),
    ]),
  );
  return selectedTransactions.map((transaction) => {
    const direction = requiredText(transaction.direction, "Credit-card transaction direction");
    if (direction !== "outflow" && direction !== "inflow")
      throw new Error(`Credit-card transaction direction ${direction} is unsupported.`);
    const sourceRecordId = sourceRecordByRevision.get(
      `${canonicalIdKey(transaction.transactionId, "Projected transaction ID")}:${canonicalIdKey(transaction.revisionId, "Projected revision ID")}`,
    );
    if (!sourceRecordId)
      throw new Error("Credit-card current transaction source record is missing.");
    const account = accountsById.get(canonicalIdKey(transaction.accountId, "Projected transaction account ID"));
    if (!account)
      throw new Error("Credit-card current transaction account is missing.");
    return {
      transactionId: idToString(canonicalIdBlob(transaction.transactionId, "Projected transaction ID")),
      sourceRecordId,
      direction,
      sourceConnectionKey: account.sourceConnectionKey,
      identityEpoch: account.identityEpoch,
    };
  });
}

function readCurrentKinds(
  db: DatabaseSync,
  transactions: readonly CurrentCreditCardTransaction[],
): ReadonlyMap<string, CurrentKind> {
  if (transactions.length === 0) return new Map();
  const enrichment = createCanonicalProjectionRuntime(db).read({
    kind: "current",
    families: ["transaction-enrichment"],
    scope: { transactionIds: transactions.map((transaction) => transaction.transactionId) },
  }).families["transaction-enrichment"];
  return new Map(
    enrichment
      .filter((row) => row.fieldName === "kind")
      .map((row) => [
        row.transactionId,
        { origin: row.origin, value: row.taxonomyCode ?? row.value },
      ]),
  );
}

function outputForTransaction(
  transaction: CurrentCreditCardTransaction,
  currentKind: CurrentKind | undefined,
): CanonicalEnrichmentOutput {
  const evidence = {
    kind: CREDIT_CARD_DIRECTION_ENRICHMENT_EVIDENCE_KIND,
    sourceRecordId: transaction.sourceRecordId,
    sourceField: "direction",
    sourceValue: transaction.direction,
    contractVersion: CREDIT_CARD_DIRECTION_ENRICHMENT_CONTRACT_VERSION,
  } as const;
  // A later source-supported Kind is authoritative even when this fallback
  // runs after it. Marking the fallback absent also withdraws an older
  // direction assertion, while leaving the source assertion untouched.
  if (currentKind?.origin === "source") {
    return {
      transactionId: transaction.transactionId,
      field: "kind",
      origin: "derived",
      state: "unsupported",
      evidence,
    };
  }
  return {
    transactionId: transaction.transactionId,
    field: "kind",
    origin: "derived",
    value: transaction.direction === "outflow" ? "purchase" : "refund",
    confidenceBasisPoints: 10_000,
    evidence,
  };
}

function readCaptureScopes(
  db: DatabaseSync,
  captureIds: readonly string[],
): CreditCardDirectionEnrichmentScope[] {
  if (captureIds.length === 0) return [];
  const placeholders = captureIds.map(() => "?").join(",");
  const rows = db.prepare(`
      SELECT DISTINCT connection.integration_namespace,
                      connection.source_connection_key,
                      epoch.epoch_key AS identity_epoch
        FROM source_captures capture
        JOIN capture_scopes scope
          ON scope.capture_id = capture.capture_id
        JOIN source_connections connection
          ON connection.source_connection_id = scope.source_connection_id
        JOIN identity_epochs epoch
          ON epoch.identity_epoch_id = scope.identity_epoch_id
       WHERE capture.capture_key IN (${placeholders})
         AND scope.stream = ?
       ORDER BY connection.integration_namespace,
                connection.source_connection_key,
                epoch.epoch_key
    `).all(...captureIds, CREDIT_CARD_STREAM) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const integrationNamespace = requiredText(
      row.integration_namespace,
      "Credit-card integration namespace",
    );
    if (
      !(CREDIT_CARD_DIRECTION_ENRICHMENT_ROUTE_SCOPES as readonly string[]).includes(
        `${integrationNamespace}/${CREDIT_CARD_STREAM}`,
      )
    )
      throw new Error(`Credit-card direction enrichment does not support ${integrationNamespace}.`);
    return {
      integrationNamespace: integrationNamespace as CreditCardDirectionEnrichmentScope["integrationNamespace"],
      sourceConnectionKey: requiredText(row.source_connection_key, "Credit-card source connection key"),
      identityEpoch: requiredText(row.identity_epoch, "Credit-card identity epoch"),
    };
  });
}

function buildEnrichmentInput(
  db: DatabaseSync,
  scope: CreditCardDirectionEnrichmentScope,
  options: CreditCardDirectionEnrichmentOptions,
): CanonicalEnrichmentRunInput | null {
  const transactions = readCurrentTransactions(db, scope);
  if (transactions.length === 0) return null;
  const currentKinds = readCurrentKinds(db, transactions);
  return {
    sourceConnectionKey: scope.sourceConnectionKey,
    identityEpoch: scope.identityEpoch,
    stream: CREDIT_CARD_STREAM,
    producerId: CREDIT_CARD_DIRECTION_ENRICHMENT_PRODUCER_ID,
    producerVersion: CREDIT_CARD_DIRECTION_ENRICHMENT_PRODUCER_VERSION,
    ruleLineage: options.ruleLineage?.trim() || DEFAULT_RULE_LINEAGE,
    observedAt: options.observedAt,
    declaredSubjects: transactions.map((transaction) => ({
      transactionId: transaction.transactionId,
      fields: ["kind"] as const,
    })),
    outputs: transactions.map((transaction) =>
      outputForTransaction(transaction, currentKinds.get(transaction.transactionId))),
  };
}

/**
 * Persist the direction fallback for one admitted credit-card source scope.
 * The source capture remains the immutable evidence; this separate derived
 * run records the rule version and source record used to produce each Kind.
 */
export async function commitCanonicalCreditCardDirectionEnrichment(
  ledgerDir: string,
  scope: CreditCardDirectionEnrichmentScope,
  options: CreditCardDirectionEnrichmentOptions = {},
): Promise<CanonicalEnrichmentCommitResult | null> {
  const db = openCanonicalDatabase(ledgerDir, { readOnly: true });
  let input: CanonicalEnrichmentRunInput | null;
  try {
    input = buildEnrichmentInput(db, scope, options);
  } finally {
    db.close();
  }
  if (!input) return null;

  return commitCanonicalAutomaticEnrichmentRun(ledgerDir, input);
}

/**
 * Commit the direction fallback while the source capture admission
 * transaction is still open.  This is the required path for recollection:
 * the source capture and its Kind assertion either commit together or the
 * admission rolls back as one SQLite unit.
 */
export function commitCanonicalCreditCardDirectionEnrichmentForCapturesInTransaction(
  db: DatabaseSync,
  captureIds: readonly string[],
  options: CreditCardDirectionEnrichmentOptions = {},
): readonly CanonicalEnrichmentCommitResult[] {
  const results: CanonicalEnrichmentCommitResult[] = [];
  for (const scope of readCaptureScopes(db, captureIds)) {
    const input = buildEnrichmentInput(db, scope, options);
    if (input)
      results.push(commitCanonicalAutomaticEnrichmentRunInTransaction(db, input));
  }
  return results;
}

/**
 * Resolve the canonical scopes touched by source captures and run the
 * direction producer once per source connection/identity epoch.  Resolving
 * scopes from persisted captures is required because some adapters domain
 * separate or hash the caller-provided connection key before admission.
 */
export async function commitCanonicalCreditCardDirectionEnrichmentForCaptures(
  ledgerDir: string,
  captureIds: readonly string[],
  options: CreditCardDirectionEnrichmentOptions = {},
): Promise<readonly CanonicalEnrichmentCommitResult[]> {
  if (captureIds.length === 0) return [];
  const db = openCanonicalDatabase(ledgerDir, { readOnly: true });
  let scopes: CreditCardDirectionEnrichmentScope[];
  try {
    scopes = readCaptureScopes(db, captureIds);
  } finally {
    db.close();
  }

  const results: CanonicalEnrichmentCommitResult[] = [];
  for (const scope of scopes) {
    const result = await commitCanonicalCreditCardDirectionEnrichment(
      ledgerDir,
      scope,
      options,
    );
    if (result) results.push(result);
  }
  return results;
}
