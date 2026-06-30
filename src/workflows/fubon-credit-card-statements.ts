import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pause, workflow, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import {
  activateControlWithoutPointer,
  hasAttachedLocator,
} from "./browser-interaction.js";

const BANK_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";

type BrowserScope = Page | Frame;

type FubonCredentials = {
  fubon_user_id?: string;
  fubon_account?: string;
  fubon_password?: string;
};

type CsvRow = Record<string, string>;

const periodOffsetSchema = z.number().int().min(1).max(6);

const inputSchema = z.object({
  periodOffsets: z
    .array(periodOffsetSchema)
    .min(1)
    .default([1, 2, 3, 4, 5, 6]),
  statementCardLabels: z.array(z.string()).default([]),
  unbilledCardNumbers: z.array(z.string()).default([]),
});

const paymentStatusSchema = z.object({
  statement_period: z.string(),
  payment_status: z.string(),
  previous_balance: z.string().optional(),
  payment_date: z.string().optional(),
  payment_posting_date: z.string().optional(),
  payment_amount: z.string().optional(),
  payment_description: z.string().optional(),
});

const generatedCsvFileSchema = z.object({
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
  cardNumbers: z.array(z.string()),
  periods: z.array(z.string()),
  paymentStatuses: z.array(paymentStatusSchema),
  generatedAt: z.string(),
  workflow: z.literal("fubonCreditCardStatements"),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
});

const outputSchema = z.object({
  periodOffsets: z.array(periodOffsetSchema),
  statementPeriods: z.array(z.string()),
  statementCards: z.array(z.string()),
  unbilledCards: z.array(z.string()),
  csvFiles: z.object({
    billedStatements: generatedCsvFileSchema,
    unbilledStatements: generatedCsvFileSchema,
  }),
});

export {
  inputSchema as fubonCreditCardStatementsInputSchema,
  outputSchema as fubonCreditCardStatementsOutputSchema,
};

export type FubonCreditCardStatementsInput = z.infer<typeof inputSchema>;
export type FubonCreditCardStatementsOutput = z.infer<typeof outputSchema>;
type PaymentStatus = z.infer<typeof paymentStatusSchema>;
type GeneratedCsvFile = z.infer<typeof generatedCsvFileSchema>;

type StatementRowsResult = {
  rows: CsvRow[];
  paymentStatuses: PaymentStatus[];
};

const periodTabs = [
  { offset: 1, label: "本期" },
  { offset: 2, label: "前一期" },
  { offset: 3, label: "前二期" },
  { offset: 4, label: "前三期" },
  { offset: 5, label: "前四期" },
  { offset: 6, label: "前五期" },
] as const;

const billedHeaders = [
  "card_number",
  "card_label",
  "consume_date",
  "description",
  "posting_date",
  "foreign_currency",
  "foreign_amount",
  "twd_amount",
  "installment_action",
  "payment_status",
] as const;

const unbilledHeaders = [
  "statement_period",
  "card_number",
  "card_label",
  "consume_date",
  "description",
  "posting_date",
  "foreign_currency",
  "foreign_amount",
  "twd_amount",
] as const;

function requireCredential(
  credentials: FubonCredentials,
  name: keyof FubonCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
    );
  }
  return value;
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function digitsOnly(value: string): string {
  return toAsciiDigits(value).replace(/\D/g, "");
}

