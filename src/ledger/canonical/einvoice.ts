import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { withCanonicalSnapshot } from "./canonical-runtime.ts";
import {
  withCanonicalSourceCaptureAdmissionTransaction,
  type CanonicalSourceCaptureAdmissionTransactionResult,
} from "./canonical-source-capture-admission.ts";
import {
  requireCanonicalSourceText,
  requireCanonicalSourceToken,
  stableCanonicalSourceJson,
  type CanonicalSourceEvidence,
  type CanonicalSourcePage,
} from "./canonical-source-evidence.ts";
import {
  assertValidatedCanonicalSourceStore,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  blob,
  idToString,
  uuidV7,
  validateCanonicalEInvoiceSchema,
} from "./canonical-schema-implementation.ts";

export const E_INVOICE_INTEGRATION_NAMESPACE = "einvoice" as const;
export const E_INVOICE_STREAM = "personal-invoices" as const;
export const E_INVOICE_RECORD_KIND = "personal-invoice" as const;
export const E_INVOICE_ROUTE = "einvoice/personal-invoices/canonical-v1" as const;
export const E_INVOICE_CONTRACT_VERSION =
  "einvoice/personal-invoices/canonical-v1" as const;
export const E_INVOICE_COMPLETENESS_RULE_VERSION =
  "einvoice/personal-invoices/completeness-v1" as const;
export const E_INVOICE_CURRENCY_AUTHORITY = "taiwan/e-invoice/twd/v1" as const;

const OPAQUE_TOKEN = /^sha256:[A-Za-z0-9_-]+$/u;
const EXACT_COEFFICIENT = /^-?(?:0|[1-9]\d*)$/u;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;
const SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/u;
const MAX_CANONICAL_SCALE = Number.MAX_SAFE_INTEGER;

export type CanonicalEInvoiceCompleteness = "complete" | "incomplete";
export type CanonicalEInvoiceRevisionKind = "issued" | "revised" | "revoked";

export type CanonicalEInvoiceExactDecimal = Readonly<{
  coefficient: string | bigint;
  scale: number;
}>;

export type CanonicalEInvoiceMoney = Readonly<{
  coefficient: string | bigint;
  scale: number;
  currency: "TWD";
  /** The contract must explicitly declare why TWD is authoritative. */
  currencyAuthority: typeof E_INVOICE_CURRENCY_AUTHORITY;
}>;

export type CanonicalEInvoiceOccurrence = Readonly<{
  value: string;
  precision: "date" | "minute" | "second";
  timeZone: string;
  /** A provider fallback is allowed only when the source has no actual date. */
  origin: "source-reported" | "provider-reported-date-fallback";
}>;

export type CanonicalEInvoiceProvenance = Readonly<{
  kind: "provider-record" | "provider-revocation" | "fixture";
  reference: string;
  sourceField?: string | null;
}>;

export type CanonicalEInvoiceItemInput = Readonly<{
  sequence: number;
  completeness: CanonicalEInvoiceCompleteness;
  name?: string | null;
  quantity?: CanonicalEInvoiceExactDecimal | null;
  unitPrice?: CanonicalEInvoiceMoney | null;
  amount?: CanonicalEInvoiceMoney | null;
  /** Additional source facts must remain compact and de-identified. */
  sourceFacts?: Readonly<Record<string, unknown>>;
}>;

export type CanonicalEInvoiceInput = Readonly<{
  /** Stable document identity within this E-Invoice source subject. */
  stableInvoiceKey: string;
  /** A new key is required for every source-supported revision. */
  sourceRevisionKey: string;
  revisionNumber: number;
  revisionKind: CanonicalEInvoiceRevisionKind;
  sourceIdentifiers: Readonly<{
    invoiceNumber: string;
    randomNumber?: string | null;
  }>;
  seller: Readonly<{
    taxId: string;
    name?: string | null;
  }>;
  total?: CanonicalEInvoiceMoney | null;
  occurrence: CanonicalEInvoiceOccurrence;
  items: readonly CanonicalEInvoiceItemInput[];
  authority: Readonly<{
    routeKey: typeof E_INVOICE_ROUTE;
    contractVersion: typeof E_INVOICE_CONTRACT_VERSION;
  }>;
  provenance: CanonicalEInvoiceProvenance;
  revocationReason?: string | null;
}>;

