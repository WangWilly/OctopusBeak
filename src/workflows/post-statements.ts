import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Locator, Page, Response } from "playwright";
import { z } from "zod";

const HOME_URL = "https://ipost.post.gov.tw/pst/home.html";
const INDEX_URL = "https://ipost.post.gov.tw/pst/index.html";
const DISPATCHER_PATH = "/pst/EsoafDispatcher";

const statementHeaders = [
  "帳務日期",
  "交易日期",
  "交易時間",
  "摘要",
  "支出金額",
  "存入金額",
  "即時餘額",
  "附註",
];

const inputSchema = z.object({
  captchaCode: z.string().regex(/^\d{4}$/).optional(),
});

const statementFileSchema = z.object({
  account: z.string(),
  accountId: z.string(),
  queryPeriods: z.array(z.string()),
  baseName: z.string(),
  csvFilename: z.string(),
  csvPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonFilename: z.string(),
  jsonPath: z.string(),
  jsonBytes: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  count: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  downloads: z.array(statementFileSchema),
});

export type PostCredentials = {
  post_user_id?: string;
  post_account?: string;
  post_password?: string;
};

type Input = z.infer<typeof inputSchema> & {
  credentials: PostCredentials;
};

type PostStatementOutput = z.infer<typeof outputSchema>;
type StatementDownload = PostStatementOutput["downloads"][number];

type EsoafEnvelope<T> = {
  header?: Record<string, unknown>;
  body?: T;
};

type PostDetailResponseBody = {
  host_rs_1?: {
    ITEM?: PostRawStatementRow[] | PostRawStatementRow;
  };
};

export type PostRawStatementRow = {
  PRS_DATE?: string;
  TX_TIME?: string;
  MEM?: string;
  ENGLISH_MEMO?: string;
  ADDITIONAL_MEMO_2?: string;
  ATTACH_COMMENT?: string;
  TX_AMT?: string;
  BAL_AMT?: string;
  DR_FLG?: string;
};

export type PostStatementRow = {
  accountId: string;
  sortKey: string;
  values: string[];
};

let lastTimestamp = 0;

