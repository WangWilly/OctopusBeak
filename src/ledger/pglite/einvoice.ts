import { createHash, randomUUID } from "node:crypto";
import type {
  CanonicalEInvoiceCaptureInput,
  CanonicalEInvoiceCompleteness,
  CanonicalEInvoiceExactDecimal,
  CanonicalEInvoiceInput,
  CanonicalEInvoiceItemInput,
  CanonicalEInvoiceMoney,
  CanonicalEInvoiceOccurrence,
  CanonicalEInvoiceProvenance,
} from "../canonical/einvoice-contract.ts";
import {
  stableCanonicalSourceJson,
  type CanonicalSourceEvidence,
  type CanonicalSourcePage,
} from "../canonical/canonical-source-evidence.ts";
import {
  assertPGliteCanonicalCommitNotCancelled,
  admitPGliteCanonicalSourceCaptureInTransaction,
  type PGliteCanonicalCommitOptions,
} from "./canonical-source-store.ts";
import { syncEInvoiceItemCategorizations } from "./einvoice-item-categorization.ts";
import type { PGliteTransaction, PGliteStore } from "./transaction.ts";
import { PGLITE_CANONICAL_EINVOICE_COMMIT_COMMAND } from "./workflow-commands.ts";

export { PGLITE_CANONICAL_EINVOICE_COMMIT_COMMAND };
export const PGLITE_EINVOICE_INTEGRATION_NAMESPACE = "einvoice" as const;
export const PGLITE_EINVOICE_STREAM = "personal-invoices" as const;
export const PGLITE_EINVOICE_RECORD_KIND = "personal-invoice" as const;
export const PGLITE_EINVOICE_ROUTE =
  "einvoice/personal-invoices/canonical-v1" as const;
export const PGLITE_EINVOICE_CONTRACT_VERSION =
  "einvoice/personal-invoices/canonical-v1" as const;
export const PGLITE_EINVOICE_COMPLETENESS_RULE_VERSION =
  "einvoice/personal-invoices/completeness-v1" as const;
export const PGLITE_EINVOICE_CURRENCY_AUTHORITY =
  "taiwan/e-invoice/twd/v1" as const;

export type PGliteCanonicalEInvoiceCommitCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_EINVOICE_COMMIT_COMMAND;
  request: CanonicalEInvoiceCaptureInput;
}>;

export type PGliteCanonicalEInvoiceCommitResult = Readonly<{
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

export class PGliteCanonicalEInvoiceAdmissionError extends Error {
  readonly code:
    | "invalid-contract"
    | "required-data"
    | "revision-conflict";

  constructor(
    code: PGliteCanonicalEInvoiceAdmissionError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PGliteCanonicalEInvoiceAdmissionError";
    this.code = code;
  }
}

type Exact = Readonly<{ coefficient: string; scale: number }>;
type Money = Exact & Readonly<{
  currency: "TWD";
  currencyAuthority: typeof PGLITE_EINVOICE_CURRENCY_AUTHORITY;
}>;
type Item = Readonly<{
  sequence: number;
  completeness: CanonicalEInvoiceCompleteness;
  name: string | null;
  quantity: Exact | null;
  unitPrice: Money | null;
  amount: Money | null;
  sourceFactJson: string;
}>;
type Invoice = Readonly<{
  stableInvoiceKey: string;
  sourceRevisionKey: string;
  revisionNumber: number;
  revisionKind: "issued" | "revised" | "revoked";
  state: "active" | "revoked";
  invoiceNumber: string;
  randomNumber: string | null;
  sellerTaxId: string;
  sellerName: string | null;
  total: Money | null;
  occurrence: CanonicalEInvoiceOccurrence;
  items: readonly Item[];
  provenance: CanonicalEInvoiceProvenance;
  revocationReason: string | null;
  fingerprint: string;
  occurrenceKey: string;
}>;

const OPAQUE_TOKEN = /^sha256:[A-Za-z0-9_-]+$/u;
const EXACT = /^-?(?:0|[1-9]\d*)$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;
const SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/u;

function fail(code: PGliteCanonicalEInvoiceAdmissionError["code"], message: string): never {
  throw new PGliteCanonicalEInvoiceAdmissionError(code, message);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail("required-data", `${label} is required.`);
  return value.trim();
}

function token(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!OPAQUE_TOKEN.test(normalized)) fail("invalid-contract", `${label} must be an opaque sha256 token.`);
  return normalized;
}

