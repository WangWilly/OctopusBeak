import { DatabaseSync } from "node:sqlite";
import { withCanonicalSnapshot } from "./canonical-runtime.ts";
import {
  withCanonicalSourceCaptureAdmissionTransaction,
  type CanonicalSourceCaptureAdmissionTransactionCapability,
  type CanonicalSourceCaptureAdmissionTransactionResult,
} from "./canonical-source-capture-admission.ts";
import {
  assertValidatedCanonicalSourceStore,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import { validateCanonicalEInvoiceSchema } from "./canonical-database.ts";
import {
  blob,
  idToString,
  uuidV7,
} from "./canonical-local-identifier.ts";
import { assertValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";
import {
  CanonicalEInvoiceAdmissionError,
  E_INVOICE_CONTRACT_VERSION,
  E_INVOICE_CURRENCY_AUTHORITY,
  E_INVOICE_INTEGRATION_NAMESPACE,
  E_INVOICE_RECORD_KIND,
  E_INVOICE_ROUTE,
  E_INVOICE_STREAM,
  buildCanonicalEInvoiceSourceEvidence,
  normalizeCanonicalEInvoiceCapture,
  normalizeCanonicalEInvoiceLineageRequest,
} from "./einvoice-contract.ts";
import type {
  CanonicalEInvoiceCaptureInput,
  CanonicalEInvoiceCompleteness,
  CanonicalEInvoiceOccurrence,
  CanonicalEInvoiceProvenance,
  CanonicalEInvoiceRevisionKind,
  CanonicalEInvoiceLineageRequest,
  CanonicalNormalizedEInvoice,
  CanonicalNormalizedEInvoiceItem,
} from "./einvoice-contract.ts";

export * from "./einvoice-contract.ts";

export type CanonicalEInvoiceWriterStore = Pick<
  CanonicalSourceStore,
  "db" | "commitClock" | "withWriter"
>;

export type CanonicalEInvoiceCommitResult = Readonly<{
  status: "committed";
  captureId: string;
  knowledgeAt: number;
  sourceRecordIds: readonly string[];
  invoiceCount: number;
  insertedInvoiceCount: number;
  insertedRevisionCount: number;
  observedDuplicateCount: number;
  itemCount: number;
}>;

function insertEInvoiceCapture(
  db: DatabaseSync,
  input: CanonicalEInvoiceCaptureInput,
  admitted: CanonicalSourceCaptureAdmissionTransactionResult,
): void {
  db.prepare(
    `INSERT INTO einvoice_captures(
       capture_id, capture_key, scope_id, source_connection_id, identity_epoch_id,
       source_subject_id, authority_route, contract_version, stream, record_kind,
       scope_start, scope_end, scope_kind, scope_completeness,
       invoice_completeness, item_completeness, page_count, commit_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    admitted.captureId,
    input.captureId,
    admitted.scopeId,
    admitted.sourceConnectionId,
    admitted.identityEpochId,
    admitted.sourceSubjectId,
    E_INVOICE_ROUTE,
    E_INVOICE_CONTRACT_VERSION,
    E_INVOICE_STREAM,
    E_INVOICE_RECORD_KIND,
    input.scope.startDate,
    input.scope.endDate,
    input.scope.kind,
    input.scope.completeness,
    input.scope.invoiceCompleteness,
    input.scope.itemCompleteness,
    input.pages.length,
    admitted.commitId,
  );
}

function invoiceIdFor(
  db: DatabaseSync,
  admitted: CanonicalSourceCaptureAdmissionTransactionResult,
  stableInvoiceKey: string,
): Buffer {
  const existing = db
    .prepare(
      `SELECT invoice_id
         FROM einvoice_invoices
        WHERE source_connection_id = ?
          AND identity_epoch_id = ?
          AND source_subject_id = ?
          AND stable_invoice_key = ?`,
    )
    .get(
      admitted.sourceConnectionId,
      admitted.identityEpochId,
      admitted.sourceSubjectId,
      stableInvoiceKey,
    ) as { invoice_id?: unknown } | undefined;
  if (existing?.invoice_id !== undefined) return blob(existing.invoice_id);
  const invoiceId = uuidV7();
  db.prepare(
    `INSERT INTO einvoice_invoices(
       invoice_id, source_connection_id, identity_epoch_id, source_subject_id,
       stable_invoice_key, created_commit_id
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    invoiceId,
    admitted.sourceConnectionId,
    admitted.identityEpochId,
    admitted.sourceSubjectId,
    stableInvoiceKey,
    admitted.commitId,
  );
  return invoiceId;
}

function insertEInvoiceItems(
  db: DatabaseSync,
  revisionId: Buffer,
  items: readonly CanonicalNormalizedEInvoiceItem[],
): number {
  const statement = db.prepare(
    `INSERT INTO einvoice_items(
       item_id, revision_id, sequence, completeness, name,
       quantity_coefficient, quantity_scale, unit_price_coefficient,
       unit_price_scale, unit_price_currency, unit_price_currency_authority,
       amount_coefficient, amount_scale, amount_currency,
       amount_currency_authority, source_fact_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of items)
    statement.run(
      uuidV7(),
      revisionId,
      entry.sequence,
      entry.completeness,
      entry.name,
      entry.quantity?.coefficient ?? null,
      entry.quantity?.scale ?? null,
      entry.unitPrice?.coefficient ?? null,
      entry.unitPrice?.scale ?? null,
      entry.unitPrice?.currency ?? null,
      entry.unitPrice?.currencyAuthority ?? null,
      entry.amount?.coefficient ?? null,
      entry.amount?.scale ?? null,
      entry.amount?.currency ?? null,
      entry.amount?.currencyAuthority ?? null,
      entry.sourceFactJson,
    );
  return items.length;
}

function insertEInvoiceObservation(
  db: DatabaseSync,
  revisionId: Buffer,
  sourceRecordId: Buffer,
  captureId: Buffer,
  commitId: Buffer,
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO einvoice_revision_observations(
         revision_id, source_record_id, capture_id, commit_id
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(revisionId, sourceRecordId, captureId, commitId);
  return Number(result.changes ?? 0) > 0;
}

function insertEInvoiceEvent(
  db: DatabaseSync,
  input: Readonly<{
    invoiceId: Buffer;
    revisionId: Buffer;
    sourceRecordId: Buffer;
    captureId: Buffer;
    commitId: Buffer;
    kind: "issued" | "revised" | "revoked" | "observed" | "superseded";
    eventAt: string;
    reason?: string | null;
  }>,
): void {
  db.prepare(
    `INSERT INTO einvoice_revision_events(
       event_id, invoice_id, revision_id, source_record_id, capture_id,
       commit_id, event_kind, event_at, reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidV7(),
    input.invoiceId,
    input.revisionId,
    input.sourceRecordId,
    input.captureId,
    input.commitId,
    input.kind,
    input.eventAt,
    input.reason ?? null,
  );
}

function insertOrObserveInvoice(
  db: DatabaseSync,
  input: CanonicalEInvoiceCaptureInput,
  invoice: CanonicalNormalizedEInvoice,
  admitted: CanonicalSourceCaptureAdmissionTransactionResult,
  sourceRecordId: Buffer,
): { insertedInvoice: boolean; insertedRevision: boolean; duplicate: boolean; itemCount: number } {
  const before = db
    .prepare(
      `SELECT invoice_id
         FROM einvoice_invoices
        WHERE source_connection_id = ?
          AND identity_epoch_id = ?
          AND source_subject_id = ?
          AND stable_invoice_key = ?`,
    )
    .get(
      admitted.sourceConnectionId,
      admitted.identityEpochId,
      admitted.sourceSubjectId,
      invoice.stableInvoiceKey,
    ) as { invoice_id?: unknown } | undefined;
  const invoiceId = invoiceIdFor(db, admitted, invoice.stableInvoiceKey);
  const insertedInvoice = before === undefined;
  const existingRevision = db
    .prepare(
      `SELECT revision_id, fact_fingerprint, revision_number, revision_kind
         FROM einvoice_invoice_revisions
        WHERE invoice_id = ? AND source_revision_key = ?`,
    )
    .get(invoiceId, invoice.sourceRevisionKey) as
    | { revision_id?: unknown; fact_fingerprint?: unknown; revision_number?: unknown; revision_kind?: unknown }
    | undefined;
  if (existingRevision) {
    if (
      String(existingRevision.fact_fingerprint) !== invoice.fingerprint ||
      Number(existingRevision.revision_number) !== invoice.revisionNumber ||
      String(existingRevision.revision_kind) !== invoice.revisionKind
    )
      throw new CanonicalEInvoiceAdmissionError(
        "revision-conflict",
        `E-Invoice revision ${invoice.sourceRevisionKey} changed after admission.`,
      );
    const revisionId = blob(existingRevision.revision_id);
    const observed = insertEInvoiceObservation(
      db,
      revisionId,
      sourceRecordId,
      admitted.captureId,
      admitted.commitId,
    );
    if (observed)
      insertEInvoiceEvent(db, {
        invoiceId,
        revisionId,
        sourceRecordId,
        captureId: admitted.captureId,
        commitId: admitted.commitId,
        kind: "observed",
        eventAt: input.observedAt,
      });
    return { insertedInvoice, insertedRevision: false, duplicate: true, itemCount: 0 };
  }
  const sameNumber = db
    .prepare(
      `SELECT revision_id, revision_number
         FROM einvoice_invoice_revisions
        WHERE invoice_id = ? AND revision_number = ?`,
    )
    .get(invoiceId, invoice.revisionNumber) as { revision_id?: unknown; revision_number?: unknown } | undefined;
  if (sameNumber)
    throw new CanonicalEInvoiceAdmissionError(
      "revision-conflict",
      `E-Invoice revision number ${invoice.revisionNumber} already belongs to another source revision.`,
    );
  const latest = db
    .prepare(
      `SELECT revision_number
         FROM einvoice_invoice_revisions
        WHERE invoice_id = ?
        ORDER BY revision_number DESC
        LIMIT 1`,
    )
    .get(invoiceId) as { revision_number?: unknown } | undefined;
  if (latest && invoice.revisionNumber <= Number(latest.revision_number))
    throw new CanonicalEInvoiceAdmissionError(
      "revision-conflict",
      `E-Invoice revision ${invoice.revisionNumber} is older than the admitted revision history.`,
    );
  const revisionId = uuidV7();
  db.prepare(
    `INSERT INTO einvoice_invoice_revisions(
       revision_id, invoice_id, source_record_id, capture_id, commit_id,
       source_revision_key, revision_number, revision_kind, state,
       invoice_number, random_number, seller_tax_id, seller_name,
       amount_coefficient, amount_scale, currency, currency_authority,
       occurrence_value, occurrence_precision, occurrence_time_zone,
       occurrence_origin, authority_route, contract_version, provenance_kind,
       provenance_reference, provenance_source_field, revocation_reason,
       fact_fingerprint
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    invoiceId,
    sourceRecordId,
    admitted.captureId,
    admitted.commitId,
    invoice.sourceRevisionKey,
    invoice.revisionNumber,
    invoice.revisionKind,
    invoice.state,
    invoice.invoiceNumber,
    invoice.randomNumber,
    invoice.sellerTaxId,
    invoice.sellerName,
    invoice.total?.coefficient ?? null,
    invoice.total?.scale ?? null,
    invoice.total?.currency ?? null,
    invoice.total?.currencyAuthority ?? E_INVOICE_CURRENCY_AUTHORITY,
    invoice.occurrence.value,
    invoice.occurrence.precision,
    invoice.occurrence.timeZone,
    invoice.occurrence.origin,
    E_INVOICE_ROUTE,
    E_INVOICE_CONTRACT_VERSION,
    invoice.provenance.kind,
    invoice.provenance.reference,
    invoice.provenance.sourceField ?? null,
    invoice.revocationReason,
    invoice.fingerprint,
  );
  const itemCount = insertEInvoiceItems(db, revisionId, invoice.items);
  insertEInvoiceObservation(db, revisionId, sourceRecordId, admitted.captureId, admitted.commitId);
  insertEInvoiceEvent(db, {
    invoiceId,
    revisionId,
    sourceRecordId,
    captureId: admitted.captureId,
    commitId: admitted.commitId,
    kind: invoice.revisionKind,
    eventAt: input.observedAt,
    reason: invoice.revocationReason,
  });
  const prior = db
    .prepare(
      `SELECT revision_id
         FROM einvoice_invoice_revisions
        WHERE invoice_id = ? AND revision_number < ?
        ORDER BY revision_number DESC
        LIMIT 1`,
    )
    .get(invoiceId, invoice.revisionNumber) as { revision_id?: unknown } | undefined;
  if (prior)
    insertEInvoiceEvent(db, {
      invoiceId,
      revisionId: blob(prior.revision_id),
      sourceRecordId,
      captureId: admitted.captureId,
      commitId: admitted.commitId,
      kind: "superseded",
      eventAt: input.observedAt,
      reason: `superseded-by-revision-${invoice.revisionNumber}`,
    });
  return { insertedInvoice, insertedRevision: true, duplicate: false, itemCount };
}

/** Atomically admit an E-Invoice capture, its source envelope, and typed facts. */
export function commitCanonicalEInvoiceCaptureInTransaction(
  store: CanonicalEInvoiceWriterStore,
  input: CanonicalEInvoiceCaptureInput,
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): CanonicalEInvoiceCommitResult {
  assertValidatedCanonicalDatabase(store.db);
  const [, invoices] = normalizeCanonicalEInvoiceCapture(input);
  const evidence = buildCanonicalEInvoiceSourceEvidence(input);
  const admitted = capability.admit(evidence);
  insertEInvoiceCapture(store.db, input, admitted);
  let insertedInvoiceCount = 0;
  let insertedRevisionCount = 0;
  let observedDuplicateCount = 0;
  let itemCount = 0;
  for (const [index, invoice] of invoices.entries()) {
    const sourceRecordId = blob(admitted.sourceRecordIds[index]);
    const result = insertOrObserveInvoice(store.db, input, invoice, admitted, sourceRecordId);
    if (result.insertedInvoice) insertedInvoiceCount += 1;
    if (result.insertedRevision) insertedRevisionCount += 1;
    if (result.duplicate) observedDuplicateCount += 1;
    itemCount += result.itemCount;
  }
  return Object.freeze({
    status: "committed" as const,
    captureId: input.captureId,
    knowledgeAt: admitted.receipt.knowledgePoint,
    sourceRecordIds: Object.freeze(admitted.sourceRecordIds.map(idToString)),
    invoiceCount: invoices.length,
    insertedInvoiceCount,
    insertedRevisionCount,
    observedDuplicateCount,
    itemCount,
  });
}

export async function commitCanonicalEInvoiceCapture(
  store: CanonicalEInvoiceWriterStore,
  input: CanonicalEInvoiceCaptureInput,
): Promise<CanonicalEInvoiceCommitResult> {
  assertValidatedCanonicalSourceStore(store as unknown as CanonicalSourceStore);
  return withCanonicalSourceCaptureAdmissionTransaction(
    store as unknown as CanonicalSourceStore,
    (capability) =>
      commitCanonicalEInvoiceCaptureInTransaction(store, input, capability),
  );
}

export type CanonicalEInvoiceMoneyView = Readonly<{
  coefficient: string;
  scale: number;
  currency: "TWD";
  currencyAuthority: string;
}>;

export type CanonicalEInvoiceItemView = Readonly<{
  itemId: string;
  sequence: number;
  completeness: CanonicalEInvoiceCompleteness;
  name: string | null;
  quantity: { coefficient: string; scale: number } | null;
  unitPrice: CanonicalEInvoiceMoneyView | null;
  amount: CanonicalEInvoiceMoneyView | null;
  sourceFacts: Record<string, unknown>;
}>;

export type CanonicalEInvoiceRevisionView = Readonly<{
  revisionId: string;
  sourceRevisionKey: string;
  revisionNumber: number;
  revisionKind: CanonicalEInvoiceRevisionKind;
  state: "active" | "revoked";
  invoiceNumber: string;
  randomNumber: string | null;
  seller: { taxId: string; name: string | null };
  total: CanonicalEInvoiceMoneyView | null;
  occurrence: CanonicalEInvoiceOccurrence;
  authority: { routeKey: string; contractVersion: string };
  provenance: CanonicalEInvoiceProvenance;
  revocationReason: string | null;
  captureId: string;
  captureKey: string;
  sourceRecordId: string;
  commitSequence: number;
  items: readonly CanonicalEInvoiceItemView[];
}>;

export type CanonicalEInvoiceView = Readonly<{
  invoiceId: string;
  stableInvoiceKey: string;
  identity: {
    integrationNamespace: typeof E_INVOICE_INTEGRATION_NAMESPACE;
    sourceConnectionKey: string;
    identityEpoch: string;
    stream: typeof E_INVOICE_STREAM;
    recordKind: typeof E_INVOICE_RECORD_KIND;
    subjectDigest: string;
  };
  revision: CanonicalEInvoiceRevisionView;
}>;

export type CanonicalEInvoiceCurrentQuery = Readonly<{
  kind: "current";
  knowledgeAt: number;
  invoices: readonly CanonicalEInvoiceView[];
}>;

export type CanonicalEInvoiceHistoricalQuery = Readonly<{
  kind: "historical";
  knowledgeAt: number;
  invoices: readonly CanonicalEInvoiceView[];
}>;

export type CanonicalEInvoiceLineageObservation = Readonly<{
  revisionId: string;
  sourceRecordId: string;
  captureId: string;
  captureKey: string;
  commitSequence: number;
}>;

export type CanonicalEInvoiceLineageEvent = Readonly<{
  eventId: string;
  invoiceId: string;
  revisionId: string;
  sourceRecordId: string;
  captureId: string;
  captureKey: string;
  commitSequence: number;
  kind: "issued" | "revised" | "revoked" | "observed" | "superseded";
  eventAt: string;
  reason: string | null;
}>;

export type CanonicalEInvoiceLineageQuery = Readonly<{
  kind: "lineage";
  identity: CanonicalEInvoiceLineageRequest;
  invoice: CanonicalEInvoiceView | null;
  revisions: readonly CanonicalEInvoiceView[];
  observations: readonly CanonicalEInvoiceLineageObservation[];
  events: readonly CanonicalEInvoiceLineageEvent[];
  provenanceComplete: boolean;
}>;

function latestCommitSequence(db: DatabaseSync): number {
  return Number(
    (
      db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits").get() as {
        value?: unknown;
      }
    ).value ?? 0,
  );
}

function viewMoney(
  coefficient: unknown,
  scale: unknown,
  currency: unknown,
  currencyAuthority: unknown,
): CanonicalEInvoiceMoneyView | null {
  if (coefficient === null || coefficient === undefined || scale === null || scale === undefined || currency === null || currency === undefined)
    return null;
  if (String(currency) !== "TWD") throw new Error("Canonical E-Invoice query found a non-TWD amount.");
  if (String(currencyAuthority) !== E_INVOICE_CURRENCY_AUTHORITY)
    throw new Error("Canonical E-Invoice query found an amount without the authoritative TWD contract.");
  return {
    coefficient: String(coefficient),
    scale: Number(scale),
    currency: "TWD",
    currencyAuthority: String(currencyAuthority),
  };
}

function rowJson(value: unknown, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object expected");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Canonical E-Invoice ${label} source facts are invalid.`, { cause: error });
  }
}

function eInvoiceItemsForRevision(db: DatabaseSync, revisionId: Uint8Array): readonly CanonicalEInvoiceItemView[] {
  const rows = db
    .prepare(
      `SELECT item_id, sequence, completeness, name,
              quantity_coefficient, quantity_scale,
              unit_price_coefficient, unit_price_scale, unit_price_currency,
              unit_price_currency_authority,
              amount_coefficient, amount_scale, amount_currency,
              amount_currency_authority, source_fact_json
         FROM einvoice_items
        WHERE revision_id = ?
        ORDER BY sequence`,
    )
    .all(revisionId) as Array<Record<string, unknown>>;
  return Object.freeze(rows.map((row) => ({
    itemId: idToString(row.item_id),
    sequence: Number(row.sequence),
    completeness: String(row.completeness) as CanonicalEInvoiceCompleteness,
    name: row.name === null || row.name === undefined ? null : String(row.name),
    quantity: row.quantity_coefficient === null || row.quantity_coefficient === undefined
      ? null
      : { coefficient: String(row.quantity_coefficient), scale: Number(row.quantity_scale) },
    unitPrice: viewMoney(row.unit_price_coefficient, row.unit_price_scale, row.unit_price_currency, row.unit_price_currency_authority),
    amount: viewMoney(row.amount_coefficient, row.amount_scale, row.amount_currency, row.amount_currency_authority),
    sourceFacts: rowJson(row.source_fact_json, "item"),
  })));
}

function revisionView(db: DatabaseSync, row: Record<string, unknown>): CanonicalEInvoiceView {
  const revisionId = blob(row.revision_id);
  return Object.freeze({
    invoiceId: idToString(row.invoice_id),
    stableInvoiceKey: String(row.stable_invoice_key),
    identity: {
      integrationNamespace: E_INVOICE_INTEGRATION_NAMESPACE,
      sourceConnectionKey: String(row.source_connection_key),
      identityEpoch: String(row.identity_epoch_key),
      stream: E_INVOICE_STREAM,
      recordKind: E_INVOICE_RECORD_KIND,
      subjectDigest: String(row.subject_digest),
    },
    revision: {
      revisionId: idToString(revisionId),
      sourceRevisionKey: String(row.source_revision_key),
      revisionNumber: Number(row.revision_number),
      revisionKind: String(row.revision_kind) as CanonicalEInvoiceRevisionKind,
      state: String(row.state) as "active" | "revoked",
      invoiceNumber: String(row.invoice_number),
      randomNumber: row.random_number === null || row.random_number === undefined ? null : String(row.random_number),
      seller: {
        taxId: String(row.seller_tax_id),
        name: row.seller_name === null || row.seller_name === undefined ? null : String(row.seller_name),
      },
      total: viewMoney(row.amount_coefficient, row.amount_scale, row.currency, row.currency_authority),
      occurrence: {
        value: String(row.occurrence_value),
        precision: String(row.occurrence_precision) as "date" | "minute" | "second",
        timeZone: String(row.occurrence_time_zone),
        origin: String(row.occurrence_origin) as "source-reported" | "provider-reported-date-fallback",
      },
      authority: {
        routeKey: String(row.authority_route),
        contractVersion: String(row.contract_version),
      },
      provenance: {
        kind: String(row.provenance_kind) as CanonicalEInvoiceProvenance["kind"],
        reference: String(row.provenance_reference),
        sourceField: row.provenance_source_field === null || row.provenance_source_field === undefined ? null : String(row.provenance_source_field),
      },
      revocationReason: row.revocation_reason === null || row.revocation_reason === undefined ? null : String(row.revocation_reason),
      captureId: idToString(row.capture_id),
      captureKey: String(row.capture_key),
      sourceRecordId: idToString(row.source_record_id),
      commitSequence: Number(row.commit_sequence),
      items: eInvoiceItemsForRevision(db, revisionId),
    },
  });
}

const E_INVOICE_REVISION_SELECT = `
  SELECT revision.revision_id, revision.invoice_id, revision.source_record_id,
         revision.capture_id, revision.source_revision_key, revision.revision_number,
         revision.revision_kind, revision.state, revision.invoice_number,
         revision.random_number, revision.seller_tax_id, revision.seller_name,
         revision.amount_coefficient, revision.amount_scale, revision.currency,
         revision.currency_authority, revision.occurrence_value,
         revision.occurrence_precision, revision.occurrence_time_zone,
         revision.occurrence_origin, revision.authority_route,
         revision.contract_version, revision.provenance_kind,
         revision.provenance_reference, revision.provenance_source_field,
         revision.revocation_reason, invoice.stable_invoice_key,
         connection.source_connection_key, epoch.epoch_key AS identity_epoch_key,
         subject.subject_digest, capture.capture_key,
         commit_row.commit_sequence
    FROM einvoice_invoice_revisions revision
    JOIN einvoice_invoices invoice ON invoice.invoice_id = revision.invoice_id
    JOIN source_connections connection ON connection.source_connection_id = invoice.source_connection_id
    JOIN identity_epochs epoch ON epoch.identity_epoch_id = invoice.identity_epoch_id
    JOIN source_subjects subject ON subject.source_subject_id = invoice.source_subject_id
    JOIN source_captures capture ON capture.capture_id = revision.capture_id
    JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id`;

function currentOrHistoricalRows(
  db: DatabaseSync,
  knowledgeAt?: number,
): readonly Record<string, unknown>[] {
  const cutoff = knowledgeAt === undefined ? "" : "WHERE source_row.commit_sequence <= ?";
  const rows = db
    .prepare(
      `WITH ranked AS (
         SELECT source_row.*,
                ROW_NUMBER() OVER (
                  PARTITION BY source_row.invoice_id
                  ORDER BY source_row.revision_number DESC,
                           source_row.commit_sequence DESC,
                           source_row.revision_id DESC
                ) AS rank
           FROM (${E_INVOICE_REVISION_SELECT}) source_row
           ${cutoff}
       )
       SELECT * FROM ranked WHERE rank = 1
       ORDER BY commit_sequence, stable_invoice_key`,
    )
    .all(...(knowledgeAt === undefined ? [] : [knowledgeAt])) as Array<Record<string, unknown>>;
  return rows;
}

function validateQueryStore(store: CanonicalSourceStore): void {
  assertValidatedCanonicalSourceStore(store);
  validateCanonicalEInvoiceSchema(store.db);
}

export function queryCanonicalEInvoiceCurrent(
  store: CanonicalSourceStore,
): CanonicalEInvoiceCurrentQuery {
  validateQueryStore(store);
  return withCanonicalSnapshot(store.db, () => {
    return queryCanonicalEInvoiceCurrentFromDatabase(store.db);
  });
}

/** Read a current E-Invoice view inside a caller-owned canonical snapshot. */
export function queryCanonicalEInvoiceCurrentFromDatabase(
  db: DatabaseSync,
): CanonicalEInvoiceCurrentQuery {
  validateCanonicalEInvoiceSchema(db);
  const knowledgeAt = latestCommitSequence(db);
  return Object.freeze({
    kind: "current" as const,
    knowledgeAt,
    invoices: Object.freeze(currentOrHistoricalRows(db).map((row) => revisionView(db, row))),
  });
}

export function queryCanonicalEInvoiceHistorical(
  store: CanonicalSourceStore,
  request: Readonly<{ knowledgeAt: number }>,
): CanonicalEInvoiceHistoricalQuery {
  validateQueryStore(store);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt < 0)
    throw new CanonicalEInvoiceAdmissionError("invalid-contract", "E-Invoice historical knowledge cutoff is invalid.");
  return withCanonicalSnapshot(store.db, () => {
    return queryCanonicalEInvoiceHistoricalFromDatabase(store.db, request);
  });
}

/** Read a historical E-Invoice view inside a caller-owned snapshot. */
export function queryCanonicalEInvoiceHistoricalFromDatabase(
  db: DatabaseSync,
  request: Readonly<{ knowledgeAt: number }>,
): CanonicalEInvoiceHistoricalQuery {
  validateCanonicalEInvoiceSchema(db);
  const latest = latestCommitSequence(db);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt < 0 || request.knowledgeAt > latest)
    throw new CanonicalEInvoiceAdmissionError("invalid-contract", "E-Invoice historical knowledge cutoff exceeds known commits.");
  return Object.freeze({
    kind: "historical" as const,
    knowledgeAt: request.knowledgeAt,
    invoices: Object.freeze(currentOrHistoricalRows(db, request.knowledgeAt).map((row) => revisionView(db, row))),
  });
}

/** Read one historical invoice without materializing every invoice revision. */
export function queryCanonicalEInvoiceByIdFromDatabase(
  db: DatabaseSync,
  request: Readonly<{ invoiceId: string; knowledgeAt: number }>,
): CanonicalEInvoiceView | null {
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu.test(request.invoiceId) ||
      !Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt < 0)
    throw new CanonicalEInvoiceAdmissionError("invalid-contract", "E-Invoice identity or knowledge cutoff is invalid.");
  const invoiceId = Buffer.from(request.invoiceId.replaceAll("-", ""), "hex");
  const row = db.prepare(`
    WITH ranked AS (
      SELECT source_row.*,
             ROW_NUMBER() OVER (
               PARTITION BY source_row.invoice_id
               ORDER BY source_row.revision_number DESC,
                        source_row.commit_sequence DESC,
                        source_row.revision_id DESC
             ) AS rank
        FROM (${E_INVOICE_REVISION_SELECT}) source_row
       WHERE source_row.invoice_id = ? AND source_row.commit_sequence <= ?
    )
    SELECT * FROM ranked WHERE rank = 1
  `).get(invoiceId, request.knowledgeAt) as Record<string, unknown> | undefined;
  return row ? revisionView(db, row) : null;
}