function requireCredential(
  credentials: PostCredentials,
  name: keyof PostCredentials,
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
  return (value ?? "")
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function nextTimestamp(): string {
  const timestamp = Date.now();
  lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
  return String(lastTimestamp);
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function rocCompactDate(value: string | undefined): string {
  const clean = cleanText(value);
  const match = clean.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (!match) return clean;
  return `${Number(match[1]) + 1911}/${match[2]}/${match[3]}`;
}

function postTime(value: string | undefined): string {
  const clean = cleanText(value);
  const match = clean.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!match) return clean;
  return `${match[1]}:${match[2]}:${match[3]}`;
}

function amountFor(row: PostRawStatementRow, flag: "+" | "-"): string {
  return cleanText(row.DR_FLG) === flag ? cleanText(row.TX_AMT) : "";
}

function noteFor(row: PostRawStatementRow): string {
  return [
    cleanText(row.ATTACH_COMMENT),
    cleanText(row.ADDITIONAL_MEMO_2),
    cleanText(row.ENGLISH_MEMO),
  ]
    .filter(Boolean)
    .join(" ");
}

export function postRowsToStatementRows(
  accountId: string,
  rows: PostRawStatementRow[],
): PostStatementRow[] {
  return rows.map((row) => {
    const date = rocCompactDate(row.PRS_DATE);
    const time = postTime(row.TX_TIME);
    return {
      accountId,
      sortKey: `${date} ${time}`,
      values: [
        date,
        date,
        time,
        cleanText(row.MEM),
        amountFor(row, "-"),
        amountFor(row, "+"),
        cleanText(row.BAL_AMT),
        noteFor(row),
      ],
    };
  });
}

export function postStatementRowsToCsv(rows: PostStatementRow[]): string {
  return rowsToCsv([
    statementHeaders,
    ...[...rows]
      .sort((left, right) => right.sortKey.localeCompare(left.sortKey))
      .map((row) => row.values),
  ]);
}

function isEsoafResponse(txnCode: string, bizCode: string) {
  return (response: Response) => {
    const request = response.request();
    const body = request.postData() ?? "";
    return (
      request.method() === "POST" &&
      response.url().includes(DISPATCHER_PATH) &&
      body.includes(`"TxnCode":"${txnCode}"`) &&
      body.includes(`"BizCode":"${bizCode}"`)
    );
  };
}

export function postDetailLinkSelector(visibleOnly = false): string {
  return visibleOnly ? "a.btn_td_orange_dtl:visible" : "a.btn_td_orange_dtl";
}

function detailLinks(page: Page): Locator {
  return page.locator(postDetailLinkSelector());
}

function visibleDetailLinks(page: Page): Locator {
  return page.locator(postDetailLinkSelector(true));
}

function sixMonthDateInput(page: Page): Locator {
  return page.locator("#dateType_5");
}

function sixMonthDateLabel(page: Page): Locator {
  return page.locator('label[for="dateType_5"]');
}

export function postLoginFieldValues(credentials: PostCredentials) {
  return {
    cifId: requireCredential(credentials, "post_user_id"),
    userCode: requireCredential(credentials, "post_account"),
    password: requireCredential(credentials, "post_password"),
  };
}

function postIdLoginButton(page: Page): Locator {
  return page.locator("#tab1 .loginbtn a").filter({ hasText: "登入" });
}

export function postManualAuthMessage(session: string): string {
  return `manual-auth-required: enter the iPost CAPTCHA in the browser, then run \`npx libretto resume --session ${session}\`.`;
}

async function isSignedIn(page: Page): Promise<boolean> {
  return await page
    .locator(postDetailLinkSelector(true))
    .first()
    .isVisible()
    .catch(() => false);
}

async function signInPost(
  ctx: LibrettoWorkflowContext,
  credentials: PostCredentials,
  captchaCode: string | undefined,
): Promise<void> {
  const { page, session } = ctx;
  const { cifId, userCode, password } = postLoginFieldValues(credentials);

  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#cifID").waitFor({ state: "visible", timeout: 60_000 });
  await page.locator("#cifID").fill(cifId);
  await page.locator("#userID_1_Input").fill(userCode);
  await page.locator("#userPWD_1_Input").fill(password);
  const captchaInput = page.locator('input[name="captcha"]').first();
  await captchaInput.focus();

  if (captchaCode) {
    await captchaInput.fill(captchaCode);
    await postIdLoginButton(page).click();
  } else {
    console.log(postManualAuthMessage(session));
    await pause(session);
    if (await isSignedIn(page)) return;
    if (!(await captchaInput.inputValue()).trim()) {
      throw new Error("iPost CAPTCHA is empty. Enter it in the browser before resuming.");
    }
    await postIdLoginButton(page).click();
  }

  await visibleDetailLinks(page)
    .first()
    .waitFor({ state: "visible", timeout: 300_000 });
}

async function openDetailPage(page: Page, index: number): Promise<void> {
  await page.goto(INDEX_URL, { waitUntil: "domcontentloaded" });
  await visibleDetailLinks(page)
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  await visibleDetailLinks(page).nth(index).click();
  await sixMonthDateLabel(page).waitFor({ state: "visible", timeout: 60_000 });
}

function normalizeItems(items: PostRawStatementRow[] | PostRawStatementRow | undefined) {
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

async function queryCurrentStatement(page: Page) {
  if (!(await sixMonthDateInput(page).isChecked())) {
    await sixMonthDateLabel(page).click();
  }
  const responsePromise = page.waitForResponse(
    isEsoafResponse("EB100200", "inquire"),
    { timeout: 60_000 },
  );
  await page
    .locator("a.css_btn_class:visible")
    .filter({ hasText: "查詢" })
    .first()
    .click();
  const response = await responsePromise;
  const requestBody = JSON.parse(response.request().postData() ?? "{}") as {
    body?: { _USER_ID?: string; DATE?: string; END_DATE?: string };
  };
  const responseBody = (await response.json()) as EsoafEnvelope<PostDetailResponseBody>[];
  const accountId = cleanText(requestBody.body?._USER_ID);
  const rows = normalizeItems(responseBody[0]?.body?.host_rs_1?.ITEM);
  return {
    accountId,
    queryPeriods: [
      `${rocCompactDate(requestBody.body?.DATE)}~${rocCompactDate(requestBody.body?.END_DATE)}`,
    ],
    rows: postRowsToStatementRows(accountId, rows),
  };
}

async function writeStatementFile(
  accountId: string,
  queryPeriods: string[],
  rows: PostStatementRow[],
): Promise<StatementDownload> {
  const downloadsDir = join(process.cwd(), "downloads", "post-statements");
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `${safeFilename(accountId)}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const account = `${accountId} 郵局`;

  await writeFile(csvPath, postStatementRowsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        帳號: account,
        查詢期間: queryPeriods,
        分行名稱: "",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    account,
    accountId,
    queryPeriods,
    baseName,
    csvFilename,
    csvPath,
    csvBytes: csvStat.size,
    jsonFilename,
    jsonPath,
    jsonBytes: jsonStat.size,
    rowCount: rows.length,
  };
}

async function downloadPostStatements(
  page: Page,
): Promise<PostStatementOutput> {
  await page.goto(INDEX_URL, { waitUntil: "domcontentloaded" });
  await visibleDetailLinks(page)
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  const accountCount = await visibleDetailLinks(page).count();
  const downloads: StatementDownload[] = [];

  for (let index = 0; index < accountCount; index += 1) {
    await openDetailPage(page, index);
    const statement = await queryCurrentStatement(page);
    downloads.push(
      await writeStatementFile(
        statement.accountId,
        statement.queryPeriods,
        statement.rows,
      ),
    );
  }

  return {
    count: downloads.length,
    rowCount: downloads.reduce((sum, download) => sum + download.rowCount, 0),
    downloads,
  };
}

export default workflow("postStatements", {
  credentials: ["post_user_id", "post_account", "post_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as Input;
    const { page } = ctx;

    await librettoAuthenticate(ctx, {
      credentials: input.credentials,
      isSignedIn: async () => await isSignedIn(page),
      signIn: async () => {
        await signInPost(ctx, input.credentials, input.captchaCode);
      },
    });

    console.log("automation-progress: 25");
    const result = await downloadPostStatements(page);
    console.log("automation-progress: 100");
    return result;
  },
});