export type CanonicalEInvoiceCapturePage = Readonly<{
  pageOrdinal: number;
  responseCode: "200" | "204";
  rowCount: number;
  terminal: boolean;
  metadata: Record<string, unknown>;
}>;

export type CanonicalEInvoiceCaptureInput = Readonly<{
  captureId: string;
  sourceConnectionKey: string;
  identityEpoch: string;
  subjectDigest: string;
  observedAt: string;
  scope: Readonly<{
    startDate: string;
    endDate: string;
    kind: "bounded-range" | "point-in-time";
    completeness: "complete-range" | "single-page";
    invoiceCompleteness: CanonicalEInvoiceCompleteness;
    itemCompleteness: CanonicalEInvoiceCompleteness;
    absenceAuthority?: "comparable-complete-range" | "provider-explicit-no-data";
  }>;
  pages: readonly CanonicalEInvoiceCapturePage[];
  invoices: readonly CanonicalEInvoiceInput[];
}>;

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

export type CanonicalEInvoiceAdmissionFailureReason =
  | "invalid-contract"
  | "required-data"
  | "revision-conflict"
  | "schema";

export class CanonicalEInvoiceAdmissionError extends Error {
  readonly reason: CanonicalEInvoiceAdmissionFailureReason;
  readonly code: CanonicalEInvoiceAdmissionFailureReason;

  constructor(
    reason: CanonicalEInvoiceAdmissionFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CanonicalEInvoiceAdmissionError";
    this.reason = reason;
    this.code = reason;
  }
}

type NormalizedMoney = Readonly<{
  coefficient: string;
  scale: number;
  currency: "TWD";
  currencyAuthority: typeof E_INVOICE_CURRENCY_AUTHORITY;
}>;

type NormalizedItem = Readonly<{
  sequence: number;
  completeness: CanonicalEInvoiceCompleteness;
  name: string | null;
  quantity: { coefficient: string; scale: number } | null;
  unitPrice: NormalizedMoney | null;
  amount: NormalizedMoney | null;
  sourceFactJson: string;
}>;

type NormalizedInvoice = Readonly<{
  stableInvoiceKey: string;
  sourceRevisionKey: string;
  revisionNumber: number;
  revisionKind: CanonicalEInvoiceRevisionKind;
  state: "active" | "revoked";
  invoiceNumber: string;
  randomNumber: string | null;
  sellerTaxId: string;
  sellerName: string | null;
  total: NormalizedMoney | null;
  occurrence: CanonicalEInvoiceOccurrence;
  items: readonly NormalizedItem[];
  authority: CanonicalEInvoiceInput["authority"];
  provenance: CanonicalEInvoiceProvenance;
  revocationReason: string | null;
  fingerprint: string;
}>;

function fail(
  reason: CanonicalEInvoiceAdmissionFailureReason,
  message: string,
): never {
  throw new CanonicalEInvoiceAdmissionError(reason, message);
}

function text(value: unknown, label: string): string {
  try {
    return requireCanonicalSourceText(value, label);
  } catch (error) {
    fail(
      "required-data",
      error instanceof Error ? error.message : `${label} is required.`,
    );
  }
}

function token(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!OPAQUE_TOKEN.test(normalized)) fail("invalid-contract", `${label} must be an opaque sha256 token.`);
  return normalized;
}

function exact(value: unknown, label: string): { coefficient: string; scale: number } {
  if (value === null || typeof value !== "object")
    fail("required-data", `${label} is required.`);
  const candidate = value as Partial<CanonicalEInvoiceExactDecimal>;
  const coefficient =
    typeof candidate.coefficient === "bigint"
      ? candidate.coefficient.toString(10)
      : typeof candidate.coefficient === "string"
        ? candidate.coefficient.trim()
        : "";
  if (!EXACT_COEFFICIENT.test(coefficient))
    fail("invalid-contract", `${label} coefficient must be an exact signed integer.`);
  const scale = candidate.scale;
  if (typeof scale !== "number" || !Number.isSafeInteger(scale) || scale < 0 || scale > MAX_CANONICAL_SCALE)
    fail("invalid-contract", `${label} scale must be a safe non-negative integer.`);
  return {
    coefficient: coefficient === "-0" ? "0" : coefficient,
    scale,
  };
}

