import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Dialog, Locator, Page, Response } from "playwright";
import { z } from "zod";
import {
  admitPostDomesticDepositCaptureEvidence,
  admitPostDomesticDepositFinancialCapture,
  commitCanonicalPostDomesticDepositCaptureBatch,
  commitPostDomesticDepositSourceEvidenceBatch,
  isPostSourceOnlyFinancialDiagnostic,
  POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  type PostDomesticDepositCaptureEvidence,
  type PostDomesticDepositValidatedEvidence,
} from "../ledger/canonical/post-domestic-deposit.ts";
import type { CanonicalFinancialDepositWriterStore } from "../ledger/canonical/canonical-financial-deposit-writer.ts";
import { getPostHumanAttestedV1Manifest } from "../ledger/canonical/post-human-attestation.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import {
  emitHumanAssistanceStage,
  type WorkflowHumanAssistanceStage,
} from "./human-assistance.ts";

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
  captchaCode: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  telemetry: z.boolean().default(false),
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
  sourceCaptureCount: z.number().int().nonnegative(),
  status: z.enum(["source-only", "financial-admitted"]),
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
  directionFlag: "inflow" | "outflow" | "unknown";
};

type PostQueriedStatement = {
  accountId: string;
  queryPeriods: string[];
  queryRange: { startDate: string; endDate: string };
  httpStatus: number;
  itemShape: "array" | "single" | "absent";
  requestDateShapes?: { start: string; end: string };
  rows: PostStatementRow[];
};

type PostCollectedStatement = PostQueriedStatement & {
  download: StatementDownload;
};

export type PostStatementsRunDependencies = {
  collectStatements?: (
    page: Page,
    telemetry: boolean,
  ) => Promise<PostCollectedStatement[]>;
  canonicalSourceLedgerDir?: string;
  canonicalFinancialLedgerDir?: string;
  observedAt?: string;
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

export function postProviderDateShape(value: string | undefined): string {
  const clean = cleanText(value);
  if (/^\d{8}$/.test(clean)) return "gregorian-compact";
  if (/^\d{7}$/.test(clean)) return "roc-compact";
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(clean)) return "gregorian-slash";
  if (/^\d{3}\/\d{2}\/\d{2}$/.test(clean)) return "roc-slash";
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return "gregorian-dash";
  if (/^\d{3}-\d{2}-\d{2}$/.test(clean)) return "roc-dash";
  return clean === "" ? "empty" : `other-${clean.length}`;
}

