import { randomUUID, createHash } from "node:crypto";
import { CaptchaProviderRejectedError } from "../lib/automation/captcha-rejection.ts";
import { errors, type Page, type Request } from "playwright";
import { z } from "zod";
import type {
  WorkflowContext,
  WorkflowFinancialCommitPort,
} from "../lib/automation/workflow-executor.ts";
import { strictSourceText, type SourceTextPort } from "../lib/automation/source-text.ts";
import { SourceAccessChallengeError } from "../lib/automation/source-access.ts";
import {
  emitHumanAssistanceStage,
  type WorkflowHumanAssistanceStage,
} from "./human-assistance.ts";
import type {
  HumanAssistanceCompletionStatus,
  HumanAssistanceContractInput,
} from "../lib/automation/human-assistance.ts";
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

const LOGIN_URL = "https://www.einvoice.nat.gov.tw/accounts/login";
const SEARCH_URL =
  "https://www.einvoice.nat.gov.tw/portal/btc/mobile/btc502w/search";
const LIST_ENDPOINT = "/btc/cloud/api/btc502w/searchCarrierInvoice";
const HEADER_ENDPOINT = "/btc/cloud/api/common/getCarrierInvoiceData";
const ITEMS_ENDPOINT = "/btc/cloud/api/common/getCarrierInvoiceDetail";

export type EinvoiceCredentials = {
  einvoice_phone_number?: string;
  einvoice_password?: string;
};

type YearMonth = {
  year: number;
  month: number;
};

type InvoiceListEntry = {
  token: string;
  invoiceNumber: string;
  carrierName?: string | null;
  totalAmount?: number | string | null;
  extStatus?: string | null;
  invoiceStrStatus?: string | null;
  buyerId?: string | null;
};

type InvoiceListResponse = {
  httpStatus: 200 | 204;
  totalElements: number;
  totalPages: number;
  size: number;
  content: InvoiceListEntry[];
};

type InvoiceHeader = {
  invoiceDate?: string | null;
  invoiceTime?: string | null;
  invoiceInstantDate?: string | null;
  totalAmount?: string | number | null;
  extStatus?: string | null;
  invoiceStrStatus?: string | null;
  alwFlag?: string | null;
  sellerId?: string | null;
  sellerName?: string | null;
  sellerAddress?: string | null;
  buyerId?: string | null;
};

type InvoiceItem = {
  sequenceNumber?: string | null;
  item?: string | null;
  quantity?: string | number | null;
  unitPrice?: string | null;
  amount?: string | null;
};

type InvoiceDetailResponse = {
  totalElements: number;
  totalPages: number;
  size: number;
  content: InvoiceItem[];
};

const optionalText = z.string().nullable().optional();
const optionalAmount = z.union([z.string(), z.number()]).nullable().optional();
const invoiceListEntrySchema = z.object({
  token: z.string().trim().min(1),
  invoiceNumber: z.string().trim().min(1),
  carrierName: optionalText,
  totalAmount: optionalAmount,
  extStatus: optionalText,
  invoiceStrStatus: optionalText,
  buyerId: optionalText,
});
const invoiceListEnvelopeSchema = z.object({
  totalElements: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  content: z.array(invoiceListEntrySchema),
});
const invoiceHeaderSchema = z.object({
  invoiceDate: optionalText,
  invoiceTime: optionalText,
  invoiceInstantDate: optionalText,
  totalAmount: optionalAmount,
  extStatus: optionalText,
  invoiceStrStatus: optionalText,
  alwFlag: optionalText,
  sellerId: optionalText,
  sellerName: optionalText,
  sellerAddress: optionalText,
  buyerId: optionalText,
});
const invoiceDetailItemSchema = z.object({
  sequenceNumber: optionalText,
  item: optionalText,
  quantity: optionalAmount,
  unitPrice: optionalText,
  amount: optionalText,
});
const invoiceDetailEnvelopeSchema = z.object({
  totalElements: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  content: z.array(invoiceDetailItemSchema),
});

