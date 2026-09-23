import { createHash } from "node:crypto";
import {
  requireCanonicalSourceText,
  stableCanonicalSourceJson,
  type CanonicalSourceEvidence,
  type CanonicalSourcePage,
} from "./canonical-source-evidence.ts";

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

export type CanonicalEInvoiceLineageRequest = Readonly<{
  sourceConnectionKey: string;
  identityEpoch: string;
  subjectDigest: string;
  stableInvoiceKey: string;
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

export type CanonicalNormalizedEInvoiceMoney = Readonly<{
  coefficient: string;
  scale: number;
  currency: "TWD";
  currencyAuthority: typeof E_INVOICE_CURRENCY_AUTHORITY;
}>;

export type CanonicalNormalizedEInvoiceItem = Readonly<{
  sequence: number;
  completeness: CanonicalEInvoiceCompleteness;
  name: string | null;
  quantity: { coefficient: string; scale: number } | null;
  unitPrice: CanonicalNormalizedEInvoiceMoney | null;
  amount: CanonicalNormalizedEInvoiceMoney | null;
  sourceFactJson: string;
}>;

export type CanonicalNormalizedEInvoice = Readonly<{
  stableInvoiceKey: string;
  sourceRevisionKey: string;
  revisionNumber: number;
  revisionKind: CanonicalEInvoiceRevisionKind;
  state: "active" | "revoked";
  invoiceNumber: string;
  randomNumber: string | null;
  sellerTaxId: string;
  sellerName: string | null;
  total: CanonicalNormalizedEInvoiceMoney | null;
  occurrence: CanonicalEInvoiceOccurrence;
  items: readonly CanonicalNormalizedEInvoiceItem[];
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

function money(value: unknown, label: string): CanonicalNormalizedEInvoiceMoney {
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

function item(value: unknown, index: number): CanonicalNormalizedEInvoiceItem {
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

function normalizeInvoice(value: CanonicalEInvoiceInput, index: number, scope: CanonicalEInvoiceCaptureInput["scope"]): CanonicalNormalizedEInvoice {
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

function normalizeCapture(input: CanonicalEInvoiceCaptureInput): readonly [CanonicalEInvoiceCaptureInput, readonly CanonicalNormalizedEInvoice[]] {
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

export function normalizeCanonicalEInvoiceCapture(
  input: CanonicalEInvoiceCaptureInput,
): readonly [CanonicalEInvoiceCaptureInput, readonly CanonicalNormalizedEInvoice[]] {
  return normalizeCapture(input);
}

export function normalizeCanonicalEInvoiceLineageRequest(
  request: CanonicalEInvoiceLineageRequest,
): CanonicalEInvoiceLineageRequest {
  return {
    sourceConnectionKey: token(
      request.sourceConnectionKey,
      "E-Invoice lineage source connection key",
    ),
    identityEpoch: token(request.identityEpoch, "E-Invoice lineage identity epoch"),
    subjectDigest: token(request.subjectDigest, "E-Invoice lineage subject digest"),
    stableInvoiceKey: text(request.stableInvoiceKey, "E-Invoice lineage stable identity"),
  };
}

function normalizedInvoiceCompact(invoice: CanonicalNormalizedEInvoice): Record<string, unknown> {
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
