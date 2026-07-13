import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Frame, Page } from "playwright";
import { z } from "zod";
import { captureCardRowCounts } from "../ledger/credit-card-capture.ts";

const BANK_ENTRY_URL = "https://ebank.esunbank.com.tw/index.jsp";

type EsunCredentials = {
  esun_user_id?: string;
  esun_account?: string;
  esun_password?: string;
};

type StatementKind = "unbilled" | "billed";
type GridState = { currentPage?: string; currentPageSize?: string };
type CaptureMetadata =
  | {
      snapshotMode: "full";
      captureId: string;
      capturedAt: string;
      captureKinds: ["billed", "unbilled"];
      completenessEvidence: Record<string, unknown>;
    }
  | {
      snapshotMode: "partial";
      completenessEvidence: Record<string, unknown>;
    };

type StatementRow = {
  statementPeriod: string;
  cardNumber: string;
  consumeDate: string;
  description: string;
  foreignCurrency: string;
  foreignAmount: string;
  paymentCurrency: string;
  twdAmount: string;
  paymentStatus: StatementKind;
};

const dateSchema = z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/);

const inputSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
});

const tableFileSchema = z.object({
  baseName: z.string(),
  kind: z.enum(["unbilled", "billed"]),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  periods: z.array(z.string()),
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  usedExistingSession: z.boolean(),
  count: z.number().int().nonnegative(),
  query: z.object({
    startDate: z.string(),
    endDate: z.string(),
  }),
  files: z.array(tableFileSchema),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type TableFile = z.infer<typeof tableFileSchema>;

const statementHeaders = [
  "statement_period",
  "card_number",
  "card_label",
  "consume_date",
  "description",
  "foreign_currency",
  "foreign_amount",
  "payment_currency",
  "twd_amount",
  "payment_status",
];

function requireCredential(
  credentials: EsunCredentials,
  name: keyof EsunCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
    );
  }
  return value;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}/${month}/${day}`;
}

function defaultStartDate(endDate: string): string {
  const [year, month, day] = endDate.split("/").map(Number);
  return `${year - 1}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

function createTimestampGenerator(): () => string {
  let lastTimestamp = 0;

  return () => {
    const timestamp = Date.now();
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    return String(lastTimestamp);
  };
}

function splitCurrencyAmount(value: string): { currency: string; amount: string } {
  const normalized = cleanText(value).replace(/,/g, "");
  const match = normalized.match(/^([A-Z]{3})\s*(.+)$/i);
  if (!match) return { currency: "", amount: normalized };
  return { currency: match[1].toUpperCase(), amount: match[2].trim() };
}

function consumeDateSortKey(row: StatementRow): string {
  return row.consumeDate.replace(/\D/g, "");
}

function compareRowsByConsumeDateDesc(
  left: StatementRow,
  right: StatementRow,
): number {
  return consumeDateSortKey(right).localeCompare(consumeDateSortKey(left));
}

export function esunCreditCardStatementKind(
  bankPaymentStatus: string,
): StatementKind | null {
  if (bankPaymentStatus === "未入帳") return "unbilled";
  if (bankPaymentStatus === "已入帳") return "billed";
  return null;
}

export function isEsunCompleteGrid({
  currentPage,
  currentPageSize,
}: GridState): boolean {
  return currentPage === "1" && currentPageSize === String(2_147_483_647);
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
  throw new Error(`Timed out waiting for frame ${name}`);
}

async function mainFrame(page: Page): Promise<Frame> {
  return await waitForFrame(page, "iframe1");
}

async function isSignedIn(page: Page): Promise<boolean> {
  const frame = page.frame({ name: "iframe1" });
  if (!frame) return false;
  return await frame
    .locator("a", { hasText: "登出" })
    .isVisible()
    .catch(() => false);
}

async function waitForSignedInState(page: Page): Promise<void> {
  const frame = await mainFrame(page);
  await frame.locator("a", { hasText: "登出" }).waitFor({ timeout: 60_000 });
}

async function acceptDuplicateLoginIfPresent(frame: Frame): Promise<void> {
  const confirmButton = frame
    .locator(".ui-dialog button, .ui-dialog a")
    .filter({ hasText: /確定|確認|是|OK/i })
    .first();
  if (await confirmButton.isVisible().catch(() => false)) {
    await confirmButton.click();
  }
}