async function parseProviderJson<T>(
  response: Awaited<ReturnType<Page["waitForResponse"]>>,
  label: string,
  schema: z.ZodType<T>,
  text: SourceTextPort,
): Promise<T> {
  const source = text.decode(new Uint8Array(await response.body()), "utf-8");
  text.assertIntact(source);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} response is not valid JSON.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} response is malformed.`);
  return parsed.data;
}

export function validatePaginationEnvelope(
  label: string,
  value: Readonly<{
    totalElements: number;
    totalPages: number;
    size: number;
    content: readonly unknown[];
  }>,
): void {
  if (!Number.isSafeInteger(value.totalElements) || value.totalElements < 0)
    throw new Error(`${label} totalElements is invalid.`);
  if (!Number.isSafeInteger(value.totalPages) || value.totalPages < 0)
    throw new Error(`${label} totalPages is invalid.`);
  if (!Number.isSafeInteger(value.size) || value.size < 0)
    throw new Error(`${label} page size is invalid.`);
  if (value.totalElements === 0) {
    if (value.content.length !== 0)
      throw new Error(`${label} returned rows for an empty result.`);
    return;
  }
  if (value.totalPages < 1 || value.content.length === 0)
    throw new Error(`${label} pagination metadata is incomplete.`);
  if (value.size > 0 && value.content.length > value.size)
    throw new Error(`${label} returned more rows than its declared page size.`);
}

export type InvoiceCaptureRecord = Readonly<{
  month: YearMonth;
  listPageIndex: number;
  entry: InvoiceListEntry;
  header: InvoiceHeader;
  items: readonly InvoiceItem[];
  itemCompleteness: "complete" | "incomplete";
}>;

type InvoiceReadResult = {
  records: InvoiceCaptureRecord[];
  pages: Array<{ month: YearMonth; pageIndex: number; list: InvoiceListResponse }>;
  months: string[];
  invoiceCount: number;
};

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

function parsePickerMonth(text: string): YearMonth {
  const match = text.match(/(\d{1,2})月\s*(\d{4})年/);
  if (!match) throw new Error(`Could not parse date picker month: ${text}`);
  return { year: Number(match[2]), month: Number(match[1]) };
}

export function invoiceStatus(
  entry: InvoiceListEntry,
  header: InvoiceHeader,
): string {
  const labels: Record<string, string> = {
    "2": "confirmed",
    INVOICE0003S: "confirmed",
    "已確認": "confirmed",
    "4": "voided",
    "已作廢": "voided",
  };
  const candidates = [
    header.invoiceStrStatus,
    entry.invoiceStrStatus,
    header.extStatus,
    entry.extStatus,
  ]
    .map(cleanText)
    .filter(Boolean);

  for (const candidate of candidates) {
    if (labels[candidate]) return labels[candidate];
    if (!candidate.startsWith("INVOICE")) return candidate;
  }
  return candidates[0] ?? "";
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
  header: InvoiceHeader,
): CanonicalEInvoiceOccurrence {
  const sourceValue = cleanText(header.invoiceInstantDate);
  const dateValue = cleanText(header.invoiceDate);
  const timeValue = cleanText(header.invoiceTime);
  const sourceParts = sourceValue
    ? canonicalDateParts(sourceValue)
    : canonicalDateParts(`${dateValue}${timeValue ? `T${timeValue}` : ""}`);
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

function statusKind(status: string): "issued" | "revised" | "revoked" {
  const normalized = status.trim().toLocaleLowerCase("en-US");
  if (
    normalized === "voided" ||
    normalized === "revoked" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    status === "已作廢"
  ) return "revoked";
  if (normalized === "confirmed") return "issued";
  throw new Error(`E-Invoice source status ${status || "(missing)"} is not admitted by the current contract.`);
}

function canonicalItem(
  source: InvoiceItem,
  index: number,
  sequence: number = index + 1,
  sequenceFallback = false,
): { item: CanonicalEInvoiceItemInput; completeness: "complete" | "incomplete" } {
  const name = cleanText(source.item) || null;
  const quantity = exactDecimal(source.quantity, `item ${index + 1} quantity`);
  const unitPrice = money(source.unitPrice, `item ${index + 1} unit price`);
  const amount = money(source.amount, `item ${index + 1} amount`);
  if (!name && !quantity && !unitPrice && !amount)
    throw new Error(`E-Invoice item ${index + 1} has no source facts.`);
  const completeness = name && quantity && unitPrice && amount ? "complete" : "incomplete";
  const providerSequence = cleanText(source.sequenceNumber) || null;
  return {
    item: {
      sequence,
      completeness,
      name,
      quantity,
      unitPrice,
      amount,
      sourceFacts: {
        providerItemOrdinal: index + 1,
        ...(providerSequence === null ? {} : { providerSequenceRaw: providerSequence }),
        ...(sequenceFallback ? { providerSequenceFallback: true } : {}),
      },
    },
    completeness,
  };
}

function canonicalItemSequences(
  items: readonly InvoiceItem[],
): { sequences: readonly number[]; usesProviderSequences: boolean } {
  const providerSequences = items.map((item) => positiveInteger(item.sequenceNumber));
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
  const entry = record.entry;
  const header = record.header;
  const status = invoiceStatus(entry, header);
  const revisionKind = statusKind(status);
  // The three existing provider payloads expose a lifecycle status but no
  // revision sequence. Confirmed and voided are therefore the only admitted
  // lifecycle facts; voided is the one source-proven successor state.
  const revisionNumber = revisionKind === "revoked" ? 2 : 1;
  const invoiceNumber = cleanText(entry.invoiceNumber);
  const sellerTaxId = cleanText(header.sellerId);
  if (!invoiceNumber) throw new Error("E-Invoice invoice number is required.");
  if (!sellerTaxId) throw new Error(`E-Invoice ${invoiceNumber} seller tax ID is required.`);
  const randomNumber = null;
  const stableInvoiceKey = `provider:${invoiceNumber}:${sellerTaxId}`;
  const providerRowKey = cleanText(entry.token);
  if (!providerRowKey) throw new Error(`E-Invoice ${invoiceNumber} provider row key is required.`);
  const sourceRevisionKey = `provider-revision:${opaqueDigest(
    "einvoice-revision",
    stableInvoiceKey,
    status,
    String(revisionNumber),
  )}`;
  const occurrence = canonicalOccurrence(header);
  const itemSequencePlan = canonicalItemSequences(record.items);
  const items = revisionKind === "revoked"
    ? []
    : record.items.map((item, index) => canonicalItem(
      item,
      index,
      itemSequencePlan.sequences[index]!,
      !itemSequencePlan.usesProviderSequences,
    ).item);
  const itemCompleteness = items.length === 0
    ? "complete"
    : items.every((item) => item.completeness === "complete")
      ? "complete"
      : "incomplete";
  if (
    revisionKind !== "revoked" &&
    record.itemCompleteness === "incomplete" &&
    itemCompleteness === "complete"
  ) {
    throw new Error(`E-Invoice ${invoiceNumber} item completeness was overstated.`);
  }
  // The portal refreshes the list-row token between collections. Its presence
  // establishes that the provider returned a row, but its value cannot
  // identify immutable canonical occurrence or revision provenance.
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
    sourceIdentifiers: { invoiceNumber, randomNumber },
    seller: { taxId: sellerTaxId, name: cleanText(header.sellerName) || null },
    total: revisionKind === "revoked"
      ? null
      : money(header.totalAmount ?? entry.totalAmount, `invoice ${invoiceNumber} total`),
    occurrence,
    items,
    authority: { routeKey: E_INVOICE_ROUTE, contractVersion: E_INVOICE_CONTRACT_VERSION },
    provenance: {
      kind: revisionKind === "revoked" ? "provider-revocation" : "provider-record",
      reference,
      sourceField: header.invoiceStrStatus ? "invoiceStrStatus" : entry.invoiceStrStatus ? "invoiceStrStatus" : "extStatus",
    },
    ...(revisionKind === "revoked"
      ? { revocationReason: `provider-status:${status || "voided"}` }
      : {}),
  };
}

async function isSignedIn(page: Page): Promise<boolean> {
  if (page.url().includes("/portal/btc/mobile")) return true;
  return await page
    .getByText(/登出|會員專區|載具歸戶/i)
    .first()
    .isVisible({ timeout: 3_000 })
    .catch(() => false);
}

/** Retry a pre-submit action when navigation invalidates its execution context.
 * No login request or CAPTCHA answer has been submitted at this point. */
export async function retryEinvoiceLoginNavigation<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= 4 || !/Execution context was destroyed|Cannot find context with specified id/i.test(String(error))) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export type EinvoiceLoginOutcome =
  | "authenticated"
  | "captcha-rejected"
  | "credentials-rejected"
  | "form-rejected"
  | "unconfirmed";

function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Observe the response to one submission without submitting credentials or
 * CAPTCHA again. Site messages are used only for classification, never logged. */
export async function waitForEinvoiceLoginOutcome(
  page: Page,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<EinvoiceLoginOutcome> {
  const deadline = performance.now() + timeoutMs;
  const rejection = /錯誤|不正確|有誤|失敗|重新|無效|incorrect|invalid|failed/i;
  while (true) {
    signal?.throwIfAborted();
    if (await isSignedIn(page)) return "authenticated";
    for (const alert of await page.locator('[role="alert"], [role="dialog"], .alert, .invalid-feedback, .error-message, .el-message, .swal2-popup').all()) {
      if (!(await alert.isVisible())) continue;
      const message = (await alert.innerText()).trim();
      if (!rejection.test(message)) continue;
      if (/圖形驗證碼|captcha/i.test(message)) return "captcha-rejected";
      if (/手機號碼|密碼|password/i.test(message)) return "credentials-rejected";
      if (/登入|驗證碼|驗證/i.test(message)) return "form-rejected";
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return "unconfirmed";
    await waitWithAbort(page.waitForTimeout(Math.min(250, remaining)), signal);
  }
}

export function einvoiceCaptchaAssistanceStage(
  page: Page,
): WorkflowHumanAssistanceStage {
  return {
    stageId: "einvoice-login-captcha",
    title: "Enter the e-invoice CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "einvoice.login.captcha-input",
        modes: ["click", "type"],
        locator: page.locator("#captcha"),
      },
    ],
    contextRegions: [
      {
        id: "captcha-challenge",
        label: "CAPTCHA challenge and instructions",
        semanticId: "einvoice.login.captcha-challenge",
      },
    ],
    challengeKind: "text-captcha",
    charset: "digits",
    ocrPageSegmentationMode: "single-word",
    ocrAttemptPlan: [
      { imagePreprocessing: ["mask-bottom-interference-band"] },
      { imagePreprocessing: ["suppress-horizontal-interference"] },
    ],
    solveAcceptancePolicy: { mode: "agreement-only" },
    expectedAnswerLength: 5,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "einvoice.login.captcha-image",
      locator: page
        .locator(".input-group-text.code_num")
        .locator('img[alt="圖形驗證碼"]:visible')
        .first(),
    },
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: {
      targetId: "captcha-input",
      contextRegionIds: ["captcha-challenge"],
      initialZoom: 1.15,
    },
  };
}

type EinvoiceHumanAssistanceRequest = (
  stage: WorkflowHumanAssistanceStage,
  signal?: AbortSignal,
) => Promise<HumanAssistanceCompletionStatus>;

async function requestEinvoiceCaptchaAssistance(
  stage: WorkflowHumanAssistanceStage,
  request: (
    contract: HumanAssistanceContractInput,
    signal: AbortSignal,
  ) => Promise<HumanAssistanceCompletionStatus>,
  signal: AbortSignal,
): Promise<HumanAssistanceCompletionStatus> {
  signal.throwIfAborted();
  const contract = await emitHumanAssistanceStage(
    stage,
    (value) => value,
  );
  const status = await request(contract, signal);
  signal.throwIfAborted();
  if (status !== "entered" && status !== "verified") {
    throw new Error(`E-Invoice human assistance ended with status ${status}.`);
  }
  return status;
}

export { requestEinvoiceCaptchaAssistance };

export async function waitForEinvoiceLoginReady(
  page: Page,
  timeoutMs: number,
): Promise<"form" | "session"> {
  return await Promise.any([
    retryEinvoiceLoginNavigation(() => page.locator("#mobile_phone")
      .waitFor({ state: "visible", timeout: timeoutMs })).then(() => "form" as const),
    page.waitForURL((url) => url.pathname.startsWith("/portal/btc/mobile/"), {
      timeout: timeoutMs,
    }).then(() => "session" as const),
  ]);
}

async function signInEinvoice(
  page: Page,
  credentials: EinvoiceCredentials,
  requestHumanAssistance: EinvoiceHumanAssistanceRequest,
  signal?: AbortSignal,
  reportAccessChallenge?: () => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted();

  let loginStatus: number | undefined;
  if (!page.url().startsWith(LOGIN_URL)) {
    loginStatus = (await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }))?.status();
  }
  const externalChallenge = await page.locator(
    'input[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"]',
  ).count() > 0;
  if (loginStatus === 403 || externalChallenge) {
    await reportAccessChallenge?.();
    throw new SourceAccessChallengeError();
  }
  try {
    const ready = await waitForEinvoiceLoginReady(page, 30_000);
    if (ready === "session" || await isSignedIn(page)) return;
    await retryEinvoiceLoginNavigation(() => page
      .locator("#mobile_phone")
      .fill(requireCredential(credentials, "einvoice_phone_number")));
    await retryEinvoiceLoginNavigation(() => page
      .locator("#password")
      .fill(requireCredential(credentials, "einvoice_password")));
    await retryEinvoiceLoginNavigation(() => page.locator("#captcha").focus());
  } catch (error) {
    if (await isSignedIn(page)) return;
    throw error;
  }
  const assistanceStatus = await requestHumanAssistance(
    einvoiceCaptchaAssistanceStage(page),
    signal,
  );
  signal?.throwIfAborted();
  if (assistanceStatus !== "entered" && assistanceStatus !== "verified") {
    throw new Error(`E-Invoice human assistance ended with status ${assistanceStatus}.`);
  }

  if (await isSignedIn(page)) return;
  if (!(await page.locator("#captcha").inputValue()).trim()) {
    throw new Error(
      "E-invoice CAPTCHA is empty. Enter it in the browser before resuming.",
    );
  }
  await page.locator("#submitBtn").click();
  const outcome = await waitForEinvoiceLoginOutcome(page, 120_000, signal);
  if (outcome === "authenticated") return;
  if (outcome === "captcha-rejected")
    throw new CaptchaProviderRejectedError();
  if (outcome === "credentials-rejected")
    throw new Error("E-invoice sign-in credentials were rejected; no automatic resubmission was made.");
  if (outcome === "form-rejected")
    throw new Error("E-invoice sign-in form was rejected; no automatic resubmission was made.");
  throw new Error(
    page.url().startsWith(LOGIN_URL)
      ? "E-invoice sign-in remained on the login page without a confirmed result."
      : "E-invoice sign-in reached an unexpected page without a confirmed session.",
  );
}

async function currentPickerMonth(page: Page): Promise<YearMonth> {
  return parsePickerMonth(
    await page.locator(".dp__month_year_wrap").first().innerText(),
  );
}

async function clickPickerDay(page: Page, day: number): Promise<void> {
  await page
    .locator(".dp__calendar_item")
    .filter({
      has: page.locator(
        ".dp__cell_inner:not(.dp__cell_offset):not(.dp__cell_disabled)",
      ),
      hasText: new RegExp(`^\\s*${day}\\s*$`),
    })
    .first()
    .click();
}

async function selectDateRange(page: Page, month: YearMonth): Promise<void> {
  await page.locator("#dp-input-searchInvoiceDate").click();

  for (let visible = await currentPickerMonth(page); ; ) {
    const comparison = compareYearMonth(visible, month);
    if (comparison === 0) break;
    await page.getByLabel(comparison > 0 ? "上個月" : "下個月").click();
    visible = await currentPickerMonth(page);
  }

  await clickPickerDay(page, 1);
  await clickPickerDay(page, monthEndDay(month));
}

export async function waitForListResponse(
  page: Page,
  text: SourceTextPort = strictSourceText,
  signal?: AbortSignal,
): Promise<InvoiceListResponse> {
  const response = await waitWithAbort(page.waitForResponse(
    (candidate) =>
      candidate.url().includes(LIST_ENDPOINT) &&
      candidate.request().method() === "POST",
    { timeout: 60_000 },
  ), signal);
  if (response.status() === 204) {
    return {
      httpStatus: 204,
      totalElements: 0,
      totalPages: 0,
      size: 0,
      content: [],
    };
  }
  if (response.status() !== 200)
    throw new Error(`E-Invoice list request failed with HTTP ${response.status()}.`);
  return {
    ...await parseProviderJson(response, "E-Invoice list", invoiceListEnvelopeSchema, text),
    httpStatus: 200,
  };
}

async function waitForInvoiceResponses(
  page: Page,
  text: SourceTextPort,
  signal?: AbortSignal,
): Promise<{ header: InvoiceHeader; details: InvoiceDetailResponse }> {
  const headerPromise = waitWithAbort(page.waitForResponse(
    (candidate) =>
      candidate.url().includes(HEADER_ENDPOINT) &&
      candidate.request().method() === "POST",
    { timeout: 60_000 },
  ), signal);
  const detailPromise = waitWithAbort(page.waitForResponse(
    (candidate) =>
      candidate.url().includes(ITEMS_ENDPOINT) &&
      candidate.request().method() === "POST",
    { timeout: 60_000 },
  ), signal);

  const [headerResponse, detailResponse] = await Promise.all([
    headerPromise,
    detailPromise,
  ]);
  if (headerResponse.status() !== 200 || detailResponse.status() !== 200)
    throw new Error(`E-Invoice detail request failed with HTTP ${headerResponse.status()}/${detailResponse.status()}.`);
  return {
    header: await parseProviderJson(headerResponse, "E-Invoice invoice header", invoiceHeaderSchema, text),
    details: await parseProviderJson(detailResponse, "E-Invoice invoice detail", invoiceDetailEnvelopeSchema, text),
  };
}

async function waitForDetailResponse(
  page: Page,
  text: SourceTextPort,
  signal?: AbortSignal,
): Promise<InvoiceDetailResponse> {
  const response = await waitWithAbort(page.waitForResponse(
    (candidate) =>
      candidate.url().includes(ITEMS_ENDPOINT) &&
      candidate.request().method() === "POST",
    { timeout: 60_000 },
  ), signal);
  if (response.status() !== 200)
    throw new Error(`E-Invoice item page request failed with HTTP ${response.status()}.`);
  return parseProviderJson(response, "E-Invoice item page", invoiceDetailEnvelopeSchema, text);
}

async function ensureSearchPage(page: Page): Promise<void> {
  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#dp-input-searchInvoiceDate").waitFor({ state: "visible" });
}

export async function retryEinvoiceReadQueryWithoutRequest<T>(
  page: Page,
  prepare: () => Promise<void>,
  execute: () => Promise<T>,
  matchesRequest: (request: Request) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await prepare();
    let requestSent = false;
    const onRequest = (request: Request): void => {
      if (matchesRequest(request)) requestSent = true;
    };
    page.on("request", onRequest);
    try {
      return await execute();
    } catch (error) {
      if (attempt > 0 || !(error instanceof errors.TimeoutError) || requestSent) {
        throw error;
      }
    } finally {
      page.off("request", onRequest);
    }
  }
  throw new Error("E-Invoice read query retry ended without a result.");
}

export class EInvoiceDetailRequestNotSentError extends Error {
  constructor() {
    super("E-Invoice detail view sent no header or item request.");
  }
}

export async function retryEinvoiceMonthOnUnsentDetail<T>(attempt: () => Promise<T>): Promise<T> {
  for (let index = 0; index < 2; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (index > 0 || !(error instanceof EInvoiceDetailRequestNotSentError)) throw error;
    }
  }
  throw new Error("E-Invoice month retry ended without a result.");
}

async function searchMonth(
  page: Page,
  month: YearMonth,
  text: SourceTextPort,
  signal?: AbortSignal,
): Promise<InvoiceListResponse> {
  signal?.throwIfAborted();
  return retryEinvoiceReadQueryWithoutRequest(
    page,
    async () => {
      signal?.throwIfAborted();
      await ensureSearchPage(page);
      await selectDateRange(page, month);
      await page.locator("#carrier").selectOption("all");
      await page.locator("#status").selectOption("all");
      await page.locator("#buyerBan").fill("");
      await page.locator("#productName").fill("");
    },
    async () => {
      const listPromise = waitForListResponse(page, text, signal);
      await page.locator('button[aria-label="查詢"], button[title="查詢"]').last().click();
      return await listPromise;
    },
    (request) => request.url().includes(LIST_ENDPOINT) && request.method() === "POST",
  );
}

async function setResultPageSize100(
  page: Page,
  text: SourceTextPort,
  signal?: AbortSignal,
): Promise<InvoiceListResponse> {
  const listPromise = waitForListResponse(page, text, signal);
  await page.locator("select#SelectSizes").first().selectOption("100");
  await page.locator('button[title="執行"]').nth(1).click();
  return await listPromise;
}

async function selectResultPage(
  page: Page,
  pageIndex: number,
  text: SourceTextPort,
  signal?: AbortSignal,
): Promise<InvoiceListResponse> {
  const listPromise = waitForListResponse(page, text, signal);
  await page.locator("select#SelectPages").first().selectOption(String(pageIndex));
  await page.locator('button[title="執行"]').first().click();
  return await listPromise;
}

export async function closeInvoiceDetailModal(page: Page): Promise<void> {
  const modal = page.locator(".modal_barcode_detail.show").first();
  const backdrop = page.locator(".simple-modal-backdrop").first();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await modal.isVisible())) {
      await backdrop.waitFor({ state: "hidden", timeout: 2_000 });
      return;
    }
    await modal.getByRole("button", { name: "關閉視窗" }).click();
    try {
      await modal.waitFor({ state: "hidden", timeout: 2_000 });
      await backdrop.waitFor({ state: "hidden", timeout: 2_000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function readInvoiceRows(
  page: Page,
  entry: InvoiceListEntry,
  text: SourceTextPort,
  signal?: AbortSignal,
): Promise<{ header: InvoiceHeader; items: readonly InvoiceItem[]; itemCompleteness: "complete" | "incomplete" }> {
  signal?.throwIfAborted();
  await closeInvoiceDetailModal(page);
  let detailRequestSent = false;
  const onRequest = (request: Request): void => {
    if (request.method() === "POST" && (request.url().includes(HEADER_ENDPOINT) || request.url().includes(ITEMS_ENDPOINT))) {
      detailRequestSent = true;
    }
  };
  page.on("request", onRequest);
  const responses = waitForInvoiceResponses(page, text, signal);
  try {
    await page.locator(`a[title="${entry.invoiceNumber}"]`).first().click();
    let { header, details } = await responses;
    validatePaginationEnvelope(`E-Invoice ${entry.invoiceNumber} detail`, details);

    if (details.totalElements > details.content.length) {
      const visibleModal = page.locator(".modal.show .modal-content").first();
      const detailPromise = waitForDetailResponse(page, text, signal);
      await visibleModal.locator("select#SelectSizes").first().selectOption("100");
      await visibleModal.locator('button[title="執行"]').nth(1).click();
      details = await detailPromise;
      validatePaginationEnvelope(`E-Invoice ${entry.invoiceNumber} detail`, details);
    }

    const detailPages = [details];
    const totalPages = Math.max(1, details.totalPages);
    for (let pageIndex = 1; pageIndex < totalPages; pageIndex += 1) {
      const visibleModal = page.locator(".modal.show .modal-content").first();
      const detailPromise = waitForDetailResponse(page, text, signal);
      await visibleModal.locator("select#SelectPages").first().selectOption(String(pageIndex));
      await visibleModal.locator('button[title="執行"]').first().click();
      const detailPage = await detailPromise;
      validatePaginationEnvelope(`E-Invoice ${entry.invoiceNumber} detail page ${pageIndex}`, detailPage);
      if (detailPage.totalElements !== details.totalElements || detailPage.totalPages !== details.totalPages)
        throw new Error(`E-Invoice ${entry.invoiceNumber} detail pagination changed during collection.`);
      detailPages.push(detailPage);
    }
    const items = detailPages.flatMap((pageResult) => pageResult.content);
    if (items.length !== details.totalElements)
      throw new Error(`E-Invoice ${entry.invoiceNumber} detail pagination was incomplete.`);
    signal?.throwIfAborted();
    const completeness = items.length === 0 || items.every((item, index) => {
      try {
        return canonicalItem(item, index).completeness === "complete";
      } catch {
        return false;
      }
    }) ? "complete" : "incomplete";
    return { header, items, itemCompleteness: completeness };
  } catch (error) {
    if (error instanceof errors.TimeoutError && !detailRequestSent) {
      throw new EInvoiceDetailRequestNotSentError();
    }
    throw error;
  } finally {
    page.off("request", onRequest);
    await closeInvoiceDetailModal(page);
  }
}

async function readVisibleListRows(
  page: Page,
  month: YearMonth,
  listPageIndex: number,
  list: InvoiceListResponse,
  text: SourceTextPort,
  signal?: AbortSignal,
): Promise<InvoiceCaptureRecord[]> {
  const rows: InvoiceCaptureRecord[] = [];
  for (const entry of list.content) {
    signal?.throwIfAborted();
    const result = await readInvoiceRows(page, entry, text, signal);
    rows.push({
      month,
      listPageIndex,
      entry,
      header: result.header,
      items: result.items,
      itemCompleteness: result.itemCompleteness,
    });
  }
  return rows;
}

async function readAllInvoices(
  page: Page,
  text: SourceTextPort = strictSourceText,
  signal?: AbortSignal,
  onMonthComplete?: (completed: number, total: number) => Promise<void>,
): Promise<InvoiceReadResult> {
  const records: InvoiceCaptureRecord[] = [];
  const pages: Array<{ month: YearMonth; pageIndex: number; list: InvoiceListResponse }> = [];
  let invoiceCount = 0;
  const months = availableInvoiceMonths();

  for (const [monthIndex, month] of months.entries()) {
    signal?.throwIfAborted();
    await retryEinvoiceMonthOnUnsentDetail(async () => {
      const initialRecords = records.length;
      const initialPages = pages.length;
      const initialInvoiceCount = invoiceCount;
      try {
        let list = await searchMonth(page, month, text, signal);
        validatePaginationEnvelope(`E-Invoice ${monthLabel(month)} list`, list);
        if (list.totalElements > list.content.length) {
          list = await setResultPageSize100(page, text, signal);
          validatePaginationEnvelope(`E-Invoice ${monthLabel(month)} list`, list);
        }

        const totalPages = Math.max(1, list.totalPages);
        pages.push({ month, pageIndex: 0, list });
        invoiceCount += list.totalElements;
        records.push(...(await readVisibleListRows(page, month, 0, list, text, signal)));

        let fetchedCount = list.content.length;
        for (let pageIndex = 1; pageIndex < totalPages; pageIndex += 1) {
          const pageList = await selectResultPage(page, pageIndex, text, signal);
          validatePaginationEnvelope(`E-Invoice ${monthLabel(month)} list page ${pageIndex}`, pageList);
          if (pageList.totalElements !== list.totalElements || pageList.totalPages !== list.totalPages)
            throw new Error(`E-Invoice ${monthLabel(month)} list pagination changed during collection.`);
          pages.push({ month, pageIndex, list: pageList });
          fetchedCount += pageList.content.length;
          records.push(...(await readVisibleListRows(page, month, pageIndex, pageList, text, signal)));
        }
        if (fetchedCount !== list.totalElements)
          throw new Error(`E-Invoice ${monthLabel(month)} list pagination was incomplete.`);
        await onMonthComplete?.(monthIndex + 1, months.length);
      } catch (error) {
        records.length = initialRecords;
        pages.length = initialPages;
        invoiceCount = initialInvoiceCount;
        throw error;
      }
    });
  }

  return { records, pages, months: months.map(monthLabel), invoiceCount };
}

function parseMonthLabel(value: string): YearMonth {
  const match = value.match(/^(\d{4})-(\d{2})$/u);
  if (!match) throw new Error(`Invalid E-Invoice month label: ${value}`);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid E-Invoice month label: ${value}`);
  return { year: Number(match[1]), month };
}

