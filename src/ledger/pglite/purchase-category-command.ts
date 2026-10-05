import { randomUUID } from "node:crypto";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";
import {
  USER_CATEGORIZATION_RULE_LINEAGE,
  writeEInvoiceItemUserCategory,
} from "./einvoice-item-categorization.ts";
import { refreshGenerationTransactionCategorizations } from "./projection.ts";
import {
  isCategoryApplicable,
  isTaxonomyCode,
  TRANSACTION_TAXONOMY_ID,
  TRANSACTION_TAXONOMY_VERSION,
} from "../canonical/transaction-taxonomy.ts";
import type {
  SpendingPurchaseCategoryRequest,
  SpendingPurchaseCategoryResult,
} from "../../lib/spending/model.ts";

/**
 * `setPurchaseCategory` writes User Assertions on the subject that owns the
 * purchase (ADR 0038): the transaction for a bank-only or linked purchase,
 * every item for an invoice-only purchase. A null code clears the user lineage
 * and the reading falls back to the routed automatic result. One command is
 * one `user_assertion` commit; a no-op writes no commit.
 */

const LOCAL_USER_ID = "local-user";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

type Row = Readonly<Record<string, unknown>>;

export type PurchaseCategorySubject =
  | Readonly<{ kind: "transaction"; transactionId: Uint8Array }>
  | Readonly<{ kind: "items"; invoiceId: Uint8Array }>;

type PurchaseIdentity =
  | Readonly<{ basis: "bank-transaction"; transactionId: string }>
  | Readonly<{ basis: "linked"; eventId: string }>
  | Readonly<{ basis: "invoice"; invoiceId: string }>
  | Readonly<{ basis: "refund"; refundId: string }>;

export class SpendingPurchaseCategoryError extends Error {
  readonly code: "stale" | "invalid" | "ineligible" | "conflict";
  constructor(code: SpendingPurchaseCategoryError["code"], message: string) {
    super(message);
    this.name = "SpendingPurchaseCategoryError";
    this.code = code;
  }
}

function fail(code: SpendingPurchaseCategoryError["code"], message: string): never {
  throw new SpendingPurchaseCategoryError(code, message);
}

async function query<T>(transaction: PGliteTransaction, sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
  let index = 0;
  return (await transaction.query<T>(sql.replace(/\?/gu, () => `$${++index}`), params)).rows;
}

function bytes(value: string, label: string): Uint8Array {
  if (!UUID.test(value)) fail("invalid", `${label} must be a canonical UUID.`);
  return Uint8Array.from(Buffer.from(value.replaceAll("-", ""), "hex"));
}

function bytesFromRow(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error(`${label} must be a 16-byte identity.`);
}

function uuidBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
}

/** Parse the renderer's purchase id at the boundary into a typed identity. */
export function parsePurchaseIdentity(purchaseId: unknown): PurchaseIdentity {
  if (typeof purchaseId !== "string") fail("invalid", "Spending purchase id must be a string.");
  const separator = purchaseId.indexOf(":");
  const prefix = separator < 0 ? "" : purchaseId.slice(0, separator);
  const id = purchaseId.slice(separator + 1).toLowerCase();
  if (!UUID.test(id)) fail("invalid", "Spending purchase id must carry a canonical UUID.");
  switch (prefix) {
    case "transaction": return { basis: "bank-transaction", transactionId: id };
    case "link": return { basis: "linked", eventId: id };
    case "invoice": return { basis: "invoice", invoiceId: id };
    case "refund": return { basis: "refund", refundId: id };
    default: return fail("invalid", "Spending purchase id has an unknown basis.");
  }
}

async function latest(transaction: PGliteTransaction): Promise<number> {
  const row = (await query<{ value: number | string }>(transaction, "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits"))[0];
  return Number(row?.value ?? 0);
}