async function fillLoginForm(
  page: Page,
  credentials: EsunCredentials,
): Promise<void> {
  await page.goto(BANK_ENTRY_URL);
  const frame = await mainFrame(page);
  await frame.locator("#loginform\\:linkCommand").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);

  const userId = requireCredential(credentials, "esun_user_id");
  const account = requireCredential(credentials, "esun_account");
  const password = requireCredential(credentials, "esun_password");
  const fields = [
    { label: "account", locator: frame.locator("#loginform\\:name"), value: account },
    {
      label: "password",
      locator: frame.locator("#loginform\\:pxsswd"),
      value: password,
    },
    {
      label: "user id",
      locator: frame.locator("#loginform\\:custid"),
      value: userId,
    },
  ];

  for (const field of fields) await field.locator.fill(field.value);
  for (const field of fields) {
    if ((await field.locator.inputValue()) !== field.value) {
      await field.locator.fill(field.value);
    }
    if ((await field.locator.inputValue()) !== field.value) {
      throw new Error(`ESun login ${field.label} field did not retain value`);
    }
  }
  await frame.locator("#loginform\\:linkCommand").click();
  await acceptDuplicateLoginIfPresent(frame);
  await waitForSignedInState(page);
}

async function openCreditCardStatementsPage(page: Page): Promise<Frame> {
  const frame = await mainFrame(page);
  const form = frame.locator("#fcm01004");
  if (await form.isVisible().catch(() => false)) return frame;

  // Use ESun's widget loader directly; the menu flyout can cover this link.
  await frame.evaluate(() => {
    const loader = (
      window as unknown as {
        _leftMenuLoadWidget?: (
          event: Event,
          taskId: string,
          appId: string,
          menuId: string,
        ) => void;
      }
    )._leftMenuLoadWidget;
    if (!loader) throw new Error("_leftMenuLoadWidget not found");
    loader(new Event("click"), "FCM01004", "FCM", "MFCM0202");
  });
  await frame.locator("#fcm01004\\:startDate").waitFor({ timeout: 60_000 });
  return frame;
}

async function queryStatements(
  page: Page,
  input: WorkflowInput,
): Promise<{ frame: Frame; startDate: string; endDate: string }> {
  const endDate = input.endDate ?? formatDate(new Date());
  const startDate = input.startDate ?? defaultStartDate(endDate);
  const frame = await openCreditCardStatementsPage(page);

  await frame.locator("#fcm01004\\:intervalrdo4").check();
  await frame.locator("#fcm01004\\:startDate").fill(startDate);
  await frame.locator("#fcm01004\\:endDate").fill(endDate);
  await frame.locator("#fcm01004\\:sortrdo2").check();
  await frame.locator("#fcm01004\\:linkCommand").click();
  await frame
    .locator("#fcm01004\\:gridList_0_DataGridBody")
    .waitFor({ timeout: 60_000 });

  return { frame, startDate, endDate };
}

async function gridState(frame: Frame): Promise<GridState> {
  const fields = frame.locator("input, select");
  let currentPage: string | undefined;
  let currentPageSize: string | undefined;
  const count = await fields.count();
  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index);
    const key =
      (await field.getAttribute("name")) ??
      (await field.getAttribute("id")) ??
      "";
    if (/currentpagesize/i.test(key)) {
      currentPageSize ??= await field.inputValue();
    } else if (/currentpage/i.test(key)) {
      currentPage ??= await field.inputValue();
    }
  }
  return {
    currentPage,
    currentPageSize,
  };
}

async function readStatementRows(
  frame: Frame,
  statementPeriod: string,
): Promise<StatementRow[]> {
  const table = frame.locator("#fcm01004\\:gridList_0_DataGridBody");
  const rows = await table.locator("tr").all();
  const statementRows: StatementRow[] = [];

  for (const row of rows.slice(1)) {
    const cells = (await row.locator("th, td").allTextContents()).map(cleanText);
    if (cells.length < 6 || cells[0] === "消費日期") continue;
    const paymentStatus = esunCreditCardStatementKind(cells[5] ?? "");
    if (!paymentStatus) continue;

    const charge = splitCurrencyAmount(cells[2] ?? "");
    const payment = splitCurrencyAmount(cells[3] ?? "");
    statementRows.push({
      statementPeriod,
      cardNumber: cells[4] ?? "",
      consumeDate: cells[0] ?? "",
      description: cells[1] ?? "",
      foreignCurrency: charge.currency,
      foreignAmount: charge.amount,
      paymentCurrency: payment.currency,
      twdAmount: payment.amount,
      paymentStatus,
    });
  }

  return statementRows;
}