function matchesFilter(value: string, filters: string[]): boolean {
  if (filters.length === 0) return true;

  const normalizedValue = toAsciiDigits(value).toLowerCase();
  const valueDigits = digitsOnly(value);

  return filters.some((filter) => {
    const normalizedFilter = toAsciiDigits(filter).toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      normalizedValue.includes(normalizedFilter) ||
      (filterDigits.length > 0 && valueDigits.endsWith(filterDigits))
    );
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function createTimestampGenerator(): () => string {
  let lastTimestamp = 0;

  return () => {
    const timestamp = Date.now();
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    return String(lastTimestamp);
  };
}

const nextTimestamp = createTimestampGenerator();

function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function toCsv(rows: CsvRow[], headers: readonly string[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header] ?? "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function isDateLike(value: string): boolean {
  return /^\d{3,4}\/\d{2}\/\d{2}$/.test(toAsciiDigits(cleanText(value)));
}

function consumeDateSortKey(row: CsvRow): string {
  const date = toAsciiDigits(cleanText(row.consume_date));
  const match = date.match(/^(\d{3,4})\/(\d{2})\/(\d{2})$/);
  if (!match) return "";

  const year = match[1].length === 3 ? Number(match[1]) + 1911 : Number(match[1]);
  return `${String(year).padStart(4, "0")}${match[2]}${match[3]}`;
}

function compareRowsByConsumeDateDesc(left: CsvRow, right: CsvRow): number {
  return consumeDateSortKey(right).localeCompare(consumeDateSortKey(left));
}

function parseStatementCardLabel(cardLabel: string): {
  cardNumber: string;
  cardLabel: string;
} {
  const asciiLabel = toAsciiDigits(cleanText(cardLabel));
  const digits = digitsOnly(asciiLabel);
  return {
    cardNumber: digits.slice(-4),
    cardLabel: cleanText(asciiLabel.replace(/末\s*\d+\s*碼\s*\d+$/, "")),
  };
}

function paymentStatusValue(description: string): string {
  if (description.includes("行動銀行繳款")) return "paid_by_mobile_banking";
  if (description.includes("前期應繳總額")) return "previous_balance";
  return "";
}

function isPaymentStatusRow(cells: string[]): boolean {
  const description = cells[1] ?? "";
  return description.includes("前期應繳總額") || description.includes("行動銀行繳款");
}

function paymentStatusFromRows(
  period: string,
  previousBalanceCells: string[] | null,
  paymentCells: string[] | null,
): PaymentStatus | null {
  if (!previousBalanceCells && !paymentCells) return null;
  const paymentDescription = paymentCells?.[1] ?? "";
  const previousBalance = previousBalanceCells?.[5] ?? "";
  const paymentStatus = paymentDescription
    ? paymentStatusValue(paymentDescription)
    : "previous_balance_only";

  return {
    statement_period: period,
    payment_status: paymentStatus,
    previous_balance: previousBalance || undefined,
    payment_date: paymentCells?.[0] || undefined,
    payment_posting_date: paymentCells?.[2] || undefined,
    payment_amount: paymentCells?.[5] || undefined,
    payment_description: paymentDescription || undefined,
  };
}

function metadataForRows(
  rows: CsvRow[],
  headers: readonly string[],
  paymentStatuses: PaymentStatus[],
  periods = unique(rows.map((row) => row.statement_period).filter(Boolean)),
) {
  return {
    cardNumbers: unique(rows.map((row) => row.card_number).filter(Boolean)),
    periods,
    paymentStatuses,
    generatedAt: new Date().toISOString(),
    workflow: "fubonCreditCardStatements" as const,
    rowCount: rows.length,
    headers: [...headers],
  };
}

async function writeCsvWithMetadata(
  baseName: string,
  rows: CsvRow[],
  headers: readonly string[],
  paymentStatuses: PaymentStatus[] = [],
  periods?: string[],
): Promise<GeneratedCsvFile> {
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    "fubon-credit-card-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const csvFilename = `${safeFilename(baseName)}-${nextTimestamp()}.csv`;
  const jsonFilename = csvFilename.replace(/\.csv$/, ".json");
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const content = toCsv(rows, headers);
  const metadata = metadataForRows(rows, headers, paymentStatuses, periods);
  const jsonContent = `${JSON.stringify(
    {
      ...metadata,
      csvFilename,
      jsonFilename,
    },
    null,
    2,
  )}\n`;

  await writeFile(csvPath, content, "utf8");
  await writeFile(jsonPath, jsonContent, "utf8");

  return {
    ...metadata,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: Buffer.byteLength(content, "utf8"),
    jsonBytes: Buffer.byteLength(jsonContent, "utf8"),
  };
}

async function waitForFrame(
  page: Page,
  name: string,
  timeoutMs = 60_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frame({ name });
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for frame "${name}".`);
}

async function findScopeWithSelector(
  page: Page,
  selector: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const locator = scope.locator(selector).first();
      if (await hasAttachedLocator(locator)) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find selector "${selector}" in any frame.`);
}

async function findScopeWithLocator(
  page: Page,
  locatorFor: (scope: BrowserScope) => Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const locator = locatorFor(scope);
      if (await hasAttachedLocator(locator)) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find ${description} in any frame.`);
}

async function waitForNoVisibleBankMask(
  page: Page,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let hasVisibleMask = false;
    for (const scope of [page, ...page.frames()]) {
      const masks = scope.locator("div._mask, ._mask");
      const count = await masks.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        if (await masks.nth(index).isVisible().catch(() => false)) {
          hasVisibleMask = true;
          break;
        }
      }
      if (hasVisibleMask) break;
    }

    if (!hasVisibleMask) return;
    await page.waitForTimeout(250);
  }

  throw new Error("Timed out waiting for the bank loading mask to clear.");
}

async function clickLinkByClassOrText(
  page: Page,
  classSelector: string,
  text: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const classLink = scope.locator(`a.${classSelector}`).first();
      const textLink = scope.locator("a").filter({ hasText: text }).first();

      for (const link of [classLink, textLink]) {
        if (!(await hasAttachedLocator(link))) continue;

        const href = await link.getAttribute("href");
        if (href && href !== "#" && !href.startsWith("javascript:")) {
          await scope.goto(new URL(href, BANK_ENTRY_URL).toString(), {
            waitUntil: "domcontentloaded",
          });
        } else {
          await activateControlWithoutPointer(link);
        }
        return;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Could not find link "${text}".`);
}