export function buildCanonicalEInvoiceCapture(
  result: Readonly<{
    records: readonly InvoiceCaptureRecord[];
    pages: readonly { month: YearMonth; pageIndex: number; list: InvoiceListResponse }[];
    months: readonly string[];
  }>,
  credentials: EinvoiceCredentials,
  options: Readonly<{
    captureId?: string;
    observedAt?: string;
    today?: Date;
  }> = {},
): CanonicalEInvoiceCaptureInput {
  if (result.months.length === 0) throw new Error("E-Invoice capture requires at least one month.");
  const firstMonth = parseMonthLabel(result.months[0]!);
  const lastMonth = parseMonthLabel(result.months.at(-1)!);
  const sourceConnectionKey = deriveSourceConnectionIdentityKey("einvoice", {
    phone: requireCredential(credentials, "einvoice_phone_number"),
  });
  const identityEpoch = opaqueDigest(
    "einvoice-identity-epoch",
    sourceConnectionKey,
    "personal-invoices-v1",
  );
  const subjectDigest = opaqueDigest(
    "einvoice-subject",
    sourceConnectionKey,
    identityEpoch,
    "personal-invoices",
  );
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
    responseCode: String(page.list.httpStatus) as "200" | "204",
    rowCount: admittedRowCounts.get(pageKey(page.month, page.pageIndex)) ?? 0,
    terminal: pageOrdinal === result.pages.length - 1,
    metadata: {
      provider: "einvoice.nat.gov.tw",
      month: monthLabel(page.month),
      pageIndex: page.pageIndex,
      providerRowCount: page.list.content.length,
      totalElements: page.list.totalElements,
      totalPages: page.list.totalPages,
      size: page.list.size,
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

export type EinvoiceWorkflowInput = z.infer<typeof workflowInputSchema>;
export type EinvoiceWorkflowOutput = z.infer<typeof outputSchema>;

export function assertEinvoiceCaptureAdmissible(
  capture: CanonicalEInvoiceCaptureInput,
): void {
  if (
    capture.scope.completeness !== "complete-range" ||
    capture.scope.invoiceCompleteness !== "complete" ||
    capture.scope.itemCompleteness !== "complete"
  ) {
    throw new Error("E-Invoice source is incomplete; Canonical Financial Commit was skipped.");
  }
}

async function collectCanonicalCapture(
  page: Page,
  credentials: EinvoiceCredentials,
  text: SourceTextPort,
  signal: AbortSignal,
  onMonthComplete: (completed: number, total: number) => Promise<void>,
): Promise<{ result: InvoiceReadResult; capture: CanonicalEInvoiceCaptureInput }> {
  const result = await readAllInvoices(page, text, signal, onMonthComplete);
  signal.throwIfAborted();
  const observedRows = result.pages.reduce((total, item) => total + item.list.content.length, 0);
  if (result.records.length !== result.invoiceCount || observedRows !== result.invoiceCount) {
    throw new Error("E-Invoice source pagination was incomplete; Canonical Financial Commit was skipped.");
  }
  const capture = buildCanonicalEInvoiceCapture(result, credentials);
  assertEinvoiceCaptureAdmissible(capture);
  return { result, capture };
}

/** App-owned entry point for collecting and admitting E-Invoice statements. */
export async function runEinvoiceProviderWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
): Promise<EinvoiceWorkflowOutput> {
  const parsed = workflowInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error("E-Invoice workflow credentials are missing or invalid.");
  const financialCommit = context.financialCommit;
  if (!financialCommit) throw new Error("Canonical Financial Commit port is unavailable.");
  context.signal.throwIfAborted();

  const credentials = parsed.data.credentials;
  return await context.browser.withPage(async (page) => {
    await context.event("authentication", "authentication-started");
    const usedExistingSession = await isSignedIn(page);
    if (!usedExistingSession) {
      await signInEinvoice(
        page,
        credentials,
        async (stage, signal) => {
          if (!signal) throw new Error("E-Invoice human-assistance cancellation signal is missing.");
          return requestEinvoiceCaptchaAssistance(
            stage,
            (contract, assistanceSignal) => context.humanAssistance.request(contract, assistanceSignal),
            signal,
          );
        },
        context.signal,
        () => context.event("authentication", "source-access-challenged"),
      );
    }
    context.signal.throwIfAborted();
    await context.event("authentication", "authentication-completed");

    await context.event("collection", "collection-started");
    await context.event("decoding", "source-decoding-started");
    const { result, capture } = await collectCanonicalCapture(
      page,
      credentials,
      context.text,
      context.signal,
      async (completed, total) => {
        await context.event("collection", "month-completed", { completed, total });
      },
    );
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
      usedExistingSession,
      invoiceCount: admittedInvoiceCount,
      itemCount: commit.itemCount,
      months: result.months,
      captureId: commit.captureId,
      knowledgeAt: commit.knowledgeAt,
      commit: { ...commit, sourceRecordIds: [...commit.sourceRecordIds] },
    });
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