function statementRowsToCsv(rows: StatementRow[]): string {
  const csvRows = [
    statementHeaders,
    ...[...rows].sort(compareRowsByConsumeDateDesc).map((row) => [
      row.statementPeriod,
      row.cardNumber,
      "",
      row.consumeDate,
      row.description,
      row.foreignCurrency,
      row.foreignAmount,
      row.paymentCurrency,
      row.twdAmount,
      row.paymentStatus,
    ]),
  ];
  return rowsToCsv(csvRows);
}

function statementKind(row: StatementRow): StatementKind {
  return row.paymentStatus;
}

function cardKeyForRow(row: StatementRow): string {
  return row.cardNumber.replace(/\D/g, "").slice(-4);
}

function downloadsDir(): string {
  return join(process.cwd(), "downloads", "esun-credit-card-statements");
}

async function writeStatementFile(
  nextTimestamp: () => string,
  kind: StatementKind,
  rows: StatementRow[],
  capture: CaptureMetadata,
  cardKeys: string[],
): Promise<TableFile> {
  const dir = downloadsDir();
  await mkdir(dir, { recursive: true });

  const baseName = `${kind}-statements-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(dir, csvFilename);
  const jsonPath = join(dir, jsonFilename);
  const periods = [
    ...new Set(rows.map((row) => row.statementPeriod).filter(Boolean)),
  ];

  await writeFile(csvPath, statementRowsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        schemaVersion: "download-table-metadata.v1",
        generatedAt: new Date().toISOString(),
        workflow: "esunCreditCardStatements",
        kind,
        csvFilename,
        jsonFilename,
        rowCount: rows.length,
        headers: statementHeaders,
        periods,
        paymentStatuses:
          kind === "billed"
            ? [...new Set(rows.map((row) => row.paymentStatus).filter(Boolean))]
            : [],
        ...capture,
        ...(capture.snapshotMode === "full"
          ? {
              cardRowCounts: captureCardRowCounts(
                cardKeys,
                rows.map((row) => ({ cardKey: cardKeyForRow(row) })),
              ),
            }
          : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    baseName,
    kind,
    rowCount: rows.length,
    headers: statementHeaders,
    periods,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

export default workflow("esunCreditCardStatements", {
  credentials: ["esun_user_id", "esun_account", "esun_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page } = ctx;
    const credentials = (input as typeof input & { credentials: EsunCredentials })
      .credentials;
    console.log("automation-progress: 0");

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    await page.goto(BANK_ENTRY_URL);
    console.log("automation-progress: 20");
    const authResult = await librettoAuthenticate(ctx, {
      credentials,
      isSignedIn: async ({ page: authPage }) => await isSignedIn(authPage),
      signIn: async ({ page: authPage }, signInCredentials) => {
        await fillLoginForm(authPage, signInCredentials as EsunCredentials);
      },
    });
    console.log("automation-progress: 40");

    const { frame, startDate, endDate } = await queryStatements(page, input);
    console.log("automation-progress: 60");
    const period = `${startDate} ~ ${endDate}`;
    const rows = await readStatementRows(frame, period);
    console.log("automation-progress: 80");
    const nextTimestamp = createTimestampGenerator();
    const unbilledRows = rows.filter(
      (row) => statementKind(row) === "unbilled",
    );
    const billedRows = rows.filter((row) => statementKind(row) === "billed");
    const cardKeys = [
      ...new Set([...billedRows, ...unbilledRows].map(cardKeyForRow).filter(Boolean)),
    ];
    const completeGrid = await gridState(frame);
    const isFullCapture =
      !input.startDate &&
      !input.endDate &&
      isEsunCompleteGrid(completeGrid) &&
      [...billedRows, ...unbilledRows].every(
        (row) => cardKeyForRow(row).length === 4,
      );
    const capture: CaptureMetadata = isFullCapture
      ? {
          snapshotMode: "full",
          captureId: randomUUID(),
          capturedAt: new Date().toISOString(),
          captureKinds: ["billed", "unbilled"],
          completenessEvidence: {
            bank: "esun",
            range: "default_one_year",
            grid: completeGrid,
          },
        }
      : {
          snapshotMode: "partial",
          completenessEvidence: {
            bank: "esun",
            reason:
              input.startDate || input.endDate
                ? "date_range_override"
                : "grid_not_proven_complete",
            grid: completeGrid,
          },
        };
    const files = [
      await writeStatementFile(
        nextTimestamp,
        "unbilled",
        unbilledRows,
        capture,
        cardKeys,
      ),
      await writeStatementFile(
        nextTimestamp,
        "billed",
        billedRows,
        capture,
        cardKeys,
      ),
    ];
    console.log("automation-progress: 100");

    return {
      usedExistingSession: authResult.usedProfile,
      count: files.length,
      query: { startDate, endDate },
      files,
    };
  },
});
