import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Page } from "playwright";
import { z } from "zod";

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
  quantity?: string | null;
  unitPrice?: string | null;
  amount?: string | null;
};

type InvoiceDetailResponse = {
  totalElements: number;
  totalPages: number;
  size: number;
  content: InvoiceItem[];
};

type PurchasedItemRow = {
  carrier_customized_name: string;
  issued_at: string;
  invoice_id: string;
  amount: string;
  status: string;
  rebated: string;
  seller_business_account_number: string;
  seller_name: string;
  seller_addr: string;
  buyer_business_account_number: string;
  item_sequence_number: string;
  item_quantity: string;
  item_unit_price: string;
  item_paid_amount: string;
  item_product_name: string;
};

const inputSchema = z.object({});

const tableFileSchema = z.object({
  baseName: z.string(),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  csvFilename: z.string(),
  csvPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  usedExistingSession: z.boolean(),
  invoiceCount: z.number().int().nonnegative(),
  itemRowCount: z.number().int().nonnegative(),
  months: z.array(z.string()),
  file: tableFileSchema,
});

type Input = z.infer<typeof inputSchema> & {
  credentials: EinvoiceCredentials;
};
type TableFile = z.infer<typeof tableFileSchema>;

const csvHeaders: (keyof PurchasedItemRow)[] = [
  "carrier_customized_name",
  "issued_at",
  "invoice_id",
  "amount",
  "status",
  "rebated",
  "seller_business_account_number",
  "seller_name",
  "seller_addr",
  "buyer_business_account_number",
  "item_sequence_number",
  "item_quantity",
  "item_unit_price",
  "item_paid_amount",
  "item_product_name",
];

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

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
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