function exact(value: unknown, label: string): Exact {
  if (value === null || typeof value !== "object") fail("required-data", `${label} is required.`);
  const candidate = value as Partial<CanonicalEInvoiceExactDecimal>;
  const coefficient = typeof candidate.coefficient === "bigint"
    ? candidate.coefficient.toString(10)
    : typeof candidate.coefficient === "string" ? candidate.coefficient.trim() : "";
  if (!EXACT.test(coefficient)) fail("invalid-contract", `${label} coefficient must be an exact signed integer.`);
  if (typeof candidate.scale !== "number" || !Number.isSafeInteger(candidate.scale) || candidate.scale < 0)
    fail("invalid-contract", `${label} scale must be a safe non-negative integer.`);
  return { coefficient: coefficient === "-0" ? "0" : coefficient, scale: candidate.scale };
}

function money(value: unknown, label: string): Money {
  if (value === null || typeof value !== "object") fail("required-data", `${label} is required.`);
  const candidate = value as Partial<CanonicalEInvoiceMoney>;
  if (candidate.currency !== "TWD") fail("invalid-contract", `${label} must use TWD.`);
  if (candidate.currencyAuthority !== PGLITE_EINVOICE_CURRENCY_AUTHORITY)
    fail("invalid-contract", `${label} must declare the TWD currency authority.`);
  return { ...exact(candidate, label), currency: "TWD", currencyAuthority: PGLITE_EINVOICE_CURRENCY_AUTHORITY };
}

function validDate(value: string, label: string): string {
  const match = DATE.exec(value);
  if (!match) fail("invalid-contract", `${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (date.toISOString().slice(0, 10) !== value) fail("invalid-contract", `${label} must be a calendar date.`);
  return value;
}

function compactValue(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("invalid-contract", `${path} contains a non-exact number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => compactValue(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:raw|headers?|cookies?|password|secrets?|credentials?|tokens?)$/iu.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")))
        fail("invalid-contract", `${path}.${key} is not compact source evidence.`);
      compactValue(entry, `${path}.${key}`);
    }
    return;
  }
  fail("invalid-contract", `${path} contains an unsupported value.`);
}

function occurrence(value: unknown): CanonicalEInvoiceOccurrence {
  if (value === null || typeof value !== "object") fail("required-data", "Invoice occurrence is required.");
  const candidate = value as Partial<CanonicalEInvoiceOccurrence>;
  if (candidate.precision !== "date" && candidate.precision !== "minute" && candidate.precision !== "second")
    fail("invalid-contract", "Invoice occurrence precision is unsupported.");
  const occurrenceValue = text(candidate.value, "Invoice occurrence value");
  const match = (candidate.precision === "date" ? DATE : candidate.precision === "minute" ? MINUTE : SECOND).exec(occurrenceValue);
  if (!match) fail("invalid-contract", "Invoice occurrence value does not match its precision.");
  validDate(`${match[1]}-${match[2]}-${match[3]}`, "Invoice occurrence date");
  const hour = candidate.precision === "date" ? 0 : Number(match[4]);
  const minute = candidate.precision === "date" ? 0 : Number(match[5]);
  const second = candidate.precision === "second" ? Number(match[6]) : 0;
  if (hour > 23 || minute > 59 || second > 59) fail("invalid-contract", "Invoice occurrence time is invalid.");
  const timeZone = text(candidate.timeZone, "Invoice occurrence time zone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch (error) {
    fail("invalid-contract", `Invoice occurrence time zone is invalid: ${timeZone}.`);
  }
  if (candidate.origin !== "source-reported" && candidate.origin !== "provider-reported-date-fallback")
    fail("invalid-contract", "Invoice occurrence origin is unsupported.");
  if (candidate.origin === "provider-reported-date-fallback" && candidate.precision !== "date")
    fail("invalid-contract", "Provider date fallback must retain date precision.");
  return { value: occurrenceValue, precision: candidate.precision, timeZone, origin: candidate.origin };
}

