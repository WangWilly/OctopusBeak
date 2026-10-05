import { createHash, randomUUID } from "node:crypto";
import type { PGliteTransaction } from "./transaction.ts";
import {
  deriveEInvoiceItemCategory,
  type EInvoiceItemCategoryDerivation,
} from "../canonical/einvoice-item-category-rules.ts";
import {
  EINVOICE_ITEM_CATEGORY_ENRICHMENT_PRODUCER_ID,
  EINVOICE_ITEM_CATEGORY_ENRICHMENT_PRODUCER_VERSION,
  EINVOICE_ITEM_CATEGORY_ENRICHMENT_ROUTE_ID,
  EINVOICE_ITEM_CATEGORY_ENRICHMENT_RULE_LINEAGE,
  TRANSACTION_TAXONOMY_ID,
  TRANSACTION_TAXONOMY_VERSION,
} from "../canonical/transaction-taxonomy.ts";

/**
 * The e-invoice item subject of the Assertion spine (ADR 0038).
 *
 * One item is `(invoice_id, sequence)` across revisions. Every write here is a
 * reconciliation against the invoice's latest revision, so running it twice,
 * or after a crash, converges on the same assertions and the same current rows.
 */

export const USER_CATEGORIZATION_RULE_LINEAGE = "user/categorization/v1" as const;
export const EINVOICE_ITEM_STREAM = "personal-invoices" as const;

type Row = Readonly<Record<string, unknown>>;
type Exact = Readonly<{ coefficient: string; scale: number }>;

export type EInvoiceItemFacts = Readonly<{
  sequence: number;
  completeness: "complete" | "incomplete";
  name: string | null;
  quantity: Exact | null;
  amount: (Exact & Readonly<{ currency: string }>) | null;
}>;

export type EInvoiceLatestRevision = Readonly<{
  revisionId: Uint8Array;
  state: "active" | "revoked";
  sellerTaxId: string;
  sellerName: string | null;
  items: readonly EInvoiceItemFacts[];
}>;

type ActiveItemAssertion = Readonly<{
  assertionId: Uint8Array;
  sequence: number;
  origin: "derived" | "user";
  producerId: string;
  value: string;
  fingerprint: string;
}>;

export type EInvoiceItemSyncInput = Readonly<{
  invoiceId: Uint8Array;
  commitId: Uint8Array;
  observedAt: string;
}>;

export type EInvoiceItemUserCategoryInput = Readonly<{
  invoiceId: Uint8Array;
  commitId: Uint8Array;
  userId: string;
  categoryCode: string | null;
}>;

function uuidBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
}

async function query<T>(transaction: PGliteTransaction, sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
  let index = 0;
  return (await transaction.query<T>(sql.replace(/\?/gu, () => `$${++index}`), params)).rows;
}

function bytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" && /^\\x[0-9a-f]{32}$/iu.test(value)) return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
  throw new Error(`${label} must be a 16-byte identity.`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The facts whose change withdraws a user item assertion: name, quantity, amount. */
export function einvoiceItemFactFingerprint(item: Pick<EInvoiceItemFacts, "name" | "quantity" | "amount">): string {
  return `sha256:${createHash("sha256").update(stableJson({
    name: item.name,
    quantity: item.quantity ? { coefficient: item.quantity.coefficient, scale: item.quantity.scale } : null,
    amount: item.amount ? { coefficient: item.amount.coefficient, scale: item.amount.scale, currency: item.amount.currency } : null,
  })).digest("base64url")}`;
}

export async function readLatestEInvoiceRevision(
  transaction: PGliteTransaction,
  invoiceId: Uint8Array,
): Promise<EInvoiceLatestRevision | null> {
  const revision = (await query<Row>(transaction,
    `SELECT revision.revision_id, revision.state, revision.seller_tax_id, revision.seller_name
       FROM einvoice_invoice_revisions revision
       JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
      WHERE revision.invoice_id = ?
      ORDER BY revision.revision_number DESC, commit_row.commit_sequence DESC, revision.revision_id DESC
      LIMIT 1`,
    [invoiceId],
  ))[0];
  if (!revision) return null;
  const revisionId = bytes(revision.revision_id, "Invoice revision");
  const items = await query<Row>(transaction,
    `SELECT sequence, completeness, name, quantity_coefficient, quantity_scale,
            amount_coefficient, amount_scale, amount_currency
       FROM einvoice_items WHERE revision_id = ? ORDER BY sequence`,
    [revisionId],
  );
  return {
    revisionId,
    state: String(revision.state) as "active" | "revoked",
    sellerTaxId: String(revision.seller_tax_id),
    sellerName: revision.seller_name === null ? null : String(revision.seller_name),
    items: items.map((row) => ({
      sequence: Number(row.sequence),
      completeness: String(row.completeness) as "complete" | "incomplete",
      name: row.name === null ? null : String(row.name),
      quantity: row.quantity_coefficient === null ? null : { coefficient: String(row.quantity_coefficient), scale: Number(row.quantity_scale) },
      amount: row.amount_coefficient === null ? null : { coefficient: String(row.amount_coefficient), scale: Number(row.amount_scale), currency: String(row.amount_currency) },
    })),
  };
}

const ACTIVE_ITEM_ASSERTIONS_SQL = `
  SELECT assertion.assertion_id, assertion.item_sequence, assertion.origin, assertion.producer_id,
         assertion.value_text, value.item_fact_fingerprint
    FROM assertions assertion
    JOIN einvoice_item_categorization_values value ON value.assertion_id = assertion.assertion_id
   WHERE assertion.target_kind = 'einvoice_item'
     AND assertion.field_name = 'category'
     AND assertion.invoice_id = ?
     AND COALESCE((
       SELECT transition.event_kind
         FROM assertion_transitions transition
         JOIN canonical_commits event_commit ON event_commit.commit_id = transition.commit_id
        WHERE transition.assertion_id = assertion.assertion_id
        ORDER BY event_commit.commit_sequence DESC, encode(transition.event_id, 'hex') DESC
        LIMIT 1
     ), 'observed') NOT IN ('withdrawn', 'superseded')
   ORDER BY assertion.item_sequence, assertion.origin`;

async function readActiveItemAssertions(transaction: PGliteTransaction, invoiceId: Uint8Array): Promise<readonly ActiveItemAssertion[]> {
  const rows = await query<Row>(transaction, ACTIVE_ITEM_ASSERTIONS_SQL, [invoiceId]);
  return rows.map((row) => ({
    assertionId: bytes(row.assertion_id, "Item assertion"),
    sequence: Number(row.item_sequence),
    origin: String(row.origin) as "derived" | "user",
    producerId: String(row.producer_id),
    value: String(row.value_text),
    fingerprint: String(row.item_fact_fingerprint),
  }));
}

async function insertItemAssertion(
  transaction: PGliteTransaction,
  input: Readonly<{
    invoiceId: Uint8Array;
    sequence: number;
    origin: "derived" | "user";
    producerId: string;
    ruleLineage: string;
    code: string;
    fingerprint: string;
    routeId: string | null;
    commitId: Uint8Array;
  }>,
): Promise<Uint8Array> {
  const assertionId = uuidBytes();
  await query(transaction,
    `INSERT INTO assertions(
       assertion_id, transaction_id, invoice_id, item_sequence, field_name, target_kind, origin,
       producer_id, rule_lineage, revision_id, value_text, created_commit_id
     ) VALUES (?, NULL, ?, ?, 'category', 'einvoice_item', ?, ?, ?, NULL, ?, ?)`,
    [assertionId, input.invoiceId, input.sequence, input.origin, input.producerId, input.ruleLineage, input.code, input.commitId],
  );
  await query(transaction,
    `INSERT INTO einvoice_item_categorization_values(
       assertion_id, invoice_id, item_sequence, origin, category_code, taxonomy_id, taxonomy_version,
       taxonomy_dimension, item_fact_fingerprint, route_id, created_commit_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'category', ?, ?, ?)`,
    [assertionId, input.invoiceId, input.sequence, input.origin, input.code, TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION, input.fingerprint, input.routeId, input.commitId],
  );
  return assertionId;
}

async function insertUserTransition(
  transaction: PGliteTransaction,
  assertion: Readonly<{ assertionId: Uint8Array; sequence: number; producerId: string }>,
  invoiceId: Uint8Array,
  commitId: Uint8Array,
  eventKind: "observed" | "superseded" | "withdrawn",
): Promise<void> {
  await query(transaction,
    `INSERT INTO assertion_transitions(
       event_id, assertion_id, transaction_id, invoice_id, item_sequence, field_name, capture_id, scope_id,
       run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind
     ) VALUES (?, ?, NULL, ?, ?, 'category', NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [uuidBytes(), assertion.assertionId, invoiceId, assertion.sequence, assertion.producerId, commitId, eventKind],
  );
}

async function insertDerivedTransition(
  transaction: PGliteTransaction,
  assertionId: Uint8Array,
  invoiceId: Uint8Array,
  sequence: number,
  runId: Uint8Array,
  commitId: Uint8Array,
  eventKind: "observed" | "superseded" | "withdrawn",
): Promise<void> {
  await query(transaction,
    `INSERT INTO assertion_transitions(
       event_id, assertion_id, transaction_id, invoice_id, item_sequence, field_name, capture_id, scope_id,
       run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind
     ) VALUES (?, ?, NULL, ?, ?, 'category', NULL, NULL, NULL, ?, NULL, NULL, ?, ?)`,
    [uuidBytes(), assertionId, invoiceId, sequence, runId, commitId, eventKind],
  );
}

type DerivedChange = Readonly<{
  sequence: number;
  desired: EInvoiceItemCategoryDerivation | null;
  fingerprint: string;
  previous: ActiveItemAssertion | null;
}>;

async function applyDerivedChanges(
  transaction: PGliteTransaction,
  input: EInvoiceItemSyncInput,
  changes: readonly DerivedChange[],
): Promise<void> {
  if (changes.length === 0) return;
  const runId = uuidBytes();
  await query(transaction,
    `INSERT INTO enrichment_runs(
       run_id, source_connection_id, identity_epoch_id, stream, producer_id, producer_version,
       origin, rule_lineage, observed_at, commit_id, status, complete_scope
     )
     SELECT ?, invoice.source_connection_id, invoice.identity_epoch_id, ?, ?, ?, 'derived', ?, ?, ?, 'complete', 1
       FROM einvoice_invoices invoice WHERE invoice.invoice_id = ?`,
    [runId, EINVOICE_ITEM_STREAM, EINVOICE_ITEM_CATEGORY_ENRICHMENT_PRODUCER_ID, EINVOICE_ITEM_CATEGORY_ENRICHMENT_PRODUCER_VERSION, EINVOICE_ITEM_CATEGORY_ENRICHMENT_RULE_LINEAGE, input.observedAt, input.commitId, input.invoiceId],
  );
  for (const change of changes) {
    const provenance = stableJson({
      evidenceKind: change.desired?.evidenceKind ?? null,
      matchedRule: change.desired?.matchedRule ?? null,
      itemFactFingerprint: change.fingerprint,
      ruleLineage: EINVOICE_ITEM_CATEGORY_ENRICHMENT_RULE_LINEAGE,
    });
    if (!change.desired) {
      await query(transaction,
        `INSERT INTO enrichment_run_outputs(
           output_id, run_id, transaction_id, invoice_id, item_sequence, field_name, output_state, origin,
           value_text, confidence_basis_points, route_id, source_record_id, source_field, source_value_text,
           provenance_json, assertion_id, commit_id
         ) VALUES (?, ?, NULL, ?, ?, 'category', 'unsupported', NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, NULL, ?)`,
        [uuidBytes(), runId, input.invoiceId, change.sequence, EINVOICE_ITEM_CATEGORY_ENRICHMENT_ROUTE_ID, provenance, input.commitId],
      );
      if (change.previous)
        await insertDerivedTransition(transaction, change.previous.assertionId, input.invoiceId, change.sequence, runId, input.commitId, "withdrawn");
      continue;
    }
    const assertionId = await insertItemAssertion(transaction, {
      invoiceId: input.invoiceId,
      sequence: change.sequence,
      origin: "derived",
      producerId: EINVOICE_ITEM_CATEGORY_ENRICHMENT_PRODUCER_ID,
      ruleLineage: EINVOICE_ITEM_CATEGORY_ENRICHMENT_RULE_LINEAGE,
      code: change.desired.code,
      fingerprint: change.fingerprint,
      routeId: EINVOICE_ITEM_CATEGORY_ENRICHMENT_ROUTE_ID,
      commitId: input.commitId,
    });
    await query(transaction,
      `INSERT INTO enrichment_run_outputs(
         output_id, run_id, transaction_id, invoice_id, item_sequence, field_name, output_state, origin,
         value_text, confidence_basis_points, route_id, source_record_id, source_field, source_value_text,
         provenance_json, assertion_id, commit_id
       ) VALUES (?, ?, NULL, ?, ?, 'category', 'supported', 'derived', ?, 10000, ?, NULL, ?, ?, ?, ?, ?)`,
      [uuidBytes(), runId, input.invoiceId, change.sequence, change.desired.code, EINVOICE_ITEM_CATEGORY_ENRICHMENT_ROUTE_ID, change.desired.evidenceKind, change.desired.matchedRule, provenance, assertionId, input.commitId],
    );
    await query(transaction,
      `INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
       VALUES (?, NULL, NULL, ?, NULL, ?)`,
      [assertionId, runId, input.commitId],
    );
    await insertDerivedTransition(transaction, assertionId, input.invoiceId, change.sequence, runId, input.commitId, "observed");
    if (change.previous)
      await insertDerivedTransition(transaction, change.previous.assertionId, input.invoiceId, change.sequence, runId, input.commitId, "superseded");
  }
}

/**
 * Rebuilds the current item categorization rows of one invoice: an active User
 * Assertion wins, otherwise the routed Derived result, for the items of the
 * latest active revision.
 */
export async function refreshCurrentEInvoiceItemCategorizations(
  transaction: PGliteTransaction,
  invoiceId: Uint8Array,
  projectionCommitId: Uint8Array,
): Promise<void> {
  await query(transaction, "DELETE FROM current_einvoice_item_categorizations WHERE invoice_id = ?", [invoiceId]);
  await query(transaction,
    `WITH latest AS (
       SELECT revision.revision_id, revision.state
         FROM einvoice_invoice_revisions revision
         JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
        WHERE revision.invoice_id = ?
        ORDER BY revision.revision_number DESC, commit_row.commit_sequence DESC, revision.revision_id DESC
        LIMIT 1
     ), active AS (
       SELECT assertion.assertion_id, assertion.item_sequence, assertion.origin, assertion.producer_id,
              value.category_code, value.taxonomy_id, value.taxonomy_version, value.route_id,
              ROW_NUMBER() OVER (
                PARTITION BY assertion.item_sequence
                ORDER BY CASE WHEN assertion.origin = 'user' THEN 0 ELSE 1 END,
                         created.commit_sequence DESC, encode(assertion.assertion_id, 'hex') DESC
              ) AS rank
         FROM assertions assertion
         JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
         JOIN einvoice_item_categorization_values value ON value.assertion_id = assertion.assertion_id
        WHERE assertion.target_kind = 'einvoice_item'
          AND assertion.field_name = 'category'
          AND assertion.invoice_id = ?
          AND COALESCE((
            SELECT transition.event_kind
              FROM assertion_transitions transition
              JOIN canonical_commits event_commit ON event_commit.commit_id = transition.commit_id
             WHERE transition.assertion_id = assertion.assertion_id
             ORDER BY event_commit.commit_sequence DESC, encode(transition.event_id, 'hex') DESC
             LIMIT 1
          ), 'observed') NOT IN ('withdrawn', 'superseded')
     )
     INSERT INTO current_einvoice_item_categorizations(
       invoice_id, item_sequence, field_name, assertion_id, origin, category_code,
       taxonomy_id, taxonomy_version, producer_id, producer_version, route_id, projection_commit_id
     )
     SELECT ?::bytea, active.item_sequence, 'category', active.assertion_id, active.origin, active.category_code,
            active.taxonomy_id, active.taxonomy_version, active.producer_id,
            route.producer_version, active.route_id, ?::bytea
       FROM active
       JOIN latest ON latest.state = 'active'
       JOIN einvoice_items item ON item.revision_id = latest.revision_id AND item.sequence = active.item_sequence
       LEFT JOIN automatic_enrichment_authority_routes route ON route.route_id = active.route_id
      WHERE active.rank = 1`,
    [invoiceId, invoiceId, invoiceId, projectionCommitId],
  );
}

/**
 * Re-derives every item of the invoice's latest revision, withdraws Derived
 * results for items that disappeared or no longer match, and carries a user
 * item assertion forward only while the item's facts are unchanged.
 */
export async function syncEInvoiceItemCategorizations(
  transaction: PGliteTransaction,
  input: EInvoiceItemSyncInput,
): Promise<void> {
  const latest = await readLatestEInvoiceRevision(transaction, input.invoiceId);
  const items = latest?.state === "active" ? latest.items : [];
  const active = await readActiveItemAssertions(transaction, input.invoiceId);
  const derivedBySequence = new Map(active.filter((row) => row.origin === "derived").map((row) => [row.sequence, row]));
  const userBySequence = new Map(active.filter((row) => row.origin === "user").map((row) => [row.sequence, row]));
  const fingerprints = new Map(items.map((item) => [item.sequence, einvoiceItemFactFingerprint(item)]));

  const changes: DerivedChange[] = [];
  for (const item of items) {
    const desired = latest ? deriveEInvoiceItemCategory({ itemName: item.name, sellerTaxId: latest.sellerTaxId, sellerName: latest.sellerName }) : null;
    const previous = derivedBySequence.get(item.sequence) ?? null;
    const fingerprint = fingerprints.get(item.sequence)!;
    const unchanged = desired
      ? previous !== null && previous.value === desired.code && previous.fingerprint === fingerprint
      : previous === null;
    if (!unchanged) changes.push({ sequence: item.sequence, desired, fingerprint, previous });
  }
  for (const previous of derivedBySequence.values()) {
    if (!fingerprints.has(previous.sequence))
      changes.push({ sequence: previous.sequence, desired: null, fingerprint: previous.fingerprint, previous });
  }
  await applyDerivedChanges(transaction, input, changes);

  for (const user of userBySequence.values()) {
    if (fingerprints.get(user.sequence) === user.fingerprint) continue;
    await insertUserTransition(transaction, user, input.invoiceId, input.commitId, "withdrawn");
  }
  await refreshCurrentEInvoiceItemCategorizations(transaction, input.invoiceId, input.commitId);
}

/**
 * Writes the user's category on every item of the latest active revision, or
 * withdraws the user's item assertions when the code is null. Items are
 * applicability-checked as Kind `purchase` by the caller.
 */
export async function writeEInvoiceItemUserCategory(
  transaction: PGliteTransaction,
  input: EInvoiceItemUserCategoryInput,
): Promise<Readonly<{ written: number; withdrawn: number }>> {
  const latest = await readLatestEInvoiceRevision(transaction, input.invoiceId);
  const items = latest?.state === "active" ? latest.items : [];
  const active = await readActiveItemAssertions(transaction, input.invoiceId);
  const userBySequence = new Map(active.filter((row) => row.origin === "user").map((row) => [row.sequence, row]));
  let written = 0;
  let withdrawn = 0;
  if (input.categoryCode === null) {
    for (const user of userBySequence.values()) {
      await insertUserTransition(transaction, user, input.invoiceId, input.commitId, "withdrawn");
      withdrawn += 1;
    }
  } else {
    for (const item of items) {
      const fingerprint = einvoiceItemFactFingerprint(item);
      const previous = userBySequence.get(item.sequence);
      if (previous && previous.value === input.categoryCode && previous.fingerprint === fingerprint) continue;
      if (previous) await insertUserTransition(transaction, previous, input.invoiceId, input.commitId, "superseded");
      const assertionId = await insertItemAssertion(transaction, {
        invoiceId: input.invoiceId,
        sequence: item.sequence,
        origin: "user",
        producerId: input.userId,
        ruleLineage: USER_CATEGORIZATION_RULE_LINEAGE,
        code: input.categoryCode,
        fingerprint,
        routeId: null,
        commitId: input.commitId,
      });
      await query(transaction,
        `INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
         VALUES (?, NULL, NULL, NULL, NULL, ?)`,
        [assertionId, input.commitId],
      );
      await insertUserTransition(transaction, { assertionId, sequence: item.sequence, producerId: input.userId }, input.invoiceId, input.commitId, "observed");
      written += 1;
    }
  }
  await refreshCurrentEInvoiceItemCategorizations(transaction, input.invoiceId, input.commitId);
  return { written, withdrawn };
}