export function postProviderDate(value: string | undefined): string {
  const clean = cleanText(value);
  const shape = postProviderDateShape(clean);
  if (shape === "gregorian-compact")
    return `${clean.slice(0, 4)}/${clean.slice(4, 6)}/${clean.slice(6, 8)}`;
  if (shape === "roc-compact")
    return `${Number(clean.slice(0, 3)) + 1911}/${clean.slice(3, 5)}/${clean.slice(5, 7)}`;
  if (shape === "gregorian-slash") return clean;
  if (shape === "roc-slash" || shape === "roc-dash") {
    const [year, month, day] = clean.split(/[/-]/);
    return `${Number(year) + 1911}/${month}/${day}`;
  }
  if (shape === "gregorian-dash") return clean.replaceAll("-", "/");
  return clean;
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
    const date = postProviderDate(row.PRS_DATE);
    const time = postTime(row.TX_TIME);
    return {
      accountId,
      sortKey: `${date} ${time}`,
      directionFlag:
        cleanText(row.DR_FLG) === "+"
          ? "inflow"
          : cleanText(row.DR_FLG) === "-"
            ? "outflow"
            : "unknown",
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

const POST_LOGIN_WAIT_TIMEOUT_MS = 300_000;

type PostLoginAttemptDependencies = {
  submit: () => Promise<void>;
  waitForSuccess: (signal: AbortSignal) => Promise<void>;
};

const postLoginDialogError = () =>
  new Error(
    "iPost login was interrupted by a browser dialog; verify the login fields and CAPTCHA, then retry.",
  );

/**
 * Submit the iPost login form and wait for the signed-in landing page.
 *
 * iPost may optionally open a browser dialog immediately after the click. A
 * Playwright dialog blocks the page until it is handled, so keep the handler
 * scoped to this login attempt and race it against the normal success probe.
 * The dialog is intentionally not classified as a CAPTCHA rejection here:
 * the first version only prevents the browser session from hanging and lets
 * the caller report a normal login failure.
 */
export async function runPostLoginAttempt(
  page: Page,
  { submit, waitForSuccess }: PostLoginAttemptDependencies,
): Promise<void> {
  const probeAbortController = new AbortController();
  let rejectDialog!: (error: Error) => void;
  const dialogDetected = new Promise<never>((_resolve, reject) => {
    rejectDialog = reject;
  });
  const dialogHandler = (dialog: Dialog): void => {
    let type = "unknown";
    try {
      type = dialog.type();
    } catch {
      // Keep dialog cleanup fail-closed if the browser closes it concurrently.
    }
    console.warn("ipost-login-dialog", { type });
    void dialog.dismiss().then(
      () => {
        probeAbortController.abort();
        rejectDialog(postLoginDialogError());
      },
      () => {
        probeAbortController.abort();
        rejectDialog(postLoginDialogError());
      },
    );
  };

  page.on("dialog", dialogHandler);
  try {
    const successProbe = waitForSuccess(probeAbortController.signal);
    void successProbe.catch(() => undefined);
    const loginOutcome = (async () => {
      await submit();
      await successProbe;
    })();
    await Promise.race([loginOutcome, dialogDetected]);
  } finally {
    probeAbortController.abort();
    page.off("dialog", dialogHandler);
  }
}

export async function submitPostLoginAndWait(page: Page): Promise<void> {
  await runPostLoginAttempt(page, {
    submit: async () => {
      await postIdLoginButton(page).click();
    },
    waitForSuccess: (signal) =>
      visibleDetailLinks(page)
        .first()
        .waitFor({
          state: "visible",
          timeout: POST_LOGIN_WAIT_TIMEOUT_MS,
          signal,
        }),
  });
}

export function postManualAuthMessage(session: string): string {
  return `manual-auth-required: enter the iPost CAPTCHA in the browser, then run \`npx libretto resume --session ${session}\`.`;
}

export function postCaptchaAssistanceStage(
  page: Page,
): WorkflowHumanAssistanceStage {
  const captchaInput = page.locator('input[name="captcha"]:visible').first();
  return {
    stageId: "ipost-login-captcha",
    title: "Enter the iPost CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "post.login.captcha-input",
        modes: ["click", "type"],
        locator: captchaInput,
      },
    ],
    contextRegions: [
      {
        id: "captcha-challenge",
        label: "CAPTCHA challenge and instructions",
        semanticId: "post.login.captcha-challenge",
      },
    ],
    challengeKind: "text-captcha",
    charset: "digits",
    imagePreprocessing: ["remove-interference-lines"],
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-line" },
      { ocrPageSegmentationMode: "single-word" },
    ],
    solveAcceptancePolicy: {
      mode: "confidence-or-agreement",
      conflictResolution: "reject",
    },
    expectedAnswerLength: 4,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "post.login.captcha-image",
      locator: page.locator(".codes_img img:visible").first(),
    },
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: {
      targetId: "captcha-input",
      contextRegionIds: ["captcha-challenge"],
      initialZoom: 1.15,
    },
  };
}