async function openCreditCardFunctionPage(
  page: Page,
  classSelector: string,
  text: string,
): Promise<void> {
  try {
    await clickLinkByClassOrText(page, classSelector, text, 5_000);
    return;
  } catch {
    // The combined workflow may be sitting in another product area after login.
  }

  const headerFrame = await waitForFrame(page, "frame1");
  await activateControlWithoutPointer(headerFrame.locator("#menu_CCC"));
  await clickLinkByClassOrText(page, classSelector, text);
}

async function fillCreditCardLoginForm(
  page: Page,
  credentials: FubonCredentials,
) {
  const userId = requireCredential(credentials, "fubon_user_id");
  const account = requireCredential(credentials, "fubon_account");
  const password = requireCredential(credentials, "fubon_password");

  await page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });

  const headerFrame = await waitForFrame(page, "frame1");
  await activateControlWithoutPointer(headerFrame.locator("#menu_CCC"));

  const landingFrame = await waitForFrame(page, "txnFrame");
  const creditCardHref = await landingFrame
    .locator("a.task_CCCQU002.menu_CCC02")
    .first()
    .getAttribute("href");
  if (!creditCardHref) {
    throw new Error("Could not find the credit card billing navigation href.");
  }

  await landingFrame.goto(new URL(creditCardHref, BANK_ENTRY_URL).toString(), {
    waitUntil: "domcontentloaded",
  });

  await activateControlWithoutPointer(
    headerFrame.locator("a").filter({ hasText: "登入" }).first(),
  );

  const loginFrame = await waitForFrame(page, "txnFrame");
  const visiblePasswordFields = loginFrame.locator(
    'input[type="password"]:visible',
  );
  await visiblePasswordFields.first().waitFor({ timeout: 60_000 });

  // The bank page renders these fields as password inputs even for user ID/account.
  await visiblePasswordFields.nth(0).fill(userId);
  await visiblePasswordFields.nth(1).fill(account);
  await visiblePasswordFields.nth(2).fill(password);
  await loginFrame.locator("#m1_userCaptcha").focus();
}

async function waitForSignedInState(page: Page): Promise<void> {
  const headerFrame = await waitForFrame(page, "frame1");
  await headerFrame
    .locator("#header_form\\:header_logout")
    .waitFor({ state: "visible", timeout: 60_000 });
}

async function openStatementDetailsPage(page: Page): Promise<BrowserScope> {
  await openCreditCardFunctionPage(
    page,
    "task_CCCQU003.menu_CCC0202",
    "帳單明細查詢",
  );
  const scope = await findScopeWithLocator(
    page,
    statementDetailsTable,
    "credit card statement detail table",
    60_000,
  );
  await statementDetailsTable(scope).waitFor({
    state: "attached",
    timeout: 60_000,
  });
  return scope;
}

async function openUnbilledDetailsPage(page: Page): Promise<BrowserScope> {
  await openCreditCardFunctionPage(
    page,
    "task_CCCQU004.menu_CCC0203",
    "未出帳單消費明細",
  );
  const scope = await findScopeWithLocator(
    page,
    unbilledDetailsTable,
    "unbilled credit card detail table",
    60_000,
  );
  await unbilledDetailsTable(scope).waitFor({
    state: "attached",
    timeout: 60_000,
  });
  return scope;
}

function statementDetailsTable(scope: BrowserScope): Locator {
  return scope
    .locator("table")
    .filter({ hasText: "消費日期" })
    .filter({ hasText: "外幣折算日/幣別" })
    .filter({ hasText: "臺幣金額" })
    .first();
}

function statementSummaryTable(scope: BrowserScope): Locator {
  return scope
    .locator("table")
    .filter({ hasText: "帳單年月" })
    .filter({ hasText: "信用額度" })
    .first();
}