function invoiceStatus(
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

function buyerId(value: string | null | undefined): string {
  const cleaned = cleanText(value);
  return /^0+$/.test(cleaned) ? "" : cleaned;
}

function issuedAt(header: InvoiceHeader): string {
  if (header.invoiceInstantDate) {
    return String(Math.floor(Date.parse(header.invoiceInstantDate) / 1000));
  }
  const date = cleanText(header.invoiceDate);
  const time = cleanText(header.invoiceTime) || "00:00:00";
  const match = date.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return "";
  return String(
    Math.floor(
      Date.parse(`${match[1]}-${match[2]}-${match[3]}T${time}+08:00`) / 1000,
    ),
  );
}

function purchasedItemRows(
  entry: InvoiceListEntry,
  header: InvoiceHeader,
  items: InvoiceItem[],
): PurchasedItemRow[] {
  const base = {
    carrier_customized_name: cleanText(entry.carrierName),
    issued_at: issuedAt(header),
    invoice_id: cleanText(entry.invoiceNumber),
    amount: cleanText(header.totalAmount ?? entry.totalAmount),
    status: invoiceStatus(entry, header),
    rebated: String(["Y", "1", "true"].includes(cleanText(header.alwFlag))),
    seller_business_account_number: cleanText(header.sellerId),
    seller_name: cleanText(header.sellerName),
    seller_addr: cleanText(header.sellerAddress),
    buyer_business_account_number: buyerId(header.buyerId ?? entry.buyerId),
  };

  const rows = items.length ? items : [{}];
  return rows.map((item, index) => ({
    ...base,
    item_sequence_number: cleanText(item.sequenceNumber) || String(index + 1),
    item_quantity: cleanText(item.quantity),
    item_unit_price: cleanText(item.unitPrice),
    item_paid_amount: cleanText(item.amount),
    item_product_name: cleanText(item.item),
  }));
}

function invoiceRowsToCsv(rows: PurchasedItemRow[]): string {
  return rowsToCsv([
    csvHeaders,
    ...rows.map((row) => csvHeaders.map((header) => row[header])),
  ]);
}

async function isSignedIn(page: Page): Promise<boolean> {
  if (page.url().includes("/portal/btc/mobile")) return true;
  return await page
    .getByText(/登出|會員專區|載具歸戶/i)
    .first()
    .isVisible({ timeout: 3_000 })
    .catch(() => false);
}

async function signInEinvoice(
  ctx: LibrettoWorkflowContext,
  credentials: EinvoiceCredentials,
): Promise<void> {
  const { page, session } = ctx;

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#mobile_phone").waitFor({ state: "visible" });
  await page
    .locator("#mobile_phone")
    .fill(requireCredential(credentials, "einvoice_phone_number"));
  await page
    .locator("#password")
    .fill(requireCredential(credentials, "einvoice_password"));
  await page.locator("#captcha").focus();

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

async function waitForListResponse(
  page: Page,
): Promise<InvoiceListResponse> {
  const response = await page.waitForResponse(
    (candidate) =>
      candidate.url().includes(LIST_ENDPOINT) &&
      candidate.request().method() === "POST",
    { timeout: 60_000 },
  );
  return (await response.json()) as InvoiceListResponse;
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
): Promise<PurchasedItemRow[]> {
  await closeInvoiceDetailModal(page);
  const responses = waitForInvoiceResponses(page);
  try {
    await page.locator(`a[title="${entry.invoiceNumber}"]`).first().click();
    let { header, details } = await responses;

    if (details.totalElements > details.content.length) {
      const visibleModal = page.locator(".modal.show .modal-content").first();
      const detailPromise = waitForDetailResponse(page);
      await visibleModal.locator("select#SelectSizes").first().selectOption("100");
      await visibleModal.locator('button[title="執行"]').nth(1).click();
      details = await detailPromise;
    }

    return purchasedItemRows(entry, header, details.content);
  } finally {
    await closeInvoiceDetailModal(page);
  }
}

async function readVisibleListRows(
  page: Page,
  list: InvoiceListResponse,
): Promise<PurchasedItemRow[]> {
  const rows: PurchasedItemRow[] = [];
  for (const entry of list.content) {
    rows.push(...(await readInvoiceRows(page, entry)));
  }
  return rows;
}

async function readAllInvoices(page: Page): Promise<{
  rows: PurchasedItemRow[];
  months: string[];
  invoiceCount: number;
}> {
  const rows: PurchasedItemRow[] = [];
  let invoiceCount = 0;
  const months = availableInvoiceMonths();

  for (const month of months) {
    console.log(`einvoice-search-month: ${monthLabel(month)}`);
    let list = await searchMonth(page, month);
    if (list.totalElements > list.content.length) {
      list = await setResultPageSize100(page);
    }

    invoiceCount += list.totalElements;
    rows.push(...(await readVisibleListRows(page, list)));

    for (let pageIndex = 1; pageIndex < list.totalPages; pageIndex += 1) {
      const pageList = await selectResultPage(page, pageIndex);
      rows.push(...(await readVisibleListRows(page, pageList)));
    }
  }

  return { rows, months: months.map(monthLabel), invoiceCount };
}

async function writeInvoicesFile(rows: PurchasedItemRow[]): Promise<TableFile> {
  const dir = join(process.cwd(), "downloads", "einvoice-personal-invoices");
  await mkdir(dir, { recursive: true });

  const baseName = `einvoice-personal-invoices-${Date.now()}`;
  const csvFilename = `${baseName}.csv`;
  const csvPath = join(dir, csvFilename);
  await writeFile(csvPath, invoiceRowsToCsv(rows), "utf8");

  const csvStat = await stat(csvPath);
  return {
    baseName,
    rowCount: rows.length,
    headers: csvHeaders,
    csvFilename,
    csvPath,
    csvBytes: csvStat.size,
  };
}

export default workflow("einvoicePersonalInvoices", {
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

    console.log("automation-progress: 20");
    const result = await readAllInvoices(ctx.page);
    console.log("automation-progress: 90");
    const file = await writeInvoicesFile(result.rows);
    console.log("automation-progress: 100");

    return {
      usedExistingSession: authResult.usedProfile,
      invoiceCount: result.invoiceCount,
      itemRowCount: result.rows.length,
      months: result.months,
      file,
    };
  },
});