async function resolveSubject(transaction: PGliteTransaction, identity: PurchaseIdentity): Promise<PurchaseCategorySubject> {
  switch (identity.basis) {
    case "refund":
      return fail("ineligible", "A refund record has no purchase category to change.");
    case "bank-transaction": {
      const transactionId = bytes(identity.transactionId, "Spending transaction identity");
      const current = await query<Row>(transaction, "SELECT 1 FROM current_transactions WHERE transaction_id = ?", [transactionId]);
      if (current.length === 0) fail("stale", "Spending purchase is stale or no longer current.");
      const linked = await query<Row>(transaction, "SELECT 1 FROM current_spending_dedup_links WHERE transaction_id = ?", [transactionId]);
      if (linked.length > 0) fail("stale", "Spending purchase is now linked; reload Spending.");
      return { kind: "transaction", transactionId };
    }
    case "linked": {
      const eventId = bytes(identity.eventId, "Spending link event identity");
      const link = (await query<Row>(transaction,
        "SELECT transaction_id FROM current_spending_dedup_links WHERE confirmed_event_id = ?",
        [eventId],
      ))[0];
      if (!link) fail("stale", "Spending purchase is stale or no longer linked.");
      return { kind: "transaction", transactionId: bytesFromRow(link.transaction_id, "Linked transaction") };
    }
    case "invoice": {
      const invoiceId = bytes(identity.invoiceId, "Spending invoice identity");
      const state = (await query<Row>(transaction,
        `SELECT revision.state FROM einvoice_invoice_revisions revision
          WHERE revision.invoice_id = ?
          ORDER BY revision.revision_number DESC, revision.revision_id DESC LIMIT 1`,
        [invoiceId],
      ))[0];
      if (!state || state.state !== "active") fail("stale", "Spending invoice is missing or revoked.");
      const linked = await query<Row>(transaction, "SELECT 1 FROM current_spending_dedup_links WHERE invoice_id = ?", [invoiceId]);
      if (linked.length > 0) fail("stale", "Spending invoice is now linked; reload Spending.");
      return { kind: "items", invoiceId };
    }
  }
}

async function transactionKind(transaction: PGliteTransaction, transactionId: Uint8Array): Promise<string | null> {
  const row = (await query<Row>(transaction,
    "SELECT taxonomy_code FROM current_transaction_enrichment WHERE transaction_id = ? AND field_name = 'kind'",
    [transactionId],
  ))[0];
  return row?.taxonomy_code === null || row?.taxonomy_code === undefined ? null : String(row.taxonomy_code);
}

async function activeUserTransactionCategories(transaction: PGliteTransaction, transactionId: Uint8Array) {
  const rows = await query<Row>(transaction,
    `SELECT assertion.assertion_id, assertion.producer_id, assertion.value_text, value.mode
       FROM assertions assertion
       JOIN transaction_categorization_values value ON value.assertion_id = assertion.assertion_id
      WHERE assertion.target_kind = 'transaction'
        AND assertion.transaction_id = ?
        AND assertion.field_name = 'category'
        AND assertion.origin = 'user'
        AND COALESCE((
          SELECT transition.event_kind
            FROM assertion_transitions transition
            JOIN canonical_commits event_commit ON event_commit.commit_id = transition.commit_id
           WHERE transition.assertion_id = assertion.assertion_id
           ORDER BY event_commit.commit_sequence DESC, encode(transition.event_id, 'hex') DESC
           LIMIT 1
        ), 'observed') NOT IN ('withdrawn', 'superseded')
      ORDER BY encode(assertion.assertion_id, 'hex')`,
    [transactionId],
  );
  return rows.map((row) => ({
    assertionId: bytesFromRow(row.assertion_id, "User category assertion"),
    userId: String(row.producer_id),
    value: String(row.value_text),
    mode: String(row.mode) as "single" | "allocated",
  }));
}