function unbilledDetailsTable(scope: BrowserScope): Locator {
  return scope
    .locator("table")
    .filter({ hasText: "消費卡號後四碼" })
    .filter({ hasText: "指定消費分期" })
    .first();
}

async function readCells(row: Locator): Promise<string[]> {
  const cells = row.locator("th,td");
  const count = await cells.count();
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(cleanText(await cells.nth(index).textContent()));
  }
  return values;
}

async function readStatementPeriodLabel(scope: BrowserScope): Promise<string> {
  const rows = statementSummaryTable(scope).locator("tr");
  await rows.nth(1).waitFor({ state: "attached", timeout: 60_000 });
  const cells = await readCells(rows.nth(1));
  return cells[0] ?? "";
}

function isStatementCardLabelRow(cells: string[]): boolean {
  const nonEmpty = cells.filter(Boolean);
  return nonEmpty.length === 1 && /(?:正卡|附卡).*末[０-９0-9]{1,4}/.test(nonEmpty[0]);
}

function isUnbilledCardLabelRow(cells: string[]): boolean {
  const nonEmpty = cells.filter(Boolean);
  return nonEmpty.length === 1 && /^\d{6}\*+\d{4}$/.test(nonEmpty[0]);
}

function isHeaderRow(cells: string[]): boolean {
  return cells.includes("消費日期") && cells.includes("消費說明");
}

function hasUsefulData(cells: string[]): boolean {
  return cells.some(Boolean);
}

async function selectStatementPeriod(
  page: Page,
  periodOffset: number,
): Promise<BrowserScope> {
  const period = periodTabs.find((item) => item.offset === periodOffset);
  if (!period) throw new Error(`Unsupported period offset ${periodOffset}.`);

  let scope = await findScopeWithSelector(page, "#form1\\:period");
  const currentValue = await scope
    .locator("#form1\\:period")
    .getAttribute("value");

  await waitForNoVisibleBankMask(page);

  if (currentValue !== String(periodOffset)) {
    const tab = scope.locator("a").filter({ hasText: period.label }).first();
    await tab.waitFor({ state: "attached", timeout: 60_000 });
    await activateControlWithoutPointer(tab);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      scope = await findScopeWithSelector(page, "#form1\\:period", 5_000);
      const value = await scope.locator("#form1\\:period").getAttribute("value");
      if (value === String(periodOffset)) {
        await waitForNoVisibleBankMask(page);
        return scope;
      }
      await page.waitForTimeout(500);
    }

    throw new Error(`Timed out switching to period tab "${period.label}".`);
  }

  return scope;
}

async function readStatementRows(
  scope: BrowserScope,
  periodLabel: string,
  cardFilters: string[],
): Promise<StatementRowsResult> {
  const rows = statementDetailsTable(scope).locator("tr");
  const count = await rows.count();
  const details: CsvRow[] = [];
  let cardLabel = "";
  let previousBalanceCells: string[] | null = null;
  let paymentCells: string[] | null = null;

  for (let index = 0; index < count; index += 1) {
    const cells = await readCells(rows.nth(index));
    if (!hasUsefulData(cells) || isHeaderRow(cells)) continue;

    if (isStatementCardLabelRow(cells)) {
      cardLabel = cells.find(Boolean) ?? "";
      continue;
    }

    if (isPaymentStatusRow(cells)) {
      if ((cells[1] ?? "").includes("前期應繳總額")) previousBalanceCells = cells;
      if ((cells[1] ?? "").includes("行動銀行繳款")) paymentCells = cells;
      continue;
    }

    if (!isDateLike(cells[0] ?? "")) continue;
    if (cardLabel && !matchesFilter(cardLabel, cardFilters)) continue;
    if (!cardLabel && cardFilters.length > 0) continue;

    const parsedCard = parseStatementCardLabel(cardLabel);
    details.push({
      statement_period: periodLabel,
      card_number: parsedCard.cardNumber,
      card_label: parsedCard.cardLabel || cardLabel,
      consume_date: cells[0] ?? "",
      description: cells[1] ?? "",
      posting_date: cells[2] ?? "",
      foreign_currency: cells[3] ?? "",
      foreign_amount: cells[4] ?? "",
      twd_amount: cells[5] ?? "",
      installment_action: "",
      payment_status: "",
    });
  }

  const paymentStatus = paymentStatusFromRows(
    periodLabel,
    previousBalanceCells,
    paymentCells,
  );
  const paymentStatusLabel = paymentStatus?.payment_status ?? "";
  for (const row of details) {
    row.payment_status = paymentStatusLabel;
  }

  return {
    rows: details,
    paymentStatuses: paymentStatus ? [paymentStatus] : [],
  };
}

