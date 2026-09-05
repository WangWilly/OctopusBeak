import { DatabaseSync } from "node:sqlite";
import {
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
  type EnrichmentField,
} from "./transaction-taxonomy.ts";
import {
  blob,
  idFromString,
  idToString,
} from "./canonical-schema-implementation.ts";
import { openCanonicalDatabase } from "./canonical-database.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import {
  commitCanonicalAutomaticEnrichmentRun,
  type CanonicalEnrichmentCommitResult,
  type CanonicalEnrichmentOutput,
} from "./canonical-enrichment.ts";

const CATHAY_STREAM = "domestic-deposit";
const CATHAY_CONTRACT_VERSION = "cathay/domestic-deposit/v1";
const DEFAULT_RULE_LINEAGE = `${CATHAY_CONTRACT_VERSION}/description-taxonomy`;

type CurrentCathayTransaction = Readonly<{
  transactionId: string;
  sourceRecordId: string;
  sourceConnectionKey: string;
  identityEpoch: string;
  stream: string;
  description: string | null;
}>;

export type CathayDescriptionClassification = Readonly<{
  candidates: readonly Readonly<{ value: string; confidenceBasisPoints: number }>[];
  tie: boolean;
}>;

export type CathayAutomaticEnrichmentOptions = Readonly<{
  sourceConnectionKey?: string;
  identityEpoch?: string;
  observedAt?: string;
  ruleLineage?: string;
  /** Select a stable subset in tests or when a caller is replaying a route. */
  transactionIds?: readonly string[];
}>;

function readCurrentCathayTransactions(
  db: DatabaseSync,
  options: CathayAutomaticEnrichmentOptions,
): CurrentCathayTransaction[] {
  const clauses = [
    "connection.integration_namespace = 'cathay'",
    "account.stream = ?",
  ];
  const parameters: Array<string | Uint8Array> = [CATHAY_STREAM];
  if (options.sourceConnectionKey) {
    clauses.push("connection.source_connection_key = ?");
    parameters.push(options.sourceConnectionKey);
  }
  if (options.identityEpoch) {
    clauses.push("epoch.epoch_key = ?");
    parameters.push(options.identityEpoch);
  }
  if (options.transactionIds && options.transactionIds.length > 0) {
    const ids = options.transactionIds.map((id) => idFromString(id));
    clauses.push(`transaction_row.transaction_id IN (${ids.map(() => "?").join(",")})`);
    parameters.push(...ids);
  } else if (options.transactionIds && options.transactionIds.length === 0) {
    return [];
  }
  const candidates = db.prepare(`
    SELECT transaction_row.transaction_id, connection.source_connection_key,
           epoch.epoch_key AS identity_epoch, account.stream
      FROM financial_transactions transaction_row
      JOIN financial_accounts account
        ON account.account_id = transaction_row.account_id
      JOIN source_connections connection
        ON connection.source_connection_id = account.source_connection_id
      JOIN identity_epochs epoch
        ON epoch.identity_epoch_id = account.identity_epoch_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY account.account_no, transaction_row.source_sequence, transaction_row.transaction_id
  `).all(...parameters) as Array<Record<string, unknown>>;
  if (candidates.length === 0) return [];
  const candidateById = new Map(
    candidates.map((row) => [idToString(blob(row.transaction_id)), row]),
  );
  const projection = createCanonicalProjectionRuntime(db).read({
    kind: "current",
    families: ["transactions"],
    scope: {
      ...(options.sourceConnectionKey
        ? { sourceConnectionKey: options.sourceConnectionKey }
        : {}),
      transactionIds: [...candidateById.keys()],
    },
  });
  const readDescription = db.prepare(`
    SELECT revision.source_record_id,
           COALESCE(source_record.description, revision.description) AS description
      FROM transaction_revisions revision
      JOIN source_records source_record
        ON source_record.source_record_id = revision.source_record_id
     WHERE revision.revision_id = ?
  `);
  return projection.families.transactions.flatMap((row) => {
    const transactionId = idToString(
      Buffer.from(row.transactionId.replaceAll("-", ""), "hex"),
    );
    const candidate = candidateById.get(transactionId);
    if (!candidate) return [];
    const source = readDescription.get(
      Buffer.from(row.revisionId.replaceAll("-", ""), "hex"),
    ) as Record<string, unknown> | undefined;
    if (!source) return [];
    return [{
      transactionId,
      sourceRecordId: idToString(blob(source.source_record_id)),
      sourceConnectionKey: String(candidate.source_connection_key),
      identityEpoch: String(candidate.identity_epoch),
      stream: String(candidate.stream),
      description: typeof source.description === "string" ? source.description : null,
    }];
  });
}