async function insertTransactionTransition(
  transaction: PGliteTransaction,
  assertionId: Uint8Array,
  transactionId: Uint8Array,
  userId: string,
  commitId: Uint8Array,
  eventKind: "observed" | "superseded" | "withdrawn",
): Promise<void> {
  await query(transaction,
    `INSERT INTO assertion_transitions(
       event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id,
       enrichment_run_id, coordinate_id, user_id, commit_id, event_kind
     ) VALUES (?, ?, ?, 'category', NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [uuidBytes(), assertionId, transactionId, userId, commitId, eventKind],
  );
}

async function createUserCommit(transaction: PGliteTransaction): Promise<Uint8Array> {
  const id = uuidBytes();
  const sequence = (await latest(transaction)) + 1;
  await query(transaction,
    `INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
     VALUES (?, ?, ?, 'user/local', 'user_assertion')`,
    [id, sequence, Date.now() * 1000],
  );
  return id;
}

async function activeGenerationId(transaction: PGliteTransaction): Promise<number | null> {
  const row = (await query<Row>(transaction, "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1"))[0];
  return row ? Number(row.generation_id) : null;
}

/** Writes or clears the user's single category on a transaction. Returns false when nothing changed. */
async function writeTransactionUserCategory(
  transaction: PGliteTransaction,
  transactionId: Uint8Array,
  categoryCode: string | null,
  commit: () => Promise<Uint8Array>,
): Promise<boolean> {
  const prior = await activeUserTransactionCategories(transaction, transactionId);
  if (prior.length > 1) fail("conflict", "Competing user categorizations are ambiguous.");
  const previous = prior[0] ?? null;
  if (previous && previous.userId !== LOCAL_USER_ID) fail("conflict", "Only the selected user categorization may be changed.");
  if (categoryCode === null) {
    if (!previous) return false;
    const commitId = await commit();
    await insertTransactionTransition(transaction, previous.assertionId, transactionId, previous.userId, commitId, "withdrawn");
    return true;
  }
  if (previous && previous.mode === "single" && previous.value === categoryCode) return false;
  const commitId = await commit();
  if (previous) await insertTransactionTransition(transaction, previous.assertionId, transactionId, previous.userId, commitId, "superseded");
  const assertionId = uuidBytes();
  await query(transaction,
    `INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
     VALUES (?, ?, 'category', 'transaction', 'user', ?, ?, NULL, ?, ?)`,
    [assertionId, transactionId, LOCAL_USER_ID, USER_CATEGORIZATION_RULE_LINEAGE, categoryCode, commitId],
  );
  await insertTransactionTransition(transaction, assertionId, transactionId, LOCAL_USER_ID, commitId, "observed");
  await query(transaction,
    "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id) VALUES (?, NULL, NULL, NULL, NULL, ?)",
    [assertionId, commitId],
  );
  await query(transaction,
    `INSERT INTO transaction_categorization_values(assertion_id, transaction_id, mode, category_code, allocation_set_id, taxonomy_id, taxonomy_version, taxonomy_dimension, created_commit_id)
     VALUES (?, ?, 'single', ?, NULL, ?, ?, 'category', ?)`,
    [assertionId, transactionId, categoryCode, TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION, commitId],
  );
  return true;
}

function validateRequest(request: SpendingPurchaseCategoryRequest): Readonly<{ identity: PurchaseIdentity; knowledgeAt: number; categoryCode: string | null }> {
  if (!request || typeof request !== "object") fail("invalid", "Spending purchase category request is invalid.");
  const identity = parsePurchaseIdentity(request.purchaseId);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt < 0) fail("invalid", "Spending purchase category knowledgeAt is invalid.");
  const categoryCode = request.categoryCode;
  if (categoryCode !== null && (typeof categoryCode !== "string" || !isTaxonomyCode("category", categoryCode)))
    fail("invalid", `Unknown category code ${String(categoryCode)}.`);
  return { identity, knowledgeAt: request.knowledgeAt, categoryCode };
}

export async function setPGliteSpendingPurchaseCategoryInTransaction(
  transaction: PGliteTransaction,
  request: SpendingPurchaseCategoryRequest,
): Promise<SpendingPurchaseCategoryResult> {
  const { identity, knowledgeAt, categoryCode } = validateRequest(request);
  const current = await latest(transaction);
  if (knowledgeAt !== current) fail("stale", "Spending purchase category data version is stale; reload Spending.");
  const subject = await resolveSubject(transaction, identity);
  const kind = subject.kind === "items" ? "purchase" : await transactionKind(transaction, subject.transactionId);
  if (categoryCode !== null) {
    if (kind === null) fail("ineligible", "A category cannot be assigned without a transaction Kind.");
    if (!isCategoryApplicable(categoryCode, kind)) fail("ineligible", `Category ${categoryCode} is incompatible with Kind ${kind}.`);
  }
  let commitId: Uint8Array | null = null;
  const commit = async (): Promise<Uint8Array> => {
    commitId ??= await createUserCommit(transaction);
    return commitId;
  };
  if (subject.kind === "transaction") {
    const changed = await writeTransactionUserCategory(transaction, subject.transactionId, categoryCode, commit);
    if (changed) {
      const generationId = await activeGenerationId(transaction);
      if (generationId !== null)
        await refreshGenerationTransactionCategorizations(transaction, generationId, [subject.transactionId], commitId!);
    }
  } else {
    await writeEInvoiceItemUserCategory(transaction, { invoiceId: subject.invoiceId, commitId: commit, userId: LOCAL_USER_ID, categoryCode });
  }
  return Object.freeze({
    purchaseId: request.purchaseId,
    subject: subject.kind,
    categoryCode,
    baseKnowledgeAt: current,
    knowledgeAt: await latest(transaction),
  });
}

export function setPGliteSpendingPurchaseCategory(
  writer: Pick<PGliteStore, "transaction">,
  request: SpendingPurchaseCategoryRequest,
): Promise<SpendingPurchaseCategoryResult> {
  return writer.transaction((transaction) => setPGliteSpendingPurchaseCategoryInTransaction(transaction, request));
}
