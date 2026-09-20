import { randomUUID, createHash } from "node:crypto";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Page } from "playwright";
import { z } from "zod";
import { emitAutomationProgress } from "../lib/automation/progress.ts";
import {
  emitHumanAssistanceStage,
  type WorkflowHumanAssistanceStage,
} from "./human-assistance.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import {
  commitCanonicalEInvoiceCaptureInTransaction,
  E_INVOICE_CONTRACT_VERSION,
  E_INVOICE_CURRENCY_AUTHORITY,
  E_INVOICE_ROUTE,
  type CanonicalEInvoiceCaptureInput,
  type CanonicalEInvoiceInput,
  type CanonicalEInvoiceItemInput,
  type CanonicalEInvoiceOccurrence,
} from "../ledger/canonical/einvoice.ts";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import { executeCanonicalFinancialCommitRun } from "../ledger/canonical/canonical-financial-commit-execution.ts";

const LOGIN_URL = "https://www.einvoice.nat.gov.tw/accounts/login";
const SEARCH_URL =
  "https://www.einvoice.nat.gov.tw/portal/btc/mobile/btc502w/search";
const LIST_ENDPOINT = "/btc/cloud/api/btc502w/searchCarrierInvoice";
const HEADER_ENDPOINT = "/btc/cloud/api/common/getCarrierInvoiceData";
const ITEMS_ENDPOINT = "/btc/cloud/api/common/getCarrierInvoiceDetail";

