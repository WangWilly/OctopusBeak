import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pause, workflow, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";

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

const csvFileSchema = z.object({
  path: z.string(),
  rows: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  periodOffsets: z.array(periodOffsetSchema),
  statementPeriods: z.array(z.string()),
  statementCards: z.array(z.string()),
  unbilledCards: z.array(z.string()),
  csvFiles: z.object({
    statementDetails: csvFileSchema,
    unbilledDetails: csvFileSchema,
  }),
});

const periodTabs = [
  { offset: 1, label: "本期" },
  { offset: 2, label: "前一期" },
  { offset: 3, label: "前二期" },
  { offset: 4, label: "前三期" },
  { offset: 5, label: "前四期" },
  { offset: 6, label: "前五期" },
] as const;

const statementHeaders = [
  "statement_period",
  "card_label",
  "consume_date",
  "description",
  "posting_date",
  "foreign_exchange_date_or_currency",
  "foreign_amount_or_location",
  "twd_amount",
] as const;

const unbilledHeaders = [
  "card_number",
  "consume_date",
  "description",
  "posting_date",
  "card_last_four",
  "foreign_currency",
  "foreign_amount",
  "twd_amount",
  "installment_action",
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

async function writeCsv(
  baseName: string,
  rows: CsvRow[],
  headers: readonly string[],
) {
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    "fubon-credit-card-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const path = join(downloadsDir, `${Date.now()}-${safeFilename(baseName)}`);
  const content = toCsv(rows, headers);
  await writeFile(path, content, "utf8");

  return {
    path,
    rows: rows.length,
    bytes: Buffer.byteLength(content, "utf8"),
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
      if ((await locator.count().catch(() => 0)) > 0) return scope;
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
      if ((await locator.count().catch(() => 0)) > 0) return scope;
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
        if ((await link.count().catch(() => 0)) === 0) continue;

        const href = await link.getAttribute("href");
        if (href && href !== "#" && !href.startsWith("javascript:")) {
          await scope.goto(new URL(href, BANK_ENTRY_URL).toString(), {
            waitUntil: "domcontentloaded",
          });
        } else {
          await link.click({ force: true });
        }
        return;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Could not find link "${text}".`);
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
  await headerFrame.locator("#menu_CCC").click({ force: true });

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

  await headerFrame
    .locator("a")
    .filter({ hasText: "登入" })
    .first()
    .click({ force: true });

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
  await clickLinkByClassOrText(
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
  await clickLinkByClassOrText(
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
    await tab.click({ timeout: 30_000 });

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
): Promise<CsvRow[]> {
  const rows = statementDetailsTable(scope).locator("tr");
  const count = await rows.count();
  const details: CsvRow[] = [];
  let cardLabel = "";

  for (let index = 0; index < count; index += 1) {
    const cells = await readCells(rows.nth(index));
    if (!hasUsefulData(cells) || isHeaderRow(cells)) continue;

    if (isStatementCardLabelRow(cells)) {
      cardLabel = cells.find(Boolean) ?? "";
      continue;
    }

    if (cardLabel && !matchesFilter(cardLabel, cardFilters)) continue;
    if (!cardLabel && cardFilters.length > 0) continue;

    details.push({
      statement_period: periodLabel,
      card_label: cardLabel,
      consume_date: cells[0] ?? "",
      description: cells[1] ?? "",
      posting_date: cells[2] ?? "",
      foreign_exchange_date_or_currency: cells[3] ?? "",
      foreign_amount_or_location: cells[4] ?? "",
      twd_amount: cells[5] ?? "",
    });
  }

  return details;
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

    details.push({
      card_number: cardNumber,
      consume_date: cells[0] ?? "",
      description: cells[1] ?? "",
      posting_date: cells[2] ?? "",
      card_last_four: cells[3] ?? "",
      foreign_currency: cells[4] ?? "",
      foreign_amount: cells[5] ?? "",
      twd_amount: cells[6] ?? "",
      installment_action: cells[7] ?? "",
    });
  }

  return details;
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
    await loginFrame.locator("#btnLogin2").click();

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

    await openStatementDetailsPage(page);

    const statementRows: CsvRow[] = [];
    const statementPeriods: string[] = [];
    for (const periodOffset of input.periodOffsets) {
      const scope = await selectStatementPeriod(page, periodOffset);
      const periodLabel = await readStatementPeriodLabel(scope);
      statementPeriods.push(periodLabel);
      statementRows.push(
        ...(await readStatementRows(
          scope,
          periodLabel,
          input.statementCardLabels,
        )),
      );
    }

    const unbilledScope = await openUnbilledDetailsPage(page);
    const unbilledRows = await readUnbilledRows(
      unbilledScope,
      input.unbilledCardNumbers,
    );

    const statementDetails = await writeCsv(
      "statement-details.csv",
      statementRows,
      statementHeaders,
    );
    const unbilledDetails = await writeCsv(
      "unbilled-details.csv",
      unbilledRows,
      unbilledHeaders,
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
        statementDetails,
        unbilledDetails,
      },
    };
  },
});