async function readUnbilledRows(
  scope: BrowserScope,
  cardFilters: string[],
): Promise<CsvRow[]> {
  const rows = unbilledDetailsTable(scope).locator("tr");
  const count = await rows.count();
  const details: CsvRow[] = [];
  let cardNumber = "";

  for (let index = 0; index < count; index += 1) {
    const cells = await readCells(rows.nth(index));
    if (!hasUsefulData(cells) || isHeaderRow(cells)) continue;

    if (isUnbilledCardLabelRow(cells)) {
      cardNumber = cells.find(Boolean) ?? "";
      continue;
    }

    if (cardNumber && !matchesFilter(cardNumber, cardFilters)) continue;
    if (!cardNumber && cardFilters.length > 0) continue;
    if (!isDateLike(cells[0] ?? "")) continue;

    details.push({
      statement_period: "unbilled",
      card_number: toAsciiDigits(cardNumber),
      card_label: toAsciiDigits(cardNumber),
      consume_date: cells[0] ?? "",
      description: cells[1] ?? "",
      posting_date: cells[2] ?? "",
      foreign_currency: cells[4] ?? "",
      foreign_amount: cells[5] ?? "",
      twd_amount: cells[6] ?? "",
    });
  }

  return details;
}

export async function runFubonCreditCardStatements(
  page: Page,
  input: FubonCreditCardStatementsInput,
): Promise<FubonCreditCardStatementsOutput> {
  await openStatementDetailsPage(page);

  const statementRows: CsvRow[] = [];
  const statementPeriods: string[] = [];
  const paymentStatuses: PaymentStatus[] = [];
  for (const periodOffset of input.periodOffsets) {
    const scope = await selectStatementPeriod(page, periodOffset);
    const periodLabel = await readStatementPeriodLabel(scope);
    statementPeriods.push(periodLabel);
    const statementResult = await readStatementRows(
      scope,
      periodLabel,
      input.statementCardLabels,
    );
    statementRows.push(...statementResult.rows);
    paymentStatuses.push(...statementResult.paymentStatuses);
  }

  const unbilledScope = await openUnbilledDetailsPage(page);
  const unbilledRows = await readUnbilledRows(
    unbilledScope,
    input.unbilledCardNumbers,
  );
  const sortedStatementRows = statementRows
    .slice()
    .sort(compareRowsByConsumeDateDesc);
  const sortedUnbilledRows = unbilledRows
    .slice()
    .sort(compareRowsByConsumeDateDesc);

  const billedStatements = await writeCsvWithMetadata(
    "billed-statements",
    sortedStatementRows,
    billedHeaders,
    paymentStatuses,
    statementPeriods,
  );
  const unbilledStatements = await writeCsvWithMetadata(
    "unbilled-statements",
    sortedUnbilledRows,
    unbilledHeaders,
    [],
    ["unbilled"],
  );

  return {
    periodOffsets: input.periodOffsets,
    statementPeriods,
    statementCards: unique(
      statementRows.map((row) => row.card_label).filter(Boolean),
    ),
    unbilledCards: unique(
      unbilledRows.map((row) => row.card_number).filter(Boolean),
    ),
    csvFiles: {
      billedStatements,
      unbilledStatements,
    },
  };
}

export default workflow("fubonCreditCardStatements", {
  credentials: ["fubon_user_id", "fubon_account", "fubon_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page, session } = ctx;
    const credentials = (input as typeof input & { credentials: FubonCredentials })
      .credentials;

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    await fillCreditCardLoginForm(page, credentials);

    console.log(
      "manual-auth-required: enter the CAPTCHA in the browser, then run `npx libretto resume --session " +
        session +
        "`.",
    );
    await pause(session);

    const loginFrame = await waitForFrame(page, "txnFrame");
    await activateControlWithoutPointer(loginFrame.locator("#btnLogin2"));

    if (
      await loginFrame
        .locator("#m1_inputOTP")
        .isVisible()
        .catch(() => false)
    ) {
      console.log(
        "manual-otp-required: complete OTP in the browser, then run `npx libretto resume --session " +
          session +
          "`.",
      );
      await pause(session);
    }

    await waitForSignedInState(page);
    return await runFubonCreditCardStatements(page, input);
  },
});