export function queryCanonicalEInvoiceLineage(
  store: CanonicalSourceStore,
  request: CanonicalEInvoiceLineageRequest,
): CanonicalEInvoiceLineageQuery {
  validateQueryStore(store);
  const identity = normalizeCanonicalEInvoiceLineageRequest(request);
  return withCanonicalSnapshot(store.db, () => {
    const rows = store.db
      .prepare(
        `${E_INVOICE_REVISION_SELECT}
          WHERE connection.integration_namespace = ?
            AND connection.source_connection_key = ?
            AND epoch.epoch_key = ?
            AND subject.stream = ?
            AND subject.record_kind = ?
            AND subject.subject_digest = ?
            AND invoice.stable_invoice_key = ?
          ORDER BY revision.revision_number, commit_row.commit_sequence`,
      )
      .all(
        E_INVOICE_INTEGRATION_NAMESPACE,
        identity.sourceConnectionKey,
        identity.identityEpoch,
        E_INVOICE_STREAM,
        E_INVOICE_RECORD_KIND,
        identity.subjectDigest,
        identity.stableInvoiceKey,
      ) as Array<Record<string, unknown>>;
    const revisions = Object.freeze(rows.map((row) => revisionView(store.db, row)));
    const invoice = revisions.at(-1) ?? null;
    const observations = invoice === null
      ? []
      : Object.freeze(
          (store.db
            .prepare(
              `SELECT observation.revision_id, observation.source_record_id,
                      observation.capture_id, capture.capture_key,
                      commit_row.commit_sequence
                 FROM einvoice_revision_observations observation
                 JOIN source_captures capture ON capture.capture_id = observation.capture_id
                 JOIN canonical_commits commit_row ON commit_row.commit_id = observation.commit_id
                WHERE observation.revision_id IN (
                  SELECT revision_id
                    FROM einvoice_invoice_revisions revision
                   WHERE revision.invoice_id = ?
                )
                ORDER BY commit_row.commit_sequence, observation.source_record_id`,
            )
            .all(idFromView(invoice)) as Array<Record<string, unknown>>
          ).map((row) => ({
            revisionId: idToString(row.revision_id),
            sourceRecordId: idToString(row.source_record_id),
            captureId: idToString(row.capture_id),
            captureKey: String(row.capture_key),
            commitSequence: Number(row.commit_sequence),
          })),
        );
    const events = invoice === null
      ? []
      : Object.freeze(
          (store.db
            .prepare(
              `SELECT event.event_id, event.invoice_id, event.revision_id,
                      event.source_record_id, event.capture_id, capture.capture_key,
                      event.commit_id, event.event_kind, event.event_at, event.reason,
                      commit_row.commit_sequence
                 FROM einvoice_revision_events event
                 JOIN source_captures capture ON capture.capture_id = event.capture_id
                 JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
                WHERE event.invoice_id = ?
                ORDER BY commit_row.commit_sequence, event.event_id`,
            )
            .all(idFromView(invoice)) as Array<Record<string, unknown>>
          ).map((row) => ({
            eventId: idToString(row.event_id),
            invoiceId: idToString(row.invoice_id),
            revisionId: idToString(row.revision_id),
            sourceRecordId: idToString(row.source_record_id),
            captureId: idToString(row.capture_id),
            captureKey: String(row.capture_key),
            commitSequence: Number(row.commit_sequence),
            kind: String(row.event_kind) as CanonicalEInvoiceLineageEvent["kind"],
            eventAt: String(row.event_at),
            reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
          })),
        );
    return Object.freeze({
      kind: "lineage" as const,
      identity,
      invoice,
      revisions,
      observations,
      events,
      provenanceComplete: invoice === null ? true : observations.length > 0 && revisions.every((entry) => observations.some((observation) => observation.revisionId === entry.revision.revisionId)),
    });
  });
}

function idFromView(view: CanonicalEInvoiceView): Buffer {
  return Buffer.from(view.invoiceId.replaceAll("-", ""), "hex");
}
