import { randomUUID, createHash, randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { z } from "zod";
import type {
  WorkflowContext,
  WorkflowFinancialCommitPort,
} from "../lib/automation/workflow-executor.ts";
import {
  E_INVOICE_CONTRACT_VERSION,
  E_INVOICE_CURRENCY_AUTHORITY,
  E_INVOICE_ROUTE,
  type CanonicalEInvoiceCaptureInput,
  type CanonicalEInvoiceInput,
  type CanonicalEInvoiceItemInput,
  type CanonicalEInvoiceOccurrence,
} from "../ledger/canonical/einvoice-contract.ts";
import { stableCanonicalSourceJson } from "../ledger/canonical/canonical-source-evidence.ts";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import {
  PGLITE_CANONICAL_EINVOICE_COMMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import type { PGliteCanonicalEInvoiceCommitResult } from "../ledger/pglite/einvoice.ts";
import { ProviderProtocolOutdatedError } from "../lib/automation/source-access.ts";
import {
  liveEinvoiceAppSource,
  type AppInvoiceHeader,
  type AppInvoiceItem,
  type EinvoiceAppClient,
  type EinvoiceAppSource,
} from "./einvoice-app-transport.ts";
import type { EInvoiceAppSession } from "./einvoice-app-protocol.ts";

export type EinvoiceCredentials = {
  einvoice_phone_number?: string;
  einvoice_password?: string;
};

type YearMonth = {
  year: number;
  month: number;
};

export type InvoiceCaptureRecord = Readonly<{
  month: YearMonth;
  listPageIndex: number;
  header: AppInvoiceHeader;
  items: readonly AppInvoiceItem[];
}>;

const workflowInputSchema = z.object({
  credentials: z.object({
    einvoice_phone_number: z.string().trim().min(1),
    einvoice_password: z.string().trim().min(1),
  }),
});

const outputSchema = z.object({
  usedExistingSession: z.boolean(),
  invoiceCount: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  months: z.array(z.string()),
  captureId: z.string(),
  knowledgeAt: z.number().int().nonnegative(),
  commit: z.object({
    status: z.literal("committed"),
    captureId: z.string(),
    knowledgeAt: z.number().int().nonnegative(),
    sourceRecordIds: z.array(z.string()),
    invoiceCount: z.number().int().nonnegative(),
    insertedInvoiceCount: z.number().int().nonnegative(),
    insertedRevisionCount: z.number().int().nonnegative(),
    observedDuplicateCount: z.number().int().nonnegative(),
    itemCount: z.number().int().nonnegative(),
  }),
});

function requireCredential(
  credentials: EinvoiceCredentials,
  name: keyof EinvoiceCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(`Missing E-Invoice credential ${name}.`);
  }
  return value;
}

function cleanText(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function monthLabel(month: YearMonth): string {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

function addMonths(month: YearMonth, delta: number): YearMonth {
  const date = new Date(month.year, month.month - 1 + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

function compareYearMonth(left: YearMonth, right: YearMonth): number {
  return left.year === right.year
    ? left.month - right.month
    : left.year - right.year;
}

function availableInvoiceMonths(today = new Date()): YearMonth[] {
  const current = { year: today.getFullYear(), month: today.getMonth() + 1 };
  const start = addMonths(current, current.month % 2 === 0 ? -7 : -8);
  const months: YearMonth[] = [];
  for (
    let month = start;
    compareYearMonth(month, current) <= 0;
    month = addMonths(month, 1)
  ) {
    months.push(month);
  }
  return months;
}

function monthEndDay(month: YearMonth, today = new Date()): number {
  if (
    month.year === today.getFullYear() &&
    month.month === today.getMonth() + 1
  ) {
    return today.getDate();
  }
  return new Date(month.year, month.month, 0).getDate();
}

// Only App statuses actually observed are admitted.
const APP_INVOICE_STATUS_KINDS: Readonly<Record<string, "issued" | "revoked">> = {
  "開立已確認": "issued",
};

function appInvoiceStatus(header: AppInvoiceHeader): Readonly<{ value: string; kind: "issued" | "revoked" }> {
  const value = cleanText(header.invStatus);
  const kind = APP_INVOICE_STATUS_KINDS[value];
  // An unmapped status (the App's void string is not yet observed) cannot be
  // guessed, and the contract forbids admitting the range without it.
  if (!kind) throw new ProviderProtocolOutdatedError();
  return { value, kind };
}

function opaqueDigest(domain: string, ...parts: readonly string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update([domain, ...parts].join("\u0000"), "utf8")
    .digest("base64url")}`;
}

function exactDecimal(
  value: string | number | null | undefined,
  label: string,
): { coefficient: string; scale: number } | null {
  const normalized = cleanText(value);
  if (!normalized) return null;
  const match = normalized.match(
    /^([+-]?)(?:(\d{1,3}(?:,\d{3})+)|(\d+))(?:\.(\d+))?$/u,
  );
  if (!match) throw new Error(`E-Invoice ${label} is not an exact decimal.`);
  const integer = (match[2] ?? match[3])!.replaceAll(",", "").replace(/^0+(?=\d)/u, "");
  const fraction = match[4] ?? "";
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/u, "");
  const coefficient = digits === "0" ? "0" : `${match[1] === "+" ? "" : match[1]}${digits}`;
  return { coefficient, scale: fraction.length };
}

function money(
  value: string | number | null | undefined,
  label: string,
): NonNullable<CanonicalEInvoiceInput["total"]> | null {
  const exact = exactDecimal(value, label);
  return exact
    ? {
      ...exact,
      currency: "TWD",
      currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
    }
    : null;
}

function positiveInteger(value: string | number | null | undefined): number | null {
  const normalized = cleanText(value);
  if (!normalized) return null;
  if (!/^\d+$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function canonicalDateParts(
  value: string,
): { date: string; time: string | null; precision: "date" | "minute" | "second" } | null {
  const normalized = value.trim().replaceAll("/", "-").replace(/\s+/gu, "T");
  const match = normalized.match(
    /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2})(?::?(\d{2}))?)?/u,
  );
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const calendar = new Date(`${date}T00:00:00Z`);
  if (calendar.toISOString().slice(0, 10) !== date) return null;
  if (match[4] === undefined) return { date, time: null, precision: "date" };
  const time = `${match[4]}:${match[5]}` + (match[6] === undefined ? "" : `:${match[6]}`);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return {
    date,
    time,
    precision: match[6] === undefined ? "minute" : "second",
  };
}

export function canonicalOccurrence(
  header: AppInvoiceHeader,
): CanonicalEInvoiceOccurrence {
  const dateValue = appInvoiceDateIso(header) ?? "";
  const timeValue = cleanText(header.invoiceTime);
  const sourceParts = canonicalDateParts(`${dateValue}${timeValue ? `T${timeValue}` : ""}`);
  if (sourceParts) {
    return {
      value: sourceParts.time ? `${sourceParts.date}T${sourceParts.time}` : sourceParts.date,
      precision: sourceParts.precision,
      timeZone: "Asia/Taipei",
      origin: "source-reported",
    };
  }
  throw new Error("E-Invoice source did not provide a valid purchase date.");
}

function unlessMalformed<T>(parse: () => T | null): T | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

function canonicalItem(
  source: AppInvoiceItem,
  index: number,
  sequence: number,
  sequenceFallback: boolean,
): CanonicalEInvoiceItemInput {
  const name = cleanText(source.description) || null;
  // A line number the provider did not send as a decimal is a missing fact:
  // the item becomes incomplete instead of failing the whole capture.
  const quantity = unlessMalformed(() => exactDecimal(source.quantity, `item ${index + 1} quantity`));
  const unitPrice = unlessMalformed(() => money(source.unitPrice, `item ${index + 1} unit price`));
  const amount = unlessMalformed(() => money(source.amount, `item ${index + 1} amount`));
  if (!name && !quantity && !unitPrice && !amount)
    throw new Error(`E-Invoice item ${index + 1} has no source facts.`);
  const completeness = name && quantity && unitPrice && amount ? "complete" : "incomplete";
  const providerRowNum = cleanText(source.rowNum) || null;
  return {
    sequence,
    completeness,
    name,
    quantity,
    unitPrice,
    amount,
    sourceFacts: {
      providerItemOrdinal: index + 1,
      ...(providerRowNum === null ? {} : { providerRowNum }),
      ...(sequenceFallback ? { providerRowNumFallback: true } : {}),
    },
  };
}

function canonicalItemSequences(
  items: readonly AppInvoiceItem[],
): { sequences: readonly number[]; usesProviderSequences: boolean } {
  const providerSequences = items.map((item) => positiveInteger(item.rowNum));
  const allPositiveSafeIntegers = providerSequences.every(
    (sequence): sequence is number => sequence !== null,
  );
  const unique = allPositiveSafeIntegers && new Set(providerSequences).size === providerSequences.length;
  return {
    sequences: unique
      ? providerSequences
      : items.map((_item, index) => index + 1),
    usesProviderSequences: unique,
  };
}

export function mapCanonicalEInvoiceRecord(
  record: InvoiceCaptureRecord,
): CanonicalEInvoiceInput {
  const header = record.header;
  const status = appInvoiceStatus(header);
  const revisionKind = status.kind;
  // The App exposes a lifecycle status but no revision sequence, so issued is
  // revision 1 and a revocation, its one successor state, is revision 2.
  const revisionNumber = revisionKind === "revoked" ? 2 : 1;
  const invoiceNumber = cleanText(header.invNum);
  const sellerTaxId = cleanText(header.sellerBan);
  const period = cleanText(header.invPeriod);
  if (!invoiceNumber) throw new Error("E-Invoice invoice number is required.");
  if (!sellerTaxId) throw new Error(`E-Invoice ${invoiceNumber} seller tax ID is required.`);
  // Invoice numbers are allocated per two-month period (e.g. 11504), so a
  // number identifies an invoice only together with its period.
  if (!period) throw new Error(`E-Invoice ${invoiceNumber} period is required.`);
  const stableInvoiceKey = `provider:${period}:${invoiceNumber}:${sellerTaxId}`;
  const sourceRevisionKey = `provider-revision:${opaqueDigest(
    "einvoice-revision",
    stableInvoiceKey,
    status.value,
    String(revisionNumber),
  )}`;
  const itemSequencePlan = canonicalItemSequences(record.items);
  const items = revisionKind === "revoked"
    ? []
    : record.items.map((item, index) => canonicalItem(
      item,
      index,
      itemSequencePlan.sequences[index]!,
      !itemSequencePlan.usesProviderSequences,
    ));
  const reference = `provider-record:${opaqueDigest(
    "einvoice-provider-record",
    stableInvoiceKey,
    sourceRevisionKey,
  )}`;
  return {
    stableInvoiceKey,
    sourceRevisionKey,
    revisionNumber,
    revisionKind,
    sourceIdentifiers: { invoiceNumber, randomNumber: null },
    seller: { taxId: sellerTaxId, name: cleanText(header.sellerName) || null },
    total: revisionKind === "revoked"
      ? null
      : money(header.amount, `invoice ${invoiceNumber} total`),
    occurrence: canonicalOccurrence(header),
    items,
    authority: { routeKey: E_INVOICE_ROUTE, contractVersion: E_INVOICE_CONTRACT_VERSION },
    provenance: {
      kind: revisionKind === "revoked" ? "provider-revocation" : "provider-record",
      reference,
      sourceField: "invStatus",
    },
    ...(revisionKind === "revoked"
      ? { revocationReason: `provider-status:${status.value}` }
      : {}),
  };
}

function parseMonthLabel(value: string): YearMonth {
  const match = value.match(/^(\d{4})-(\d{2})$/u);
  if (!match) throw new Error(`Invalid E-Invoice month label: ${value}`);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid E-Invoice month label: ${value}`);
  return { year: Number(match[1]), month };
}

export type EinvoiceWorkflowInput = z.infer<typeof workflowInputSchema>;
export type EinvoiceWorkflowOutput = z.infer<typeof outputSchema>;

function randomAppDeviceId(): string {
  return randomBytes(8).toString("hex");
}

function appInvoiceDateIso(header: AppInvoiceHeader): string | null {
  const d = header.invDate;
  if (!d) return null;
  const year = Number(d.year);
  const month = Number(d.month);
  const date = Number(d.date);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) return null;
  return `${year < 1911 ? year + 1911 : year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
}

function appInvoiceApiDate(header: AppInvoiceHeader): string {
  return (appInvoiceDateIso(header) ?? "").replaceAll("-", "/");
}

type AppInvoicePage = { month: YearMonth; pageIndex: number; rowCount: number };

// Paging ends only at an empty page and carries no total. A month that has not
// ended within this many pages means the server stopped honouring `page`.
const MAX_HEADER_PAGES_PER_MONTH = 100;

async function readAppProtocolInvoices(
  client: EinvoiceAppClient,
  session: EInvoiceAppSession,
  signal: AbortSignal,
  onMonthComplete: (completed: number, total: number) => Promise<void>,
): Promise<{
  records: InvoiceCaptureRecord[];
  pages: AppInvoicePage[];
  months: string[];
  invoiceCount: number;
}> {
  const records: InvoiceCaptureRecord[] = [];
  const pages: AppInvoicePage[] = [];
  let invoiceCount = 0;
  const months = availableInvoiceMonths();

  for (const [monthIndex, month] of months.entries()) {
    signal.throwIfAborted();
    const startDate = `${month.year}/${String(month.month).padStart(2, "0")}/01`;
    const endDate = `${month.year}/${String(month.month).padStart(2, "0")}/${String(monthEndDay(month)).padStart(2, "0")}`;
    let pageIndex = 0;
    for (;;) {
      signal.throwIfAborted();
      if (pageIndex >= MAX_HEADER_PAGES_PER_MONTH) throw new ProviderProtocolOutdatedError();
      const result = await client.queryHeaders(session, startDate, endDate, pageIndex + 1, signal);
      pages.push({ month, pageIndex, rowCount: result.details.length });
      for (const header of result.details) {
        signal.throwIfAborted();
        const detail = await client.queryDetail(
          session,
          header.invNum ?? "",
          appInvoiceApiDate(header),
          signal,
        );
        records.push({ month, listPageIndex: pageIndex, header, items: detail.details });
      }
      invoiceCount += result.details.length;
      if (result.details.length === 0) break;
      pageIndex += 1;
    }
    await onMonthComplete(monthIndex + 1, months.length);
  }

  return { records, pages, months: months.map(monthLabel), invoiceCount };
}

export function buildCanonicalEInvoiceCaptureFromApp(
  result: Readonly<{
    records: readonly InvoiceCaptureRecord[];
    pages: readonly AppInvoicePage[];
    months: readonly string[];
  }>,
  credentials: EinvoiceCredentials,
  options: Readonly<{ captureId?: string; observedAt?: string; today?: Date }> = {},
): CanonicalEInvoiceCaptureInput {
  if (result.months.length === 0) throw new Error("E-Invoice capture requires at least one month.");
  const firstMonth = parseMonthLabel(result.months[0]!);
  const lastMonth = parseMonthLabel(result.months.at(-1)!);
  const sourceConnectionKey = deriveSourceConnectionIdentityKey("einvoice", {
    phone: requireCredential(credentials, "einvoice_phone_number"),
  });
  const identityEpoch = opaqueDigest("einvoice-identity-epoch", sourceConnectionKey, "personal-invoices-v1");
  const subjectDigest = opaqueDigest("einvoice-subject", sourceConnectionKey, identityEpoch, "personal-invoices");
  const observedAt = options.observedAt ?? new Date().toISOString();
  const captureId = options.captureId ?? `einvoice-capture:${randomUUID()}`;
  const pageKey = (month: YearMonth, pageIndex: number): string => `${monthLabel(month)}:${pageIndex}`;
  const sourcePageKeys = new Set(result.pages.map((page) => pageKey(page.month, page.pageIndex)));
  const admittedRowCounts = new Map<string, number>();
  const revisions = new Map<string, string>();
  const invoices: CanonicalEInvoiceInput[] = [];
  for (const record of result.records) {
    const key = pageKey(record.month, record.listPageIndex);
    if (!sourcePageKeys.has(key)) throw new Error("E-Invoice record has no source list page.");
    const invoice = mapCanonicalEInvoiceRecord(record);
    const revisionKey = `${invoice.stableInvoiceKey}\u0000${invoice.sourceRevisionKey}`;
    const facts = stableCanonicalSourceJson({ invoice });
    const prior = revisions.get(revisionKey);
    if (prior !== undefined) {
      if (prior !== facts) throw new Error("E-Invoice same invoice revision has different facts in one capture.");
      continue;
    }
    revisions.set(revisionKey, facts);
    invoices.push(invoice);
    admittedRowCounts.set(key, (admittedRowCounts.get(key) ?? 0) + 1);
  }
  const pages = result.pages.map((page, pageOrdinal) => ({
    pageOrdinal,
    responseCode: "200" as "200" | "204",
    rowCount: admittedRowCounts.get(pageKey(page.month, page.pageIndex)) ?? 0,
    terminal: pageOrdinal === result.pages.length - 1,
    metadata: {
      provider: "einvoice.nat.gov.tw",
      month: monthLabel(page.month),
      pageIndex: page.pageIndex,
      providerRowCount: page.rowCount,
    },
  }));
  const itemCompleteness = invoices.every((invoice) =>
    invoice.items.every((item) => item.completeness === "complete"),
  ) ? "complete" : "incomplete";
  return {
    captureId,
    sourceConnectionKey,
    identityEpoch,
    subjectDigest,
    observedAt,
    scope: {
      startDate: `${monthLabel(firstMonth)}-01`,
      endDate: `${monthLabel(lastMonth)}-${String(monthEndDay(lastMonth, options.today)).padStart(2, "0")}`,
      kind: "bounded-range",
      completeness: "complete-range",
      invoiceCompleteness: "complete",
      itemCompleteness,
      absenceAuthority: "comparable-complete-range",
    },
    pages,
    invoices,
  };
}

/** App-owned entry point for collecting and admitting E-Invoice statements. */
export async function runEinvoiceProviderWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
  source: EinvoiceAppSource = liveEinvoiceAppSource,
): Promise<EinvoiceWorkflowOutput> {
  const parsed = workflowInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error("E-Invoice workflow credentials are missing or invalid.");
  const financialCommit = context.financialCommit;
  if (!financialCommit) throw new Error("Canonical Financial Commit port is unavailable.");
  context.signal.throwIfAborted();

  const credentials = parsed.data.credentials;
  return await context.browser.withPage(async (page) => {
    await context.event("authentication", "authentication-started");
    const { client, close } = await source.open(page);
    try {
      const session = await client.login(
        requireCredential(credentials, "einvoice_phone_number"),
        requireCredential(credentials, "einvoice_password"),
        randomAppDeviceId(),
        context.signal,
      );
      context.signal.throwIfAborted();
      await context.event("authentication", "authentication-completed");

      await context.event("collection", "collection-started");
      await context.event("decoding", "source-decoding-started");
      const result = await readAppProtocolInvoices(client, session, context.signal, async (completed, total) => {
        await context.event("collection", "month-completed", { completed, total });
      });
      const capture = buildCanonicalEInvoiceCaptureFromApp(result, credentials);
      const admittedInvoiceCount = capture.invoices.length;
      await context.event("decoding", "source-decoding-completed");
      await context.event("validation", "source-validation-completed", {
        completed: admittedInvoiceCount,
        total: admittedInvoiceCount,
      });
      context.signal.throwIfAborted();

      await context.event("commit", "canonical-commit-started", {
        completed: 0,
        total: admittedInvoiceCount,
      });
      let commit: PGliteCanonicalEInvoiceCommitResult;
      try {
        commit = await commitCanonicalCapture(capture, financialCommit, context.signal);
      } catch (error) {
        if (error instanceof EInvoiceCommitRejectedError) {
          await context.event("commit", "canonical-commit-failed");
        }
        throw error;
      }
      await context.event("commit", "canonical-commit-completed", {
        completed: commit.invoiceCount,
        total: admittedInvoiceCount,
      });

      return outputSchema.parse({
        usedExistingSession: false,
        invoiceCount: admittedInvoiceCount,
        itemCount: commit.itemCount,
        months: result.months,
        captureId: commit.captureId,
        knowledgeAt: commit.knowledgeAt,
        commit: { ...commit, sourceRecordIds: [...commit.sourceRecordIds] },
      });
    } finally {
      await close();
    }
  });
}

export class EInvoiceCommitRejectedError extends Error {}

export async function commitCanonicalCapture(
  capture: CanonicalEInvoiceCaptureInput,
  financialCommit: WorkflowFinancialCommitPort,
  signal?: AbortSignal,
) {
  if (!financialCommit) throw new Error("Canonical Financial Commit port is unavailable.");
  const result = await financialCommit.execute([{
    provider: "einvoice",
    product: "personal-invoice",
    itemKey: capture.captureId,
    command: {
      kind: PGLITE_CANONICAL_EINVOICE_COMMIT_COMMAND,
      request: capture,
    },
  }], {
    provider: "einvoice",
    product: "personal-invoice",
    ...(signal === undefined ? {} : { signal }),
  });
  const committed = result.items[0];
  if (committed?.status !== "committed") {
    const message = `E-Invoice PGlite persistence ${result.status}: ${result.diagnostics
      .map((diagnostic) => `${diagnostic.stage}/${diagnostic.errorCode}`)
      .join(", ")}`;
    if (committed?.status === "failed" && committed.failureKind === "item") {
      throw new EInvoiceCommitRejectedError(message);
    }
    throw new Error(message);
  }
  return committed.value as PGliteCanonicalEInvoiceCommitResult;
}