function money(value: unknown, label: string): NormalizedMoney {
  if (value === null || typeof value !== "object") fail("required-data", `${label} is required.`);
  const candidate = value as Partial<CanonicalEInvoiceMoney>;
  if (candidate.currency !== "TWD")
    fail("invalid-contract", `${label} must use TWD under the E-Invoice contract.`);
  if (candidate.currencyAuthority !== E_INVOICE_CURRENCY_AUTHORITY)
    fail("invalid-contract", `${label} must declare the TWD currency authority.`);
  return {
    ...exact(candidate, label),
    currency: "TWD",
    currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
  };
}

function validCalendarDate(value: string, label: string): string {
  const match = value.match(DATE_ONLY);
  if (!match) fail("invalid-contract", `${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (date.toISOString().slice(0, 10) !== value)
    fail("invalid-contract", `${label} must be a calendar date.`);
  return value;
}

function occurrence(value: unknown): CanonicalEInvoiceOccurrence {
  if (value === null || typeof value !== "object") fail("required-data", "Invoice occurrence is required.");
  const candidate = value as Partial<CanonicalEInvoiceOccurrence>;
  const precision = candidate.precision;
  if (precision !== "date" && precision !== "minute" && precision !== "second")
    fail("invalid-contract", "Invoice occurrence precision is unsupported.");
  const occurrenceValue = text(candidate.value, "Invoice occurrence value");
  const match = occurrenceValue.match(
    precision === "date" ? DATE_ONLY : precision === "minute" ? MINUTE : SECOND,
  );
  if (!match) fail("invalid-contract", "Invoice occurrence value does not match its precision.");
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  validCalendarDate(date, "Invoice occurrence date");
  const hour = precision === "date" ? 0 : Number(match[4]);
  const minute = precision === "date" ? 0 : Number(match[5]);
  const second = precision === "second" ? Number(match[6]) : 0;
  if (hour > 23 || minute > 59 || second > 59)
    fail("invalid-contract", "Invoice occurrence time is invalid.");
  const timeZone = text(candidate.timeZone, "Invoice occurrence time zone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch (error) {
    fail("invalid-contract", `Invoice occurrence time zone is invalid: ${timeZone}.`);
  }
  if (candidate.origin !== "source-reported" && candidate.origin !== "provider-reported-date-fallback")
    fail("invalid-contract", "Invoice occurrence origin is unsupported.");
  if (candidate.origin === "provider-reported-date-fallback" && precision !== "date")
    fail("invalid-contract", "Provider date fallback must retain date precision.");
  return {
    value: occurrenceValue,
    precision,
    timeZone,
    origin: candidate.origin,
  };
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

function item(value: unknown, index: number): NormalizedItem {
  if (value === null || typeof value !== "object") fail("required-data", `Invoice item ${index} is required.`);
  const candidate = value as CanonicalEInvoiceItemInput;
  if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1)
    fail("invalid-contract", `Invoice item ${index} sequence is invalid.`);
  if (candidate.completeness !== "complete" && candidate.completeness !== "incomplete")
    fail("invalid-contract", `Invoice item ${index} completeness is unsupported.`);
  const name = candidate.name == null ? null : text(candidate.name, `Invoice item ${index} name`);
  const quantity = candidate.quantity == null ? null : exact(candidate.quantity, `Invoice item ${index} quantity`);
  if (quantity && quantity.coefficient.startsWith("-"))
    fail("invalid-contract", `Invoice item ${index} quantity cannot be negative.`);
  const unitPrice = candidate.unitPrice == null ? null : money(candidate.unitPrice, `Invoice item ${index} unit price`);
  const amount = candidate.amount == null ? null : money(candidate.amount, `Invoice item ${index} amount`);
  if (candidate.completeness === "complete" && (!name || !quantity || !unitPrice || !amount))
    fail("required-data", `Complete invoice item ${index} is missing a required fact.`);
  if (candidate.completeness === "incomplete" && !name && !quantity && !unitPrice && !amount)
    fail("required-data", `Incomplete invoice item ${index} must retain at least one source fact.`);
  const sourceFacts = candidate.sourceFacts ?? {};
  if (sourceFacts === null || typeof sourceFacts !== "object" || Array.isArray(sourceFacts))
    fail("invalid-contract", `Invoice item ${index} source facts must be a compact object.`);
  compactValue(sourceFacts, `invoice[${index}].sourceFacts`);
  const sourceFactJson = stableCanonicalSourceJson({
    ...sourceFacts,
    completeness: candidate.completeness,
    ...(name === null ? {} : { name }),
    ...(quantity === null ? {} : { quantity }),
    ...(unitPrice === null ? {} : { unitPrice }),
    ...(amount === null ? {} : { amount }),
  });
  return {
    sequence: candidate.sequence,
    completeness: candidate.completeness,
    name,
    quantity,
    unitPrice,
    amount,
    sourceFactJson,
  };
}

function normalizeInvoice(value: CanonicalEInvoiceInput, index: number, scope: CanonicalEInvoiceCaptureInput["scope"]): NormalizedInvoice {
  if (value === null || typeof value !== "object") fail("required-data", `Invoice ${index} is required.`);
  const stableInvoiceKey = text(value.stableInvoiceKey, `Invoice ${index} stable identity`);
  const sourceRevisionKey = text(value.sourceRevisionKey, `Invoice ${index} revision identity`);
  if (!Number.isSafeInteger(value.revisionNumber) || value.revisionNumber < 1)
    fail("invalid-contract", `Invoice ${index} revision number is invalid.`);
  if (value.revisionKind !== "issued" && value.revisionKind !== "revised" && value.revisionKind !== "revoked")
    fail("invalid-contract", `Invoice ${index} revision kind is unsupported.`);
  const invoiceNumber = text(value.sourceIdentifiers?.invoiceNumber, `Invoice ${index} invoice number`);
  const randomNumber = value.sourceIdentifiers?.randomNumber == null ? null : text(value.sourceIdentifiers.randomNumber, `Invoice ${index} random number`);
  const sellerTaxId = text(value.seller?.taxId, `Invoice ${index} seller tax ID`);
  const sellerName = value.seller?.name == null ? null : text(value.seller.name, `Invoice ${index} seller name`);
  if (value.authority?.routeKey !== E_INVOICE_ROUTE || value.authority?.contractVersion !== E_INVOICE_CONTRACT_VERSION)
    fail("invalid-contract", `Invoice ${index} authority contract is unsupported.`);
  const provenance = value.provenance;
  if (provenance === null || typeof provenance !== "object") fail("required-data", `Invoice ${index} provenance is required.`);
  if (provenance.kind !== "provider-record" && provenance.kind !== "provider-revocation" && provenance.kind !== "fixture")
    fail("invalid-contract", `Invoice ${index} provenance kind is unsupported.`);
  const provenanceReference = text(provenance.reference, `Invoice ${index} provenance reference`);
  const normalizedProvenance: CanonicalEInvoiceProvenance = {
    kind: provenance.kind,
    reference: provenanceReference,
    sourceField: provenance.sourceField == null ? null : text(provenance.sourceField, `Invoice ${index} provenance source field`),
  };
  const normalizedOccurrence = occurrence(value.occurrence);
  const occurrenceDate = normalizedOccurrence.value.slice(0, 10);
  if (occurrenceDate < scope.startDate || occurrenceDate > scope.endDate)
    fail("invalid-contract", `Invoice ${index} occurrence is outside the capture scope.`);
  const total = value.total == null ? null : money(value.total, `Invoice ${index} total`);
  const revocationReason = value.revocationReason == null ? null : text(value.revocationReason, `Invoice ${index} revocation reason`);
  if (value.revisionKind === "revoked") {
    if (!revocationReason) fail("required-data", `Revoked invoice ${index} requires a source revocation reason.`);
    if (total !== null) fail("invalid-contract", `Revoked invoice ${index} must not fabricate a replacement total.`);
    if (normalizedProvenance.kind !== "provider-revocation")
      fail("invalid-contract", `Revoked invoice ${index} requires provider-revocation provenance.`);
  } else if (total === null) {
    fail("required-data", `Issued or revised invoice ${index} requires a total.`);
  }
  const items = (value.items ?? []).map((entry, itemIndex) => item(entry, itemIndex));
  const sequences = new Set<number>();
  for (const entry of items) {
    if (sequences.has(entry.sequence)) fail("invalid-contract", `Invoice ${index} contains duplicate item sequence ${entry.sequence}.`);
    sequences.add(entry.sequence);
  }
  if (scope.itemCompleteness === "complete" && items.some((entry) => entry.completeness !== "complete"))
    fail("invalid-contract", `Invoice ${index} has incomplete items in a complete item scope.`);
  const canonical: Record<string, unknown> = {
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
    authority: value.authority,
    provenance: normalizedProvenance,
    revocationReason,
    fingerprint,
  };
}

function normalizeCapture(input: CanonicalEInvoiceCaptureInput): readonly [CanonicalEInvoiceCaptureInput, readonly NormalizedInvoice[]] {
  if (input === null || typeof input !== "object") fail("required-data", "E-Invoice capture is required.");
  text(input.captureId, "E-Invoice capture ID");
  token(input.sourceConnectionKey, "E-Invoice source connection key");
  token(input.identityEpoch, "E-Invoice identity epoch");
  token(input.subjectDigest, "E-Invoice subject digest");
  if (!RFC3339.test(input.observedAt) || !Number.isFinite(Date.parse(input.observedAt)))
    fail("invalid-contract", "E-Invoice observedAt must be RFC3339.");
  validCalendarDate(input.scope.startDate, "E-Invoice scope start");
  validCalendarDate(input.scope.endDate, "E-Invoice scope end");
  if (input.scope.startDate > input.scope.endDate) fail("invalid-contract", "E-Invoice scope dates are inverted.");
  if (input.scope.kind !== "bounded-range" && input.scope.kind !== "point-in-time")
    fail("invalid-contract", "E-Invoice scope kind is unsupported.");
  if (input.scope.completeness !== "complete-range" && input.scope.completeness !== "single-page")
    fail("invalid-contract", "E-Invoice scope completeness is unsupported.");
  if (input.scope.invoiceCompleteness !== "complete" && input.scope.invoiceCompleteness !== "incomplete")
    fail("invalid-contract", "E-Invoice invoice completeness is unsupported.");
  if (input.scope.itemCompleteness !== "complete" && input.scope.itemCompleteness !== "incomplete")
    fail("invalid-contract", "E-Invoice item completeness is unsupported.");
  if (!Array.isArray(input.pages) || input.pages.length === 0)
    fail("required-data", "E-Invoice capture requires at least one page.");
  input.pages.forEach((page, index) => {
    if (page.pageOrdinal !== index || (page.responseCode !== "200" && page.responseCode !== "204") || !Number.isSafeInteger(page.rowCount) || page.rowCount < 0)
      fail("invalid-contract", "E-Invoice page sequence/status/row count is invalid.");
    if (page.responseCode === "204" && page.rowCount !== 0)
      fail("invalid-contract", "E-Invoice HTTP 204 page must not claim invoice rows.");
    if (page.terminal !== (index === input.pages.length - 1))
      fail("invalid-contract", "E-Invoice page terminal marker is inconsistent.");
    compactValue(page.metadata, `page[${index}].metadata`);
  });
  const invoices = Array.isArray(input.invoices) ? input.invoices.map((entry, index) => normalizeInvoice(entry, index, input.scope)) : fail("required-data", "E-Invoice invoices must be an array.");
  const rowCount = input.pages.reduce((sum, page) => sum + page.rowCount, 0);
  if (rowCount !== invoices.length) fail("invalid-contract", "E-Invoice page row counts do not match invoices.");
  if (invoices.length === 0 && (input.scope.invoiceCompleteness !== "complete" || input.scope.itemCompleteness !== "complete"))
    fail("invalid-contract", "An empty E-Invoice scope is valid only when both invoice and item completeness are complete.");
  if (invoices.length > 0 && input.scope.invoiceCompleteness !== "complete")
    fail("invalid-contract", "E-Invoice capture must explicitly complete invoice headers before admission.");
  return [input, invoices];
}

function normalizedInvoiceCompact(invoice: NormalizedInvoice): Record<string, unknown> {
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
    authority: invoice.authority,
    provenance: invoice.provenance,
    revocationReason: invoice.revocationReason,
  };
}

function sourceToken(...parts: string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(parts.join("\u0000")).digest("base64url")}`;
}

/** Build the provider-neutral source envelope used by Source Capture Admission. */
export function buildCanonicalEInvoiceSourceEvidence(
  input: CanonicalEInvoiceCaptureInput,
): CanonicalSourceEvidence {
  const [, invoices] = normalizeCapture(input);
  const pages: CanonicalSourcePage[] = input.pages.map((page) => ({
    pageOrdinal: page.pageOrdinal,
    responseCode: page.responseCode,
    rowCount: page.rowCount,
    terminal: page.terminal,
    metadata: page.metadata,
  }));
  return {
    captureId: input.captureId,
    integrationNamespace: E_INVOICE_INTEGRATION_NAMESPACE,
    sourceConnectionKey: input.sourceConnectionKey,
    identityEpoch: input.identityEpoch,
    stream: E_INVOICE_STREAM,
    recordKind: E_INVOICE_RECORD_KIND,
    routeKey: E_INVOICE_ROUTE,
    contractVersion: E_INVOICE_CONTRACT_VERSION,
    subjectDigest: input.subjectDigest,
    observedAt: input.observedAt,
    scope: {
      startDate: input.scope.startDate,
      endDate: input.scope.endDate,
      dateFormat: "YYYY-MM-DD",
      kind: input.scope.kind,
      completeness: input.scope.completeness,
      ruleVersion: E_INVOICE_COMPLETENESS_RULE_VERSION,
      completenessBasis: "einvoice/canonical-v1/declared-scope",
      absenceAuthority: input.scope.absenceAuthority,
    },
    pages,
    records: invoices.map((invoice) => {
      const compact = normalizedInvoiceCompact(invoice);
      return {
        occurrenceKey: sourceToken(
          "einvoice-occurrence",
          input.sourceConnectionKey,
          input.identityEpoch,
          input.subjectDigest,
          invoice.stableInvoiceKey,
          invoice.sourceRevisionKey,
        ),
        providerKey: sourceToken("einvoice-provider", invoice.provenance.reference),
        contentHash: `sha256:${createHash("sha256").update(stableCanonicalSourceJson(compact)).digest("base64url")}`,
        sequenceLexeme: invoice.sourceRevisionKey,
        description: invoice.sellerName,
        compact,
      };
    }),
  };
}

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
  items: readonly NormalizedItem[],
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
  invoice: NormalizedInvoice,
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
      fail("revision-conflict", `E-Invoice revision ${invoice.sourceRevisionKey} changed after admission.`);
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
    fail("revision-conflict", `E-Invoice revision number ${invoice.revisionNumber} already belongs to another source revision.`);
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
    fail("revision-conflict", `E-Invoice revision ${invoice.revisionNumber} is older than the admitted revision history.`);
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
export async function commitCanonicalEInvoiceCapture(
  store: CanonicalSourceStore,
  input: CanonicalEInvoiceCaptureInput,
): Promise<CanonicalEInvoiceCommitResult> {
  assertValidatedCanonicalSourceStore(store);
  const [, invoices] = normalizeCapture(input);
  const evidence = buildCanonicalEInvoiceSourceEvidence(input);
  return withCanonicalSourceCaptureAdmissionTransaction(store, (capability) => {
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
  });
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

export type CanonicalEInvoiceLineageRequest = Readonly<{
  sourceConnectionKey: string;
  identityEpoch: string;
  subjectDigest: string;
  stableInvoiceKey: string;
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

export function queryCanonicalEInvoiceLineage(
  store: CanonicalSourceStore,
  request: CanonicalEInvoiceLineageRequest,
): CanonicalEInvoiceLineageQuery {
  validateQueryStore(store);
  const identity: CanonicalEInvoiceLineageRequest = {
    sourceConnectionKey: token(request.sourceConnectionKey, "E-Invoice lineage source connection key"),
    identityEpoch: token(request.identityEpoch, "E-Invoice lineage identity epoch"),
    subjectDigest: token(request.subjectDigest, "E-Invoice lineage subject digest"),
    stableInvoiceKey: text(request.stableInvoiceKey, "E-Invoice lineage stable identity"),
  };
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