function normalizeItem(value: CanonicalEInvoiceItemInput, index: number): Item {
  if (value === null || typeof value !== "object") fail("required-data", `Invoice item ${index} is required.`);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) fail("invalid-contract", `Invoice item ${index} sequence is invalid.`);
  if (value.completeness !== "complete" && value.completeness !== "incomplete") fail("invalid-contract", `Invoice item ${index} completeness is unsupported.`);
  const name = value.name == null ? null : text(value.name, `Invoice item ${index} name`);
  const quantity = value.quantity == null ? null : exact(value.quantity, `Invoice item ${index} quantity`);
  if (quantity?.coefficient.startsWith("-")) fail("invalid-contract", `Invoice item ${index} quantity cannot be negative.`);
  const unitPrice = value.unitPrice == null ? null : money(value.unitPrice, `Invoice item ${index} unit price`);
  const amount = value.amount == null ? null : money(value.amount, `Invoice item ${index} amount`);
  if (value.completeness === "complete" && (!name || !quantity || !unitPrice || !amount))
    fail("required-data", `Complete invoice item ${index} is missing a required fact.`);
  if (value.completeness === "incomplete" && !name && !quantity && !unitPrice && !amount)
    fail("required-data", `Incomplete invoice item ${index} must retain at least one source fact.`);
  const sourceFacts = value.sourceFacts ?? {};
  if (sourceFacts === null || typeof sourceFacts !== "object" || Array.isArray(sourceFacts))
    fail("invalid-contract", `Invoice item ${index} source facts must be a compact object.`);
  compactValue(sourceFacts, `invoice[${index}].sourceFacts`);
  const sourceFactJson = stableCanonicalSourceJson({
    ...(sourceFacts as Record<string, unknown>),
    completeness: value.completeness,
    ...(name === null ? {} : { name }),
    ...(quantity === null ? {} : { quantity }),
    ...(unitPrice === null ? {} : { unitPrice }),
    ...(amount === null ? {} : { amount }),
  });
  return { sequence: value.sequence, completeness: value.completeness, name, quantity, unitPrice, amount, sourceFactJson };
}