export async function dismissPostNoticeIfPresent(page: Page): Promise<boolean> {
  const closeButton = page
    .getByRole("button", {
      name: "關閉",
      exact: true,
    })
    .first();
  if (!(await closeButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
    return false;
  }

  await closeButton.click({ force: true });
  await page.waitForTimeout(250);
  return true;
}

async function isSignedIn(page: Page): Promise<boolean> {
  return await page
    .locator(postDetailLinkSelector(true))
    .first()
    .isVisible()
    .catch(() => false);
}

export async function withPostAssistanceDeadline<T>(
  label: string,
  operation: Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `iPost browser stopped responding during ${label}; start a fresh CAPTCHA assistance session.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function signInPost(
  ctx: LibrettoWorkflowContext,
  credentials: PostCredentials,
  captchaCode: string | undefined,
): Promise<void> {
  const { page, session } = ctx;
  const { cifId, userCode, password } = postLoginFieldValues(credentials);

  if (!postLoginEntryUrl(page.url()))
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#cifID").waitFor({ state: "visible", timeout: 60_000 });
  await dismissPostNoticeIfPresent(page);
  await page.locator("#cifID").fill(cifId);
  await page.locator("#userID_1_Input").fill(userCode);
  await page.locator("#userPWD_1_Input").fill(password);
  await dismissPostNoticeIfPresent(page);
  const captchaInput = page.locator('input[name="captcha"]:visible').first();
  await captchaInput.focus();

  if (captchaCode) {
    await captchaInput.fill(captchaCode);
    await submitPostLoginAndWait(page);
  } else {
    const assistanceUrl = page.url();
    const assistedCaptchaElement = await captchaInput.elementHandle();
    if (!assistedCaptchaElement)
      throw new Error("iPost CAPTCHA input is unavailable for assistance.");
    await emitHumanAssistanceStage(postCaptchaAssistanceStage(page));
    console.log(postManualAuthMessage(session));
    await pause(session);
    if (
      await withPostAssistanceDeadline(
        "the signed-in state probe",
        isSignedIn(page),
      )
    ) {
      await assistedCaptchaElement.dispose();
      return;
    }
    const currentCaptchaInput = page.locator('input[name="captcha"]').first();
    const sameCaptchaElement = await withPostAssistanceDeadline(
      "the CAPTCHA generation probe",
      currentCaptchaInput
        .evaluate(
          (current, assisted) => current === assisted,
          assistedCaptchaElement,
        )
        .catch(() => false),
    );
    await assistedCaptchaElement.dispose();
    if (
      !postCaptchaGenerationUnchanged(
        assistanceUrl,
        page.url(),
        sameCaptchaElement,
      )
    ) {
      throw new Error(
        "iPost login document or CAPTCHA changed during assistance; start a fresh CAPTCHA assistance session.",
      );
    }
    const currentCaptchaValue = await withPostAssistanceDeadline(
      "the CAPTCHA completion probe",
      currentCaptchaInput.inputValue(),
    );
    if (!currentCaptchaValue.trim()) {
      throw new Error(
        "iPost CAPTCHA is empty. Enter it in the browser before resuming.",
      );
    }
    await submitPostLoginAndWait(page);
  }
}

export function postLoginEntryUrl(href: string): boolean {
  try {
    const current = new URL(href);
    const entry = new URL(HOME_URL);
    return (
      current.origin === entry.origin && current.pathname === entry.pathname
    );
  } catch {
    return false;
  }
}

export function postCaptchaGenerationUnchanged(
  beforeUrl: string,
  afterUrl: string,
  sameElement: boolean,
): boolean {
  return beforeUrl === afterUrl && sameElement;
}

async function openDetailPage(page: Page, index: number): Promise<void> {
  await page.goto(INDEX_URL, { waitUntil: "domcontentloaded" });
  await visibleDetailLinks(page)
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  await visibleDetailLinks(page).nth(index).click();
  await sixMonthDateLabel(page).waitFor({ state: "visible", timeout: 60_000 });
}

function normalizeItems(
  items: PostRawStatementRow[] | PostRawStatementRow | undefined,
) {
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
  const responseBody =
    (await response.json()) as EsoafEnvelope<PostDetailResponseBody>[];
  const accountId = cleanText(requestBody.body?._USER_ID);
  const items = responseBody[0]?.body?.host_rs_1?.ITEM;
  const rows = normalizeItems(items);
  const startDate = postProviderDate(requestBody.body?.DATE);
  const endDate = postProviderDate(requestBody.body?.END_DATE);
  return {
    accountId,
    queryPeriods: [`${startDate}~${endDate}`],
    queryRange: { startDate, endDate },
    httpStatus: response.status(),
    requestDateShapes: {
      start: postProviderDateShape(requestBody.body?.DATE),
      end: postProviderDateShape(requestBody.body?.END_DATE),
    },
    itemShape:
      items === undefined
        ? "absent"
        : Array.isArray(items)
          ? "array"
          : "single",
    rows: postRowsToStatementRows(accountId, rows),
  } satisfies PostQueriedStatement;
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

async function collectPostStatements(
  page: Page,
  telemetry: boolean,
): Promise<PostCollectedStatement[]> {
  await page.goto(INDEX_URL, { waitUntil: "domcontentloaded" });
  await visibleDetailLinks(page)
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  const accountCount = await visibleDetailLinks(page).count();
  const statements: PostCollectedStatement[] = [];

  for (let index = 0; index < accountCount; index += 1) {
    await openDetailPage(page, index);
    const statement = await queryCurrentStatement(page);
    const download = await writeStatementFile(
      statement.accountId,
      statement.queryPeriods,
      statement.rows,
    );
    statements.push({ ...statement, download });
  }
  if (telemetry) {
    const directionCounts = statements
      .flatMap((statement) => statement.rows)
      .reduce(
        (counts, row) => {
          counts[row.directionFlag] += 1;
          return counts;
        },
        { inflow: 0, outflow: 0, unknown: 0 },
      );
    console.log("post-domestic-deposit-telemetry", {
      accountCount,
      rowCount: statements.reduce(
        (sum, statement) => sum + statement.rows.length,
        0,
      ),
      itemShapes: statements.reduce<Record<string, number>>(
        (counts, statement) => {
          counts[statement.itemShape] = (counts[statement.itemShape] ?? 0) + 1;
          return counts;
        },
        {},
      ),
      directionCounts,
      queryRangeShapes: statements.map((statement) => ({
        start: /^\d{4}\/\d{2}\/\d{2}$/.test(statement.queryRange.startDate)
          ? "slash-date"
          : "other",
        end: /^\d{4}\/\d{2}\/\d{2}$/.test(statement.queryRange.endDate)
          ? "slash-date"
          : "other",
      })),
      requestDateShapes: statements.map(
        (statement) =>
          statement.requestDateShapes ?? {
            start: "not-observed",
            end: "not-observed",
          },
      ),
    });
  }
  return statements;
}

function postObservedAt(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

export function buildPostDomesticDepositCapture(
  statement: PostQueriedStatement,
  observedAt: string,
): PostDomesticDepositCaptureEvidence {
  return {
    evidenceVersion: POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "post",
    product: "domestic-deposit",
    providerGuaranteed: false,
    observedAt,
    account: { value: statement.accountId },
    queryRange: statement.queryRange,
    response: {
      httpStatus: statement.httpStatus,
      itemShape: statement.itemShape,
      rows: statement.rows.map((row, rowOrdinal) => ({
        rowOrdinal,
        values: [...row.values],
        directionFlag: row.directionFlag,
      })),
      terminal: true,
    },
    provenance: {
      source: "ipost-esoaf-eb100200-inquire",
      responseBodyRetained: false,
      semantics: "unresolved",
    },
  };
}

function postCaptureId(observedAt: string, index: number): string {
  return `post-source-${createHash("sha256")
    .update(`post-source-capture-v1\0${observedAt}\0${index}`)
    .digest("hex")
    .slice(0, 24)}-${Date.now()}-${index}`;
}

export async function runPostStatements(
  page: Page,
  telemetry: boolean,
  overrides: PostStatementsRunDependencies = {},
): Promise<PostStatementOutput> {
  const collect = overrides.collectStatements ?? collectPostStatements;
  const statements = await collect(page, telemetry);
  if (statements.length === 0)
    throw new Error("No Post accounts reached a terminal source result.");
  const observedAt = overrides.observedAt ?? postObservedAt();
  const captures: PostDomesticDepositValidatedEvidence[] = [];
  for (const statement of statements) {
    const admission = admitPostDomesticDepositCaptureEvidence(
      buildPostDomesticDepositCapture(statement, observedAt),
    );
    if (admission.status !== "admissible" || !admission.capture)
      throw new Error(
        `Post domestic deposit source admission blocked: ${admission.diagnostics.join(", ")}`,
      );
    captures.push(admission.capture);
  }
  const sourceLedgerDir =
    overrides.canonicalSourceLedgerDir ??
    process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
    process.env.LEDGER_DIR ??
    DEFAULT_LEDGER_DIR;
  const store = createCanonicalSourceStore(
    canonicalSqlitePath(sourceLedgerDir),
  );
  const financialLedgerDir = overrides.canonicalFinancialLedgerDir;
  const financialDatabasePath = financialLedgerDir
    ? canonicalSqlitePath(financialLedgerDir)
    : null;
  const financialStore = financialDatabasePath
    ? financialDatabasePath === canonicalSqlitePath(sourceLedgerDir)
      ? store
      : createCanonicalSourceStore(financialDatabasePath)
    : null;
  const financialWriter: CanonicalFinancialDepositWriterStore | null =
    financialStore
      ? {
          db: financialStore.db,
          databasePath: financialStore.databasePath,
          commitClock: () => financialStore.commitClock(),
        }
      : null;
  const financialUsesSourceStore = financialStore === store;
  const captureEntries = captures.map((capture, index) => ({
    capture,
    captureId: postCaptureId(observedAt, index),
  }));
  let status: PostStatementOutput["status"] = "source-only";
  try {
    if (!financialWriter || !financialUsesSourceStore)
      await commitPostDomesticDepositSourceEvidenceBatch(store, captureEntries);
    if (financialWriter) {
      const manifest = getPostHumanAttestedV1Manifest();
      const financialInputs = captureEntries.map(({ capture, captureId }) => ({
        capture,
        captureId: `post-financial-${captureId}`,
        humanAttestation: manifest,
      }));
      const admissions = financialInputs.map(
        admitPostDomesticDepositFinancialCapture,
      );
      const blocked = admissions.flatMap((admission) => admission.diagnostics);
      if (blocked.length > 0) {
        if (financialUsesSourceStore)
          await commitPostDomesticDepositSourceEvidenceBatch(
            store,
            captureEntries,
          );
        if (!blocked.every(isPostSourceOnlyFinancialDiagnostic))
          throw new Error(
            `Post domestic deposit financial admission failed: ${[
              ...new Set(blocked),
            ].join(", ")}`,
          );
      } else {
        await commitCanonicalPostDomesticDepositCaptureBatch(
          financialWriter,
          financialInputs,
        );
        status = "financial-admitted";
      }
    }
  } finally {
    if (financialStore && !financialUsesSourceStore) financialStore.close();
    store.close();
  }
  const downloads = statements.map((statement) => statement.download);
  return {
    count: downloads.length,
    rowCount: downloads.reduce((sum, download) => sum + download.rowCount, 0),
    downloads,
    sourceCaptureCount: captures.length,
    status,
  };
}

export default workflow("postStatements", {
  startUrl: HOME_URL,
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
    const result = await runPostStatements(page, input.telemetry, {
      canonicalFinancialLedgerDir:
        process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR,
    });
    console.log("automation-progress: 100");
    return result;
  },
});