type EinvoiceCredentials = {
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
  totalAmount?: string | null;
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

const inputSchema = z.object({
  /** Override only for isolated checks; desktop supplies LEDGER_DIR. */
  canonicalLedgerDir: z.string().optional(),
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

type Input = z.infer<typeof inputSchema> & {
  credentials: EinvoiceCredentials;
};

function requireCredential(
  credentials: EinvoiceCredentials,
  name: keyof EinvoiceCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
    );
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
  if (record.itemCompleteness === "incomplete" && itemCompleteness === "complete") {
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

async function signInEinvoice(
  ctx: LibrettoWorkflowContext,
  credentials: EinvoiceCredentials,
): Promise<void> {
  const { page, session } = ctx;

  if (!page.url().startsWith(LOGIN_URL)) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  }
  await page.locator("#mobile_phone").waitFor({ state: "visible" });
  await page
    .locator("#mobile_phone")
    .fill(requireCredential(credentials, "einvoice_phone_number"));
  await page
    .locator("#password")
    .fill(requireCredential(credentials, "einvoice_password"));
  await page.locator("#captcha").focus();
  await emitHumanAssistanceStage(einvoiceCaptchaAssistanceStage(page));

  console.log(
    "manual-auth-required: enter the e-invoice CAPTCHA in the browser, then run `npx libretto resume --session " +
      session +
      "`.",
  );
  await pause(session);

  if (await isSignedIn(page)) return;
  if (!(await page.locator("#captcha").inputValue()).trim()) {
    throw new Error(
      "E-invoice CAPTCHA is empty. Enter it in the browser before resuming.",
    );
  }
  await page.locator("#submitBtn").click();
  await page.waitForURL(/\/portal\/btc\/mobile/, { timeout: 120_000 });
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
): Promise<InvoiceListResponse> {
  const response = await page.waitForResponse(
    (candidate) =>
      candidate.url().includes(LIST_ENDPOINT) &&
      candidate.request().method() === "POST",
    { timeout: 60_000 },
  );
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
  return { ...(await response.json()) as Omit<InvoiceListResponse, "httpStatus">, httpStatus: 200 };
}

async function waitForInvoiceResponses(
  page: Page,
): Promise<{ header: InvoiceHeader; details: InvoiceDetailResponse }> {
  const headerPromise = page.waitForResponse(
    (candidate) =>
      candidate.url().includes(HEADER_ENDPOINT) &&
      candidate.request().method() === "POST",
    { timeout: 60_000 },
  );
  const detailPromise = page.waitForResponse(
    (candidate) =>
      candidate.url().includes(ITEMS_ENDPOINT) &&
      candidate.request().method() === "POST",
    { timeout: 60_000 },
  );

  const [headerResponse, detailResponse] = await Promise.all([
    headerPromise,
    detailPromise,
  ]);
  if (headerResponse.status() !== 200 || detailResponse.status() !== 200)
    throw new Error(`E-Invoice detail request failed with HTTP ${headerResponse.status()}/${detailResponse.status()}.`);
  return {
    header: (await headerResponse.json()) as InvoiceHeader,
    details: (await detailResponse.json()) as InvoiceDetailResponse,
  };
}

async function waitForDetailResponse(page: Page): Promise<InvoiceDetailResponse> {
  const response = await page.waitForResponse(
    (candidate) =>
      candidate.url().includes(ITEMS_ENDPOINT) &&
      candidate.request().method() === "POST",
    { timeout: 60_000 },
  );
  if (response.status() !== 200)
    throw new Error(`E-Invoice item page request failed with HTTP ${response.status()}.`);
  return (await response.json()) as InvoiceDetailResponse;
}

async function ensureSearchPage(page: Page): Promise<void> {
  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#dp-input-searchInvoiceDate").waitFor({ state: "visible" });
}

async function searchMonth(
  page: Page,
  month: YearMonth,
): Promise<InvoiceListResponse> {
  await ensureSearchPage(page);
  await selectDateRange(page, month);
  await page.locator("#carrier").selectOption("all");
  await page.locator("#status").selectOption("all");
  await page.locator("#buyerBan").fill("");
  await page.locator("#productName").fill("");

  const listPromise = waitForListResponse(page);
  await page.locator('button[aria-label="查詢"], button[title="查詢"]').last().click();
  return await listPromise;
}

async function setResultPageSize100(page: Page): Promise<InvoiceListResponse> {
  const listPromise = waitForListResponse(page);
  await page.locator("select#SelectSizes").first().selectOption("100");
  await page.locator('button[title="執行"]').nth(1).click();
  return await listPromise;
}

async function selectResultPage(
  page: Page,
  pageIndex: number,
): Promise<InvoiceListResponse> {
  const listPromise = waitForListResponse(page);
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
): Promise<{ header: InvoiceHeader; items: readonly InvoiceItem[]; itemCompleteness: "complete" | "incomplete" }> {
  await closeInvoiceDetailModal(page);
  const responses = waitForInvoiceResponses(page);
  try {
    await page.locator(`a[title="${entry.invoiceNumber}"]`).first().click();
    let { header, details } = await responses;
    validatePaginationEnvelope(`E-Invoice ${entry.invoiceNumber} detail`, details);

    if (details.totalElements > details.content.length) {
      const visibleModal = page.locator(".modal.show .modal-content").first();
      const detailPromise = waitForDetailResponse(page);
      await visibleModal.locator("select#SelectSizes").first().selectOption("100");
      await visibleModal.locator('button[title="執行"]').nth(1).click();
      details = await detailPromise;
      validatePaginationEnvelope(`E-Invoice ${entry.invoiceNumber} detail`, details);
    }

    const detailPages = [details];
    const totalPages = Math.max(1, details.totalPages);
    for (let pageIndex = 1; pageIndex < totalPages; pageIndex += 1) {
      const visibleModal = page.locator(".modal.show .modal-content").first();
      const detailPromise = waitForDetailResponse(page);
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
    const completeness = items.length === 0 || items.every((item, index) => {
      try {
        return canonicalItem(item, index).completeness === "complete";
      } catch {
        return false;
      }
    }) ? "complete" : "incomplete";
    return { header, items, itemCompleteness: completeness };
  } finally {
    await closeInvoiceDetailModal(page);
  }
}

async function readVisibleListRows(
  page: Page,
  month: YearMonth,
  listPageIndex: number,
  list: InvoiceListResponse,
): Promise<InvoiceCaptureRecord[]> {
  const rows: InvoiceCaptureRecord[] = [];
  for (const entry of list.content) {
    const result = await readInvoiceRows(page, entry);
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

async function readAllInvoices(page: Page): Promise<{
  records: InvoiceCaptureRecord[];
  pages: Array<{ month: YearMonth; pageIndex: number; list: InvoiceListResponse }>;
  months: string[];
  invoiceCount: number;
}> {
  const records: InvoiceCaptureRecord[] = [];
  const pages: Array<{ month: YearMonth; pageIndex: number; list: InvoiceListResponse }> = [];
  let invoiceCount = 0;
  const months = availableInvoiceMonths();

  for (const month of months) {
    console.log(`einvoice-search-month: ${monthLabel(month)}`);
    let list = await searchMonth(page, month);
    validatePaginationEnvelope(`E-Invoice ${monthLabel(month)} list`, list);
    if (list.totalElements > list.content.length) {
      list = await setResultPageSize100(page);
      validatePaginationEnvelope(`E-Invoice ${monthLabel(month)} list`, list);
    }

    const totalPages = Math.max(1, list.totalPages);
    pages.push({ month, pageIndex: 0, list });
    invoiceCount += list.totalElements;
    records.push(...(await readVisibleListRows(page, month, 0, list)));

    let fetchedCount = list.content.length;
    for (let pageIndex = 1; pageIndex < totalPages; pageIndex += 1) {
      const pageList = await selectResultPage(page, pageIndex);
      validatePaginationEnvelope(`E-Invoice ${monthLabel(month)} list page ${pageIndex}`, pageList);
      if (pageList.totalElements !== list.totalElements || pageList.totalPages !== list.totalPages)
        throw new Error(`E-Invoice ${monthLabel(month)} list pagination changed during collection.`);
      pages.push({ month, pageIndex, list: pageList });
      fetchedCount += pageList.content.length;
      records.push(...(await readVisibleListRows(page, month, pageIndex, pageList)));
    }
    if (fetchedCount !== list.totalElements)
      throw new Error(`E-Invoice ${monthLabel(month)} list pagination was incomplete.`);
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
  const pages = result.pages.map((page, pageOrdinal) => ({
    pageOrdinal,
    responseCode: String(page.list.httpStatus) as "200" | "204",
    rowCount: page.list.content.length,
    terminal: pageOrdinal === result.pages.length - 1,
    metadata: {
      provider: "einvoice.nat.gov.tw",
      month: monthLabel(page.month),
      pageIndex: page.pageIndex,
      totalElements: page.list.totalElements,
      totalPages: page.list.totalPages,
      size: page.list.size,
    },
  }));
  const itemCompleteness = result.records.every(
    (record) => record.itemCompleteness === "complete",
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
    invoices: result.records.map(mapCanonicalEInvoiceRecord),
  };
}

function configuredCanonicalLedgerDir(explicit: string | undefined): string {
  return explicit?.trim() ||
    process.env.OCTOPUSBEAK_CANONICAL_LEDGER_DIR?.trim() ||
    process.env.LEDGER_DIR?.trim() ||
    DEFAULT_LEDGER_DIR;
}

export async function commitCanonicalCapture(
  capture: CanonicalEInvoiceCaptureInput,
  ledgerDir: string,
) {
  const result = await executeCanonicalFinancialCommitRun({
    canonicalLedgerDir: ledgerDir,
    items: [
      {
        provider: "einvoice",
        product: "personal-invoice",
        itemKey: capture.captureId,
        commit: ({ writer, admission }) =>
          commitCanonicalEInvoiceCaptureInTransaction(
            writer,
            capture,
            admission,
          ),
      },
    ],
    provider: "einvoice",
    product: "personal-invoice",
  });
  const item = result.items[0];
  if (item?.status !== "committed")
    throw new Error(
      `E-Invoice canonical persistence ${result.status}: ${result.diagnostics
        .map((diagnostic) => `${diagnostic.stage}/${diagnostic.errorCode}`)
        .join(", ")}`,
    );
  return item.value;
}

export default workflow("einvoicePersonalInvoices", {
  startUrl: LOGIN_URL,
  credentials: ["einvoice_phone_number", "einvoice_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as Input;
    const authResult = await librettoAuthenticate(ctx, {
      credentials: input.credentials,
      isSignedIn: async () => await isSignedIn(ctx.page),
      signIn: async () => {
        await signInEinvoice(ctx, input.credentials);
      },
    });

    emitAutomationProgress({ phaseCode: "workflow", completed: 20, total: 100, percent: 20 });
    const result = await readAllInvoices(ctx.page);
    const capture = buildCanonicalEInvoiceCapture(result, input.credentials);
    emitAutomationProgress({ phaseCode: "workflow", completed: 90, total: 100, percent: 90 });
    const commit = await commitCanonicalCapture(
      capture,
      configuredCanonicalLedgerDir(input.canonicalLedgerDir),
    );
    emitAutomationProgress({ phaseCode: "workflow", completed: 100, total: 100, percent: 100 });

    return {
      usedExistingSession: authResult.usedProfile,
      invoiceCount: result.invoiceCount,
      itemCount: commit.itemCount,
      months: result.months,
      captureId: commit.captureId,
      knowledgeAt: commit.knowledgeAt,
      commit: { ...commit, sourceRecordIds: [...commit.sourceRecordIds] },
    };
  },
});