function sourceToken(...parts: string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(parts.join("\u0000")).digest("base64url")}`;
}

function normalizeInvoice(value: CanonicalEInvoiceInput, index: number, scope: CanonicalEInvoiceCaptureInput["scope"], sourceConnectionKey: string, identityEpoch: string, subjectDigest: string): Invoice {
  if (value === null || typeof value !== "object") fail("required-data", `Invoice ${index} is required.`);
  const stableInvoiceKey = text(value.stableInvoiceKey, `Invoice ${index} stable identity`);
  const sourceRevisionKey = text(value.sourceRevisionKey, `Invoice ${index} revision identity`);
  if (!Number.isSafeInteger(value.revisionNumber) || value.revisionNumber < 1) fail("invalid-contract", `Invoice ${index} revision number is invalid.`);
  if (value.revisionKind !== "issued" && value.revisionKind !== "revised" && value.revisionKind !== "revoked") fail("invalid-contract", `Invoice ${index} revision kind is unsupported.`);
  const invoiceNumber = text(value.sourceIdentifiers?.invoiceNumber, `Invoice ${index} invoice number`);
  const randomNumber = value.sourceIdentifiers?.randomNumber == null ? null : text(value.sourceIdentifiers.randomNumber, `Invoice ${index} random number`);
  const sellerTaxId = text(value.seller?.taxId, `Invoice ${index} seller tax ID`);
  const sellerName = value.seller?.name == null ? null : text(value.seller.name, `Invoice ${index} seller name`);
  if (value.authority?.routeKey !== PGLITE_EINVOICE_ROUTE || value.authority?.contractVersion !== PGLITE_EINVOICE_CONTRACT_VERSION)
    fail("invalid-contract", `Invoice ${index} authority contract is unsupported.`);
  const provenance = value.provenance;
  if (provenance === null || typeof provenance !== "object") fail("required-data", `Invoice ${index} provenance is required.`);
  if (provenance.kind !== "provider-record" && provenance.kind !== "provider-revocation" && provenance.kind !== "fixture") fail("invalid-contract", `Invoice ${index} provenance kind is unsupported.`);
  const normalizedProvenance: CanonicalEInvoiceProvenance = {
    kind: provenance.kind,
    reference: text(provenance.reference, `Invoice ${index} provenance reference`),
    sourceField: provenance.sourceField == null ? null : text(provenance.sourceField, `Invoice ${index} provenance source field`),
  };
  const normalizedOccurrence = occurrence(value.occurrence);
  const occurrenceDate = normalizedOccurrence.value.slice(0, 10);
  if (occurrenceDate < scope.startDate || occurrenceDate > scope.endDate) fail("invalid-contract", `Invoice ${index} occurrence is outside the capture scope.`);
  const total = value.total == null ? null : money(value.total, `Invoice ${index} total`);
  const revocationReason = value.revocationReason == null ? null : text(value.revocationReason, `Invoice ${index} revocation reason`);
  if (value.revisionKind === "revoked") {
    if (!revocationReason) fail("required-data", `Revoked invoice ${index} requires a source revocation reason.`);
    if (total !== null) fail("invalid-contract", `Revoked invoice ${index} must not fabricate a replacement total.`);
    if (normalizedProvenance.kind !== "provider-revocation") fail("invalid-contract", `Revoked invoice ${index} requires provider-revocation provenance.`);
  } else if (total === null) fail("required-data", `Issued or revised invoice ${index} requires a total.`);
  const items = (value.items ?? []).map((entry, itemIndex) => normalizeItem(entry, itemIndex));
  const sequences = new Set<number>();
  for (const item of items) {
    if (sequences.has(item.sequence)) fail("invalid-contract", `Invoice ${index} contains duplicate item sequence ${item.sequence}.`);
    sequences.add(item.sequence);
  }
  if (scope.itemCompleteness === "complete" && items.some((item) => item.completeness !== "complete"))
    fail("invalid-contract", `Invoice ${index} has incomplete items in a complete item scope.`);
  const canonical = {
    stableInvoiceKey,
    sourceRevisionKey,
    revisionNumber: value.revisionNumber,
    revisionKind: value.revisionKind,
    invoiceNumber,
    randomNumber,
    seller: { taxId: sellerTaxId, name: sellerName },
    total,
    occurrence: normalizedOccurrence,
    items,
    authority: value.authority,
    provenance: normalizedProvenance,
    revocationReason,
  };
  const fingerprint = `sha256:${createHash("sha256").update(stableCanonicalSourceJson(canonical)).digest("base64url")}`;
  const occurrenceKey = sourceToken("einvoice-occurrence", sourceConnectionKey, identityEpoch, subjectDigest, stableInvoiceKey, sourceRevisionKey);
  return {
    stableInvoiceKey,
    sourceRevisionKey,
    revisionNumber: value.revisionNumber,
    revisionKind: value.revisionKind,
    state: value.revisionKind === "revoked" ? "revoked" : "active",
    invoiceNumber,
    randomNumber,
    sellerTaxId,
    sellerName,
    total,
    occurrence: normalizedOccurrence,
    items,
    provenance: normalizedProvenance,
    revocationReason,
    fingerprint,
    occurrenceKey,
  };
}

function normalizedCompact(invoice: Invoice): Record<string, unknown> {
  return {
    stableInvoiceKey: invoice.stableInvoiceKey,
    sourceRevisionKey: invoice.sourceRevisionKey,
    revisionNumber: invoice.revisionNumber,
    revisionKind: invoice.revisionKind,
    invoiceNumber: invoice.invoiceNumber,
    randomNumber: invoice.randomNumber,
    seller: { taxId: invoice.sellerTaxId, name: invoice.sellerName },
    total: invoice.total,
    occurrence: invoice.occurrence,
    items: invoice.items,
    authority: { routeKey: PGLITE_EINVOICE_ROUTE, contractVersion: PGLITE_EINVOICE_CONTRACT_VERSION },
    provenance: invoice.provenance,
    revocationReason: invoice.revocationReason,
  };
}

function normalizeCapture(input: CanonicalEInvoiceCaptureInput): { evidence: CanonicalSourceEvidence; invoices: readonly Invoice[] } {
  if (input === null || typeof input !== "object") fail("required-data", "E-Invoice capture is required.");
  text(input.captureId, "E-Invoice capture ID");
  const sourceConnectionKey = token(input.sourceConnectionKey, "E-Invoice source connection key");
  const identityEpoch = token(input.identityEpoch, "E-Invoice identity epoch");
  const subjectDigest = token(input.subjectDigest, "E-Invoice subject digest");
  if (!RFC3339.test(input.observedAt) || !Number.isFinite(Date.parse(input.observedAt))) fail("invalid-contract", "E-Invoice observedAt must be RFC3339.");
  validDate(input.scope.startDate, "E-Invoice scope start");
  validDate(input.scope.endDate, "E-Invoice scope end");
  if (input.scope.startDate > input.scope.endDate) fail("invalid-contract", "E-Invoice scope dates are inverted.");
  if (input.scope.kind !== "bounded-range" && input.scope.kind !== "point-in-time") fail("invalid-contract", "E-Invoice scope kind is unsupported.");
  if (input.scope.completeness !== "complete-range" && input.scope.completeness !== "single-page") fail("invalid-contract", "E-Invoice scope completeness is unsupported.");
  if (input.scope.invoiceCompleteness !== "complete" && input.scope.invoiceCompleteness !== "incomplete") fail("invalid-contract", "E-Invoice invoice completeness is unsupported.");
  if (input.scope.itemCompleteness !== "complete" && input.scope.itemCompleteness !== "incomplete") fail("invalid-contract", "E-Invoice item completeness is unsupported.");
  if (!Array.isArray(input.pages) || input.pages.length === 0) fail("required-data", "E-Invoice capture requires at least one page.");
  input.pages.forEach((page, index) => {
    if (page.pageOrdinal !== index || (page.responseCode !== "200" && page.responseCode !== "204") || !Number.isSafeInteger(page.rowCount) || page.rowCount < 0)
      fail("invalid-contract", "E-Invoice page sequence/status/row count is invalid.");
    if (page.responseCode === "204" && page.rowCount !== 0) fail("invalid-contract", "E-Invoice HTTP 204 page must not claim invoice rows.");
    if (page.terminal !== (index === input.pages.length - 1)) fail("invalid-contract", "E-Invoice page terminal marker is inconsistent.");
    compactValue(page.metadata, `page[${index}].metadata`);
  });
  const invoices = Array.isArray(input.invoices)
    ? input.invoices.map((entry, index) => normalizeInvoice(entry, index, input.scope, sourceConnectionKey, identityEpoch, subjectDigest))
    : fail("required-data", "E-Invoice invoices must be an array.");
  const rowCount = input.pages.reduce((sum, page) => sum + page.rowCount, 0);
  if (rowCount !== invoices.length) fail("invalid-contract", "E-Invoice page row counts do not match invoices.");
  if (invoices.length === 0 && (input.scope.invoiceCompleteness !== "complete" || input.scope.itemCompleteness !== "complete"))
    fail("invalid-contract", "An empty E-Invoice scope is valid only when both invoice and item completeness are complete.");
  if (invoices.length > 0 && input.scope.invoiceCompleteness !== "complete") fail("invalid-contract", "E-Invoice capture must explicitly complete invoice headers before admission.");
  const pages: CanonicalSourcePage[] = input.pages.map((page) => ({
    pageOrdinal: page.pageOrdinal,
    responseCode: page.responseCode,
    rowCount: page.rowCount,
    terminal: page.terminal,
    metadata: page.metadata,
  }));
  return {
    invoices,
    evidence: {
      captureId: input.captureId,
      integrationNamespace: PGLITE_EINVOICE_INTEGRATION_NAMESPACE,
      sourceConnectionKey,
      identityEpoch,
      stream: PGLITE_EINVOICE_STREAM,
      recordKind: PGLITE_EINVOICE_RECORD_KIND,
      routeKey: PGLITE_EINVOICE_ROUTE,
      contractVersion: PGLITE_EINVOICE_CONTRACT_VERSION,
      subjectDigest,
      observedAt: input.observedAt,
      scope: {
        startDate: input.scope.startDate,
        endDate: input.scope.endDate,
        dateFormat: "YYYY-MM-DD",
        kind: input.scope.kind,
        completeness: input.scope.completeness,
        ruleVersion: PGLITE_EINVOICE_COMPLETENESS_RULE_VERSION,
        completenessBasis: "einvoice/canonical-v1/declared-scope",
        absenceAuthority: input.scope.absenceAuthority,
      },
      pages,
      records: invoices.map((invoice) => {
        const compact = normalizedCompact(invoice);
        return {
          occurrenceKey: invoice.occurrenceKey,
          providerKey: sourceToken("einvoice-provider", invoice.provenance.reference),
          contentHash: `sha256:${createHash("sha256").update(stableCanonicalSourceJson(compact)).digest("base64url")}`,
          sequenceLexeme: invoice.sourceRevisionKey,
          description: invoice.sellerName,
          compact,
        };
      }),
    },
  };
}

function uuidBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
}

function idString(value: unknown): string {
  const bytes = value instanceof Uint8Array || Buffer.isBuffer(value)
    ? Buffer.from(value).toString("hex")
    : String(value).replace(/^\\x/u, "").replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/iu.test(bytes)) throw new Error("PGlite E-Invoice returned an invalid UUID.");
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-${bytes.slice(12, 16)}-${bytes.slice(16, 20)}-${bytes.slice(20)}`.toLowerCase();
}