/**
 * The Cathay provider retains only the compact description as source
 * evidence. These rules deliberately produce Derived Kind assertions; they
 * never promote a description, merchant name, MCC, or a combined signal to
 * Source taxonomy evidence.
 */
export function classifyCathayDescription(
  description: string | null | undefined,
): CathayDescriptionClassification {
  if (!description || description.trim() === "") return { candidates: [], tie: false };
  const text = description.toLowerCase();
  const candidates: Array<{ value: string; confidenceBasisPoints: number }> = [];
  if (/\bdeposit\b/u.test(text))
    candidates.push({ value: "cash.deposit", confidenceBasisPoints: 9_200 });
  if (/\btransfer\b/u.test(text))
    candidates.push({ value: "transfer.internal", confidenceBasisPoints: 8_600 });
  if (/\bcredit(?:\s+card)?\b/u.test(text))
    candidates.push({ value: "payment.credit_card", confidenceBasisPoints: 8_200 });
  if (candidates.length === 0) return { candidates, tie: false };
  const highest = Math.max(...candidates.map((candidate) => candidate.confidenceBasisPoints));
  return {
    candidates,
    tie: candidates.filter((candidate) => candidate.confidenceBasisPoints === highest).length > 1,
  };
}

function unsupportedOutput(
  transaction: CurrentCathayTransaction,
  field: EnrichmentField,
): CanonicalEnrichmentOutput {
  return {
    transactionId: transaction.transactionId,
    field,
    origin: "derived",
    state: "unsupported",
    evidence: {
      kind: "description",
      sourceRecordId: transaction.sourceRecordId,
      sourceValue: transaction.description,
      contractVersion: CATHAY_CONTRACT_VERSION,
    },
  };
}

function outputsForTransaction(
  transaction: CurrentCathayTransaction,
): CanonicalEnrichmentOutput[] {
  const classification = classifyCathayDescription(transaction.description);
  const evidence = {
    kind: "description",
    sourceRecordId: transaction.sourceRecordId,
    sourceValue: transaction.description,
    contractVersion: CATHAY_CONTRACT_VERSION,
    candidates: classification.candidates,
  } as const;
  const outputs: CanonicalEnrichmentOutput[] = [
    {
      transactionId: transaction.transactionId,
      field: "kind",
      origin: "derived",
      state: classification.candidates.length === 0 ? "unsupported" : "supported",
      ...(classification.candidates.length === 0
        ? {}
        : { value: classification.candidates[0]!.value }),
      tie: classification.tie,
      evidence,
    },
    // A description does not meet the package's declared conservative
    // category/role/display evidence contract. The routes are valid, while
    // their optional outputs are explicitly absent for this producer.
    unsupportedOutput(transaction, "category"),
    unsupportedOutput(transaction, "counterparty_role"),
    unsupportedOutput(transaction, "counterparty_display"),
  ];
  return outputs;
}

/**
 * Run the published Cathay description producer against retained current
 * Source Records and commit its complete per-field result through the shared
 * automatic-enrichment writer.
 */
export async function commitCathayAutomaticEnrichmentFromDescriptions(
  ledgerDir: string,
  options: CathayAutomaticEnrichmentOptions = {},
): Promise<CanonicalEnrichmentCommitResult> {
  const db = openCanonicalDatabase(ledgerDir, { readOnly: true });
  let transactions: CurrentCathayTransaction[];
  try {
    transactions = readCurrentCathayTransactions(db, options);
  } finally {
    db.close();
  }
  if (transactions.length === 0)
    throw new Error("No current Cathay domestic-deposit transactions are available for automatic enrichment.");
  const first = transactions[0]!;
  return commitCanonicalAutomaticEnrichmentRun(ledgerDir, {
    sourceConnectionKey: first.sourceConnectionKey,
    identityEpoch: first.identityEpoch,
    stream: CATHAY_STREAM,
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    routeId: undefined,
    ruleLineage: options.ruleLineage?.trim() || DEFAULT_RULE_LINEAGE,
    observedAt: options.observedAt,
    declaredFields: ["kind", "category", "counterparty_role", "counterparty_display"],
    outputs: transactions.flatMap(outputsForTransaction),
  });
}

export const runCathayAutomaticEnrichment = commitCathayAutomaticEnrichmentFromDescriptions;