async function query<T>(transaction: PGliteTransaction, sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
  let index = 0;
  return (await transaction.query<T>(sql.replace(/\?/gu, () => `$${++index}`), params)).rows;
}

async function first<T>(transaction: PGliteTransaction, sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
  return (await query<T>(transaction, sql, params))[0];
}

async function insertItems(transaction: PGliteTransaction, revisionId: Uint8Array, items: readonly Item[]): Promise<number> {
  for (const item of items) {
    await query(transaction, `INSERT INTO einvoice_items(
      item_id, revision_id, sequence, completeness, name,
      quantity_coefficient, quantity_scale, unit_price_coefficient, unit_price_scale,
      unit_price_currency, unit_price_currency_authority, amount_coefficient, amount_scale,
      amount_currency, amount_currency_authority, source_fact_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      uuidBytes(), revisionId, item.sequence, item.completeness, item.name,
      item.quantity?.coefficient ?? null, item.quantity?.scale ?? null,
      item.unitPrice?.coefficient ?? null, item.unitPrice?.scale ?? null,
      item.unitPrice?.currency ?? null, item.unitPrice?.currencyAuthority ?? null,
      item.amount?.coefficient ?? null, item.amount?.scale ?? null,
      item.amount?.currency ?? null, item.amount?.currencyAuthority ?? null,
      item.sourceFactJson,
    ]);
  }
  return items.length;
}

async function insertEvent(transaction: PGliteTransaction, input: Readonly<{
  invoiceId: Uint8Array;
  revisionId: Uint8Array;
  sourceRecordId: Uint8Array;
  captureId: Uint8Array;
  commitId: Uint8Array;
  kind: "issued" | "revised" | "revoked" | "observed" | "superseded";
  eventAt: string;
  reason?: string | null;
}>): Promise<void> {
  await query(transaction, `INSERT INTO einvoice_revision_events(
    event_id, invoice_id, revision_id, source_record_id, capture_id, commit_id,
    event_kind, event_at, reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    uuidBytes(), input.invoiceId, input.revisionId, input.sourceRecordId,
    input.captureId, input.commitId, input.kind, input.eventAt, input.reason ?? null,
  ]);
}

async function persistInvoice(
  transaction: PGliteTransaction,
  input: CanonicalEInvoiceCaptureInput,
  invoice: Invoice,
  admitted: Awaited<ReturnType<typeof admitPGliteCanonicalSourceCaptureInTransaction>>,
): Promise<{ invoiceId: Uint8Array; insertedInvoice: boolean; insertedRevision: boolean; duplicate: boolean; itemCount: number }> {
  const sourceRecordId = admitted.sourceRecordIdsByOccurrence.get(invoice.occurrenceKey);
  if (!sourceRecordId) throw new Error(`E-Invoice source record is missing: ${invoice.occurrenceKey}`);
  const existingInvoice = await first<{ invoice_id: unknown }>(transaction, `SELECT invoice_id
    FROM einvoice_invoices
    WHERE source_connection_id = ? AND identity_epoch_id = ? AND source_subject_id = ?
      AND stable_invoice_key = ?`, [admitted.sourceConnectionId, admitted.identityEpochId, admitted.sourceSubjectId, invoice.stableInvoiceKey]);
  const invoiceId = existingInvoice?.invoice_id
    ? (existingInvoice.invoice_id as Uint8Array)
    : uuidBytes();
  if (!existingInvoice) {
    await query(transaction, `INSERT INTO einvoice_invoices(
      invoice_id, source_connection_id, identity_epoch_id, source_subject_id,
      stable_invoice_key, created_commit_id
    ) VALUES (?, ?, ?, ?, ?, ?)`, [invoiceId, admitted.sourceConnectionId, admitted.identityEpochId, admitted.sourceSubjectId, invoice.stableInvoiceKey, admitted.commitId]);
  }
  const existingRevision = await first<{ revision_id: unknown; fact_fingerprint: string; revision_number: number | string; revision_kind: string }>(transaction, `SELECT revision_id, fact_fingerprint, revision_number, revision_kind
    FROM einvoice_invoice_revisions WHERE invoice_id = ? AND source_revision_key = ?`, [invoiceId, invoice.sourceRevisionKey]);
  if (existingRevision) {
    if (existingRevision.fact_fingerprint !== invoice.fingerprint || Number(existingRevision.revision_number) !== invoice.revisionNumber || existingRevision.revision_kind !== invoice.revisionKind)
      fail("revision-conflict", `E-Invoice revision ${invoice.sourceRevisionKey} changed after admission.`);
    const revisionId = existingRevision.revision_id as Uint8Array;
    const observed = await query(transaction, `INSERT INTO einvoice_revision_observations(
      revision_id, source_record_id, capture_id, commit_id
    ) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING revision_id`, [revisionId, sourceRecordId, admitted.captureId, admitted.commitId]);
    if (observed.length > 0)
      await insertEvent(transaction, { invoiceId, revisionId, sourceRecordId, captureId: admitted.captureId, commitId: admitted.commitId, kind: "observed", eventAt: input.observedAt });
    return { invoiceId, insertedInvoice: !existingInvoice, insertedRevision: false, duplicate: true, itemCount: 0 };
  }
  const sameNumber = await first<{ revision_id: unknown }>(transaction, "SELECT revision_id FROM einvoice_invoice_revisions WHERE invoice_id = ? AND revision_number = ?", [invoiceId, invoice.revisionNumber]);
  if (sameNumber) fail("revision-conflict", `E-Invoice revision number ${invoice.revisionNumber} already belongs to another source revision.`);
  const latest = await first<{ revision_number: number | string }>(transaction, "SELECT revision_number FROM einvoice_invoice_revisions WHERE invoice_id = ? ORDER BY revision_number DESC LIMIT 1", [invoiceId]);
  if (latest && invoice.revisionNumber <= Number(latest.revision_number)) fail("revision-conflict", `E-Invoice revision ${invoice.revisionNumber} is older than the admitted revision history.`);
  const revisionId = uuidBytes();
  await query(transaction, `INSERT INTO einvoice_invoice_revisions(
    revision_id, invoice_id, source_record_id, capture_id, commit_id,
    source_revision_key, revision_number, revision_kind, state,
    invoice_number, random_number, seller_tax_id, seller_name,
    amount_coefficient, amount_scale, currency, currency_authority,
    occurrence_value, occurrence_precision, occurrence_time_zone, occurrence_origin,
    authority_route, contract_version, provenance_kind, provenance_reference,
    provenance_source_field, revocation_reason, fact_fingerprint
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    revisionId, invoiceId, sourceRecordId, admitted.captureId, admitted.commitId,
    invoice.sourceRevisionKey, invoice.revisionNumber, invoice.revisionKind, invoice.state,
    invoice.invoiceNumber, invoice.randomNumber, invoice.sellerTaxId, invoice.sellerName,
    invoice.total?.coefficient ?? null, invoice.total?.scale ?? null, invoice.total?.currency ?? null,
    invoice.total?.currencyAuthority ?? PGLITE_EINVOICE_CURRENCY_AUTHORITY,
    invoice.occurrence.value, invoice.occurrence.precision, invoice.occurrence.timeZone, invoice.occurrence.origin,
    PGLITE_EINVOICE_ROUTE, PGLITE_EINVOICE_CONTRACT_VERSION, invoice.provenance.kind,
    invoice.provenance.reference, invoice.provenance.sourceField ?? null, invoice.revocationReason, invoice.fingerprint,
  ]);
  const itemCount = await insertItems(transaction, revisionId, invoice.items);
  await query(transaction, `INSERT INTO einvoice_revision_observations(
    revision_id, source_record_id, capture_id, commit_id
  ) VALUES (?, ?, ?, ?)`, [revisionId, sourceRecordId, admitted.captureId, admitted.commitId]);
  await insertEvent(transaction, { invoiceId, revisionId, sourceRecordId, captureId: admitted.captureId, commitId: admitted.commitId, kind: invoice.revisionKind, eventAt: input.observedAt, reason: invoice.revocationReason });
  const prior = await first<{ revision_id: unknown }>(transaction, `SELECT revision_id FROM einvoice_invoice_revisions
    WHERE invoice_id = ? AND revision_number < ? ORDER BY revision_number DESC LIMIT 1`, [invoiceId, invoice.revisionNumber]);
  if (prior)
    await insertEvent(transaction, { invoiceId, revisionId: prior.revision_id as Uint8Array, sourceRecordId, captureId: admitted.captureId, commitId: admitted.commitId, kind: "superseded", eventAt: input.observedAt, reason: `superseded-by-revision-${invoice.revisionNumber}` });
  return { invoiceId, insertedInvoice: !existingInvoice, insertedRevision: true, duplicate: false, itemCount };
}

export async function commitPGliteCanonicalEInvoiceCapture(
  store: PGliteStore,
  input: CanonicalEInvoiceCaptureInput,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalEInvoiceCommitResult> {
  const snapshot = structuredClone(input);
  const normalized = normalizeCapture(snapshot);
  return store.transaction(async (transaction) => {
    const admitted = await admitPGliteCanonicalSourceCaptureInTransaction(transaction, normalized.evidence, options);
    await query(transaction, `INSERT INTO einvoice_captures(
      capture_id, capture_key, scope_id, source_connection_id, identity_epoch_id,
      source_subject_id, authority_route, contract_version, stream, record_kind,
      scope_start, scope_end, scope_kind, scope_completeness,
      invoice_completeness, item_completeness, page_count, commit_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      admitted.captureId, snapshot.captureId, admitted.scopeId, admitted.sourceConnectionId,
      admitted.identityEpochId, admitted.sourceSubjectId, PGLITE_EINVOICE_ROUTE,
      PGLITE_EINVOICE_CONTRACT_VERSION, PGLITE_EINVOICE_STREAM, PGLITE_EINVOICE_RECORD_KIND,
      snapshot.scope.startDate, snapshot.scope.endDate, snapshot.scope.kind, snapshot.scope.completeness,
      snapshot.scope.invoiceCompleteness, snapshot.scope.itemCompleteness, snapshot.pages.length, admitted.commitId,
    ]);
    let insertedInvoiceCount = 0;
    let insertedRevisionCount = 0;
    let observedDuplicateCount = 0;
    let itemCount = 0;
    for (const invoice of normalized.invoices) {
      const result = await persistInvoice(transaction, snapshot, invoice, admitted);
      if (result.insertedInvoice) insertedInvoiceCount += 1;
      if (result.insertedRevision) insertedRevisionCount += 1;
      if (result.duplicate) observedDuplicateCount += 1;
      itemCount += result.itemCount;
      await syncEInvoiceItemCategorizations(transaction, {
        invoiceId: result.invoiceId,
        commitId: admitted.commitId,
        observedAt: snapshot.observedAt,
      });
    }
    assertPGliteCanonicalCommitNotCancelled(options.signal);
    return Object.freeze({
      status: "committed" as const,
      captureId: snapshot.captureId,
      knowledgeAt: admitted.receipt.knowledgePoint,
      sourceRecordIds: Object.freeze(admitted.sourceRecordIds.map(idString)),
      invoiceCount: normalized.invoices.length,
      insertedInvoiceCount,
      insertedRevisionCount,
      observedDuplicateCount,
      itemCount,
    });
  });
}

export function executePGliteCanonicalEInvoiceCommit(
  store: PGliteStore,
  command: PGliteCanonicalEInvoiceCommitCommand | CanonicalEInvoiceCaptureInput,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalEInvoiceCommitResult> {
  return commitPGliteCanonicalEInvoiceCapture(
    store,
    "kind" in command ? command.request : command,
    options,
  );
}
