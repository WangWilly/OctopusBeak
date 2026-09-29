import { createHash } from "node:crypto";
import { POST_CAPTCHA_INPUT_SELECTOR, POST_CAPTCHA_INPUT_SEMANTIC_ID } from "../lib/automation/post-captcha.ts";
import type { Dialog, Locator, Page, Response } from "playwright";
import { z } from "zod";
import {
  SourceTextIntegrityError,
  strictSourceText,
  type SourceTextPort,
} from "../lib/automation/source-text.ts";
import type {
  HumanAssistanceCompletionStatus,
  HumanAssistanceContractInput,
} from "../lib/automation/human-assistance.ts";
import type {
  WorkflowContext,
  WorkflowFinancialCommitPort,
} from "../lib/automation/workflow-executor.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import {
  admitPostDomesticDepositCaptureEvidence,
  admitPostDomesticDepositFinancialCapture,
  createPostDomesticDepositSourceEvidence,
  isPostSourceOnlyFinancialDiagnostic,
  POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  derivePostDomesticDepositAccountNumberEvidence,
  type PostDomesticDepositCaptureEvidence,
  type PostDomesticDepositValidatedEvidence,
} from "../ledger/canonical/post-domestic-deposit-admission.ts";
import {
  getPostHumanAttestedV1Manifest,
} from "../ledger/canonical/post-human-attestation-contract.ts";
import { admitCurrentDepositBalanceCapture } from "../ledger/pglite/current-deposit-admission.ts";
import {
  buildPostCurrentDepositBalanceCapture,
  indexPostCurrentDepositFinancialCaptures,
  readPostCurrentDepositBalances,
  parsePostCurrentDepositBalanceSnapshot,
  POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
  POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  POST_CURRENT_DEPOSIT_BALANCE_HOST,
  POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT,
  POST_CURRENT_DEPOSIT_BALANCE_PAGE_URL,
  POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
  type ExistingPostCurrentDepositFinancialCapture,
  type PostCurrentDepositResponseMetadata,
} from "./post-current-deposit-balances.ts";
import {
  emitHumanAssistanceStage,
  type WorkflowHumanAssistanceStage,
} from "./human-assistance.ts";

const HOME_URL = "https://ipost.post.gov.tw/pst/home.html";
const INDEX_URL = "https://ipost.post.gov.tw/pst/index.html";
const DISPATCHER_PATH = "/pst/EsoafDispatcher";

const typedWorkflowInputSchema = z.object({
  credentials: z.object({
    post_user_id: z.string().trim().min(1),
    post_account: z.string().trim().min(1),
    post_password: z.string().trim().min(1),
  }),
});

export type PostCredentials = {
  post_user_id?: string;
  post_account?: string;
  post_password?: string;
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

export type PostQueriedStatement = {
  accountId: string;
  queryPeriods: string[];
  queryRange: { startDate: string; endDate: string };
  httpStatus: number;
  itemShape: "array" | "single" | "absent";
  rows: PostStatementRow[];
};

export type PostStatementResponseMetadata = Readonly<{
  url: string;
  status: number;
  method: string;
  contentType: string;
  requestPostData?: string | null;
}>;

export type PostWorkflowInput = z.infer<typeof typedWorkflowInputSchema>;
export type PostWorkflowOutput = Readonly<{
  accountCount: number;
  rowCount: number;
  status: "source-only" | "financial-admitted";
}>;

export type PostStatementsRunDependencies = {
  text?: SourceTextPort;
  signal?: AbortSignal;
  event?: WorkflowContext["event"];
  financialCommit: WorkflowFinancialCommitPort;
  collectSourceStatements?: (
    page: Page,
    text: SourceTextPort,
    signal?: AbortSignal,
    event?: WorkflowContext["event"],
  ) => Promise<PostQueriedStatement[]>;
  readCurrentDepositBalances?: typeof readPostCurrentDepositBalances;
  observedAt?: string;
};

function requireCredential(
  credentials: PostCredentials,
  name: keyof PostCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(`Missing credential ${name}. Configure it in the App credential settings.`);
  }
  return value;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  signal?: AbortSignal;
  onDialog?: (type: string) => void | Promise<void>;
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
  { submit, waitForSuccess, signal, onDialog }: PostLoginAttemptDependencies,
): Promise<void> {
  signal?.throwIfAborted();
  const probeAbortController = new AbortController();
  let rejectDialog!: (error: Error) => void;
  let abortListener: (() => void) | undefined;
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
    if (onDialog) {
      void Promise.resolve(onDialog(type)).catch(() => undefined);
    }
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
    const successSignal = signal
      ? AbortSignal.any([probeAbortController.signal, signal])
      : probeAbortController.signal;
    const successProbe = waitForSuccess(successSignal);
    void successProbe.catch(() => undefined);
    const cancellation = signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => {
            probeAbortController.abort();
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("Post login was cancelled."),
            );
          };
          signal.addEventListener("abort", abortListener, { once: true });
          if (signal.aborted) abortListener();
        })
      : undefined;
    const loginOutcome = (async () => {
      await submit();
      await successProbe;
    })();
    await Promise.race(
      cancellation
        ? [loginOutcome, dialogDetected, cancellation]
        : [loginOutcome, dialogDetected],
    );
  } finally {
    if (signal && abortListener)
      signal.removeEventListener("abort", abortListener);
    probeAbortController.abort();
    page.off("dialog", dialogHandler);
  }
}

export async function submitPostLoginAndWait(
  page: Page,
  signal?: AbortSignal,
  onDialog?: (type: string) => void | Promise<void>,
): Promise<void> {
  await runPostLoginAttempt(page, {
    ...(signal ? { signal } : {}),
    ...(onDialog ? { onDialog } : {}),
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

export function postCaptchaAssistanceStage(
  page: Page,
): WorkflowHumanAssistanceStage {
  const captchaInput = page.locator(POST_CAPTCHA_INPUT_SELECTOR).first();
  return {
    stageId: "ipost-login-captcha",
    title: "Enter the iPost CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: POST_CAPTCHA_INPUT_SEMANTIC_ID,
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

export async function dismissPostNoticeIfPresent(
  page: Page,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const closeButtons = page
    .locator('button.css_btn_class[ng-click="closeBox()"]:visible')
    .filter({ hasText: /^\s*關閉\s*$/ });
  const closeButton = closeButtons.first();
  if (!(await waitForSignal(
    closeButton.isVisible({ timeout: 2_000 }).catch(() => false),
    signal,
  ))) {
    return false;
  }

  try {
    await waitForSignal(closeButton.click({ timeout: 2_000 }), signal);
  } catch (error) {
    signal?.throwIfAborted();
    const remainingVisibleButtons = await closeButtons.count().catch(() => 1);
    if (remainingVisibleButtons > 0) throw error;
    return false;
  }
  await waitForSignal(page.waitForTimeout(250), signal);
  return true;
}

async function isSignedIn(page: Page): Promise<boolean> {
  return await page
    .locator(postDetailLinkSelector(true))
    .first()
    .isVisible()
    .catch(() => false);
}

export async function requestPostCaptchaAssistance(
  stage: WorkflowHumanAssistanceStage,
  request: (
    contract: HumanAssistanceContractInput,
    signal: AbortSignal,
  ) => Promise<HumanAssistanceCompletionStatus>,
  signal: AbortSignal,
): Promise<HumanAssistanceCompletionStatus> {
  signal.throwIfAborted();
  const contract = await emitHumanAssistanceStage(stage, (value) => value);
  const status = await request(contract, signal);
  signal.throwIfAborted();
  if (status !== "entered" && status !== "verified")
    throw new Error(`iPost human assistance ended with status ${status}.`);
  return status;
}

async function signInPostWithAssistance(
  page: Page,
  credentials: PostCredentials,
  requestHumanAssistance: (
    contract: HumanAssistanceContractInput,
    signal: AbortSignal,
  ) => Promise<HumanAssistanceCompletionStatus>,
  signal: AbortSignal,
  onDialog?: (type: string) => void | Promise<void>,
): Promise<void> {
  const { cifId, userCode, password } = postLoginFieldValues(credentials);
  signal.throwIfAborted();
  if (!postLoginEntryUrl(page.url()))
    await waitForSignal(
      page.goto(HOME_URL, { waitUntil: "domcontentloaded" }),
      signal,
    );
  await waitForSignal(
    page.locator("#cifID").waitFor({ state: "visible", timeout: 60_000 }),
    signal,
  );
  await dismissPostNoticeIfPresent(page, signal);
  await waitForSignal(page.locator("#cifID").fill(cifId), signal);
  await waitForSignal(page.locator("#userID_1_Input").fill(userCode), signal);
  await waitForSignal(page.locator("#userPWD_1_Input").fill(password), signal);
  await dismissPostNoticeIfPresent(page, signal);
  const captchaInput = page.locator(POST_CAPTCHA_INPUT_SELECTOR).first();
  await waitForSignal(captchaInput.focus(), signal);
  const assistanceUrl = page.url();
  const assistedCaptchaElement = await waitForSignal(
    captchaInput.elementHandle(),
    signal,
  );
  if (!assistedCaptchaElement)
    throw new Error("iPost CAPTCHA input is unavailable for assistance.");

  try {
    await requestPostCaptchaAssistance(
      postCaptchaAssistanceStage(page),
      requestHumanAssistance,
      signal,
    );
    signal.throwIfAborted();
    if (await isSignedIn(page)) return;
    const currentCaptchaInput = page.locator(POST_CAPTCHA_INPUT_SELECTOR).first();
    const sameCaptchaElement = await waitForSignal(
      currentCaptchaInput
        .evaluate(
          (current, assisted) => current === assisted,
          assistedCaptchaElement,
        )
        .catch(() => false),
      signal,
    );
    if (!postCaptchaGenerationUnchanged(assistanceUrl, page.url(), sameCaptchaElement))
      throw new Error(
        "iPost login document or CAPTCHA changed during assistance; start a fresh CAPTCHA assistance session.",
      );
    const currentCaptchaValue = await waitForSignal(
      currentCaptchaInput.inputValue(),
      signal,
    );
    if (!currentCaptchaValue.trim())
      throw new Error("iPost CAPTCHA is empty. Enter it in the browser before resuming.");
    await submitPostLoginAndWait(page, signal, onDialog);
    signal.throwIfAborted();
  } finally {
    await assistedCaptchaElement.dispose().catch(() => undefined);
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

async function openDetailPageWithSignal(
  page: Page,
  index: number,
  signal?: AbortSignal,
): Promise<void> {
  await waitForSignal(page.goto(INDEX_URL, { waitUntil: "domcontentloaded" }), signal);
  await waitForSignal(
    visibleDetailLinks(page)
      .first()
      .waitFor({ state: "visible", timeout: 60_000 }),
    signal,
  );
  await waitForSignal(visibleDetailLinks(page).nth(index).click(), signal);
  await waitForSignal(
    sixMonthDateLabel(page).waitFor({ state: "visible", timeout: 60_000 }),
    signal,
  );
}

function requireCompletePostStatementRows(
  items: unknown,
): PostRawStatementRow[] {
  const sourceRows = items === undefined
    ? []
    : Array.isArray(items)
      ? items
      : [items];
  return sourceRows.map((value) => {
    if (!isRecord(value))
      throw new Error("Post statement response contains a malformed transaction row.");
    for (const field of ["PRS_DATE", "TX_TIME", "TX_AMT", "BAL_AMT", "DR_FLG"] as const) {
      if (typeof value[field] !== "string" || cleanText(value[field]) === "")
        throw new Error("Post statement response contains an incomplete transaction row.");
    }
    if (value.DR_FLG !== "+" && value.DR_FLG !== "-")
      throw new Error("Post statement response contains an unsupported transaction direction.");
    for (const field of ["MEM", "ENGLISH_MEMO", "ADDITIONAL_MEMO_2", "ATTACH_COMMENT"] as const) {
      if (value[field] !== undefined && value[field] !== null && typeof value[field] !== "string")
        throw new Error("Post statement response contains a malformed transaction field.");
    }
    return value as PostRawStatementRow;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function waitForSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await operation;
  signal.throwIfAborted();
  let abortListener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("Post workflow was cancelled."),
    );
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  void operation.catch(() => undefined);
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export function parsePostStatementResponse(input: Readonly<{
  bytes: Uint8Array;
  response: PostStatementResponseMetadata;
  text?: SourceTextPort;
}>): PostQueriedStatement {
  let responseUrl: URL;
  try {
    responseUrl = new URL(input.response.url);
  } catch {
    throw new Error("Post statement response URL is invalid.");
  }
  if (
    responseUrl.protocol !== "https:" ||
    responseUrl.hostname !== "ipost.post.gov.tw" ||
    responseUrl.pathname !== DISPATCHER_PATH ||
    responseUrl.search !== "" ||
    responseUrl.hash !== "" ||
    responseUrl.port !== "" ||
    responseUrl.username !== "" ||
    responseUrl.password !== ""
  )
    throw new Error("Post statement response endpoint is unexpected.");
  if (input.response.method.toUpperCase() !== "POST")
    throw new Error("Post statement response method is not POST.");
  if (input.response.status !== 200)
    throw new Error("Post statement response was not terminal.");
  const contentType = input.response.contentType.trim();
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json")
    throw new Error("Post statement response content type is not JSON.");
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(
    contentType,
  )?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8")
    throw new Error("Post statement response charset is not UTF-8.");

  const text = input.text ?? strictSourceText;
  const decoded = text.decode(input.bytes, "utf-8");
  text.assertIntact(decoded);
  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch {
    throw new Error("Post statement response is not valid JSON.");
  }
  if (!Array.isArray(payload) || payload.length !== 2)
    throw new Error("Post statement response is incomplete.");
  const [screen, endBracket] = payload;
  if (
    !isRecord(screen) || !isRecord(screen.header) || !isRecord(screen.body) ||
    screen.header.EndBracket !== false || screen.header.OutputType !== "Screen" ||
    !isRecord(endBracket) || !isRecord(endBracket.header) ||
    !isRecord(endBracket.body) || endBracket.header.EndBracket !== false ||
    endBracket.header.OutputType !== "EndBracket" ||
    endBracket.body.result !== "success"
  )
    throw new Error("Post statement response is incomplete or nonterminal.");

  let request: unknown;
  try {
    request = JSON.parse(input.response.requestPostData ?? "");
  } catch {
    throw new Error("Post statement request metadata is invalid.");
  }
  if (
    !isRecord(request) || !isRecord(request.header) || !isRecord(request.body) ||
    request.header.TxnCode !== "EB100200" ||
    request.header.BizCode !== "inquire" ||
    typeof request.body._USER_ID !== "string" ||
    typeof request.body.DATE !== "string" ||
    typeof request.body.END_DATE !== "string"
  )
    throw new Error("Post statement request metadata is incomplete.");

  const hostRows = screen.body.host_rs_1;
  const items = isRecord(hostRows)
    ? hostRows.ITEM
    : undefined;
  const startDate = postProviderDate(request.body.DATE);
  const endDate = postProviderDate(request.body.END_DATE);
  const accountId = cleanText(request.body._USER_ID);
  return {
    accountId,
    queryPeriods: [`${startDate}~${endDate}`],
    queryRange: { startDate, endDate },
    httpStatus: input.response.status,
    itemShape:
      items === undefined
        ? "absent"
        : Array.isArray(items)
          ? "array"
          : "single",
    rows: postRowsToStatementRows(
      accountId,
      requireCompletePostStatementRows(items),
    ),
  };
}

async function queryCurrentStatement(
  page: Page,
  text: SourceTextPort = strictSourceText,
  signal?: AbortSignal,
) {
  if (!(await waitForSignal(sixMonthDateInput(page).isChecked(), signal))) {
    await waitForSignal(sixMonthDateLabel(page).click(), signal);
  }
  const responsePromise = page.waitForResponse(
    isEsoafResponse("EB100200", "inquire"),
    { timeout: 60_000 },
  );
  void responsePromise.catch(() => undefined);
  signal?.throwIfAborted();
  await waitForSignal(
    page
      .locator("a.css_btn_class:visible")
      .filter({ hasText: "查詢" })
      .first()
      .click(),
    signal,
  );
  const response = await waitForSignal(responsePromise, signal);
  signal?.throwIfAborted();
  const [body, headers] = await Promise.all([
    waitForSignal(response.body(), signal),
    response.allHeaders(),
  ]);
  return parsePostStatementResponse({
    bytes: body,
    response: {
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      contentType: headers["content-type"] ?? "",
      requestPostData: response.request().postData(),
    },
    text,
  });
}

async function collectPostStatementSources(
  page: Page,
  text: SourceTextPort = strictSourceText,
  signal?: AbortSignal,
  event?: WorkflowContext["event"],
): Promise<PostQueriedStatement[]> {
  signal?.throwIfAborted();
  await waitForSignal(
    page.goto(INDEX_URL, { waitUntil: "domcontentloaded" }),
    signal,
  );
  await waitForSignal(
    visibleDetailLinks(page)
      .first()
      .waitFor({ state: "visible", timeout: 60_000 }),
    signal,
  );
  const accountCount = await waitForSignal(visibleDetailLinks(page).count(), signal);
  if (accountCount === 0)
    throw new Error("No Post accounts are visible in the authenticated session.");
  await event?.("collection", "collection-started", {
    completed: 0,
    total: accountCount,
  });

  const statements: PostQueriedStatement[] = [];
  for (let index = 0; index < accountCount; index += 1) {
    signal?.throwIfAborted();
    await openDetailPageWithSignal(page, index, signal);
    await event?.("decoding", "source-decoding-started", {
      completed: index,
      total: accountCount,
    });
    let statement: PostQueriedStatement;
    try {
      statement = await queryCurrentStatement(page, text, signal);
    } catch (error) {
      await event?.(
        error instanceof SourceTextIntegrityError ? "decoding" : "validation",
        error instanceof SourceTextIntegrityError
          ? "source-decode-rejected"
          : "source-response-rejected",
        { completed: index, total: accountCount },
      );
      throw error;
    }
    signal?.throwIfAborted();
    await event?.("decoding", "source-decoding-completed", {
      completed: index + 1,
      total: accountCount,
    });
    statements.push(statement);
    await event?.("collection", "account-source-collected", {
      completed: index + 1,
      total: accountCount,
    });
  }
  return statements;
}

function isPostOverviewResponse(response: Response): boolean {
  const request = response.request();
  if (request.method() !== "POST") return false;
  let url: URL;
  let body: unknown;
  try {
    url = new URL(response.url());
    body = JSON.parse(request.postData() ?? "");
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === POST_CURRENT_DEPOSIT_BALANCE_HOST &&
    url.pathname === POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH &&
    url.search === "" &&
    url.hash === "" &&
    url.port === "" &&
    isRecord(body) &&
    isRecord(body.header) &&
    body.header.TxnCode === POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE &&
    body.header.BizCode === POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE &&
    isRecord(body.body) &&
    body.body.pageCount === POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT
  );
}

async function readPostCurrentDepositBalancesWithText(
  page: Page,
  text: SourceTextPort,
  signal: AbortSignal,
  input: Readonly<{ observedAt?: string; timeoutMs?: number }> = {},
) {
  const timeoutMs = input.timeoutMs ?? 60_000;
  signal.throwIfAborted();
  const pageUrl = new URL(POST_CURRENT_DEPOSIT_BALANCE_PAGE_URL);
  let currentUrl: URL | undefined;
  try {
    currentUrl = new URL(page.url());
  } catch {
    // Navigate to the known authenticated landing page below.
  }
  if (
    currentUrl?.origin !== pageUrl.origin ||
    currentUrl.pathname !== pageUrl.pathname
  ) {
    await waitForSignal(
      page.goto(POST_CURRENT_DEPOSIT_BALANCE_PAGE_URL, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      }),
      signal,
    );
  }
  signal.throwIfAborted();
  const overview = page.getByText("資產總覽", { exact: true }).first();
  await waitForSignal(
    overview.waitFor({ state: "visible", timeout: timeoutMs }),
    signal,
  );
  const responsePromise = page.waitForResponse(isPostOverviewResponse, {
    timeout: timeoutMs,
  });
  void responsePromise.catch(() => undefined);
  signal.throwIfAborted();
  await waitForSignal(overview.click(), signal);
  const response = await waitForSignal(responsePromise, signal);
  const [body, headers] = await Promise.all([
    waitForSignal(response.body(), signal),
    response.allHeaders(),
  ]);
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(
    headers["content-type"] ?? "",
  )?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8")
    throw new Error("Post current deposit response charset is not UTF-8.");
  const decoded = text.decode(body, "utf-8");
  text.assertIntact(decoded);
  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch {
    throw new Error("Post current deposit response is not valid JSON.");
  }
  const metadata: PostCurrentDepositResponseMetadata = {
    url: response.url(),
    status: response.status(),
    method: response.request().method(),
    headers,
    requestPostData: response.request().postData(),
  };
  return parsePostCurrentDepositBalanceSnapshot({
    payload,
    response: metadata,
    observedAt: input.observedAt,
  });
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
  const accountNumber = derivePostDomesticDepositAccountNumberEvidence(
    statement.accountId,
  );
  return {
    evidenceVersion: POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "post",
    product: "domestic-deposit",
    providerGuaranteed: false,
    observedAt,
    account: {
      value: statement.accountId,
      ...(accountNumber ? { accountNumber } : {}),
    },
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

async function runPostStatements(
  page: Page,
  overrides: PostStatementsRunDependencies,
): Promise<PostWorkflowOutput> {
  const text = overrides.text ?? strictSourceText;
  overrides.signal?.throwIfAborted();
  const statements = await (
    overrides.collectSourceStatements ?? collectPostStatementSources
  )(page, text, overrides.signal, overrides.event);
  if (statements.length === 0)
    throw new Error("No Post accounts reached a terminal source result.");
  const observedAt = overrides.observedAt ?? postObservedAt();
  const captures: PostDomesticDepositValidatedEvidence[] = [];
  for (const [index, statement] of statements.entries()) {
    overrides.signal?.throwIfAborted();
    const admission = admitPostDomesticDepositCaptureEvidence(
      buildPostDomesticDepositCapture(statement, observedAt),
    );
    if (admission.status !== "admissible" || !admission.capture)
      throw new Error(
        `Post domestic deposit source admission blocked: ${admission.diagnostics.join(", ")}`,
      );
    captures.push(admission.capture);
    await overrides.event?.("validation", "source-validation-completed", {
      completed: index + 1,
      total: statements.length,
    });
  }
  const readCurrent =
    overrides.readCurrentDepositBalances ?? readPostCurrentDepositBalances;
  const captureEntries = captures.map((capture, index) => ({
    capture,
    captureId: postCaptureId(observedAt, index),
  }));
  const sourceOnlyEntries: typeof captureEntries = [];
  const financialInputs: Array<{
    captureId: string;
    financialCapture: NonNullable<ReturnType<typeof admitPostDomesticDepositFinancialCapture>["capture"]>;
  }> = [];
  const financialCaptures: ExistingPostCurrentDepositFinancialCapture[] = [];
  const manifest = getPostHumanAttestedV1Manifest();
  for (const { capture, captureId } of captureEntries) {
    const input = {
      capture,
      captureId: `post-financial-${captureId}`,
      humanAttestation: manifest,
    };
    const admission = admitPostDomesticDepositFinancialCapture(input);
    if (admission.status !== "admitted" || !admission.capture) {
      const blocked = admission.diagnostics;
      if (!blocked.every(isPostSourceOnlyFinancialDiagnostic))
        throw new Error(
          `Post domestic deposit financial admission failed: ${[
            ...new Set(blocked),
          ].join(", ")}`,
        );
      sourceOnlyEntries.push({ capture, captureId });
      continue;
    }
    financialInputs.push({
      captureId: input.captureId,
      financialCapture: admission.capture,
    });
    financialCaptures.push({ identity: admission.capture.identity });
  }
  let status: PostWorkflowOutput["status"] = "source-only";
  if (financialInputs.length > 0) status = "financial-admitted";

  // The overview response is staged before opening the execution run. Each
  // row still commits only after its statement identity item has committed.
  const currentBalanceCaptures: ReturnType<typeof admitCurrentDepositBalanceCapture>[] = [];
  if (financialCaptures.length > 0) {
    await overrides.event?.("collection", "current-balance-collection-started");
    let currentRows: Awaited<ReturnType<typeof readCurrent>>;
    try {
      currentRows = await readCurrent(page, { observedAt });
    } catch (error) {
      await overrides.event?.("validation", "current-balance-rejected");
      throw error;
    }
    overrides.signal?.throwIfAborted();
    indexPostCurrentDepositFinancialCaptures(financialCaptures);
    for (const row of currentRows) {
      const matching = financialCaptures.find((candidate) => {
        const identity = candidate.identity;
        return (
          identity.stream === row.stream &&
          (identity.sourceAccountKey ?? identity.accountNo) === row.sourceAccountKey
        );
      });
      if (!matching)
        throw new Error(
          "Post current deposit snapshot contains an account without an existing admitted identity.",
        );
      currentBalanceCaptures.push(
        admitCurrentDepositBalanceCapture(
          buildPostCurrentDepositBalanceCapture(row, matching),
        ),
      );
    }
    await overrides.event?.("validation", "current-balance-validation-completed", {
      completed: currentBalanceCaptures.length,
      total: currentRows.length,
    });
  }

  overrides.signal?.throwIfAborted();
  const items = [
      ...sourceOnlyEntries.map((entry) => ({
        provider: "post", product: "domestic-deposit", itemKey: entry.captureId,
        command: {
          kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
          request: createPostDomesticDepositSourceEvidence(entry.capture, entry.captureId),
        },
      } as const)),
      ...financialInputs.map((entry) => ({
        provider: "post", product: "domestic-deposit", itemKey: entry.captureId,
        command: {
          kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
          request: { capture: entry.financialCapture },
        },
      } as const)),
      ...currentBalanceCaptures.map((capture) => ({
        provider: "post", product: "current-balance",
        itemKey: `current-balance:${capture.identity.sourceAccountKey}`,
        command: {
          kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
          request: currentDepositBalanceCommandRequest(capture),
        },
      } as const)),
  ];
  await overrides.event?.("commit", "canonical-commit-started", {
    completed: 0,
    total: items.length,
  });
  const committed = await overrides.financialCommit.execute(items, {
    provider: "post",
    product: "financial",
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  });
  if (committed.status !== "completed")
    throw new Error(
      `Post Canonical Financial Commit ${committed.status}: ${committed.diagnostics.map((diagnostic) => `${diagnostic.stage}/${diagnostic.errorCode}`).join(", ")}`,
    );
  await overrides.event?.("commit", "canonical-commit-completed", {
    completed: committed.committedCount,
    total: items.length,
  });
  return {
    accountCount: statements.length,
    rowCount: statements.reduce((sum, statement) => sum + statement.rows.length, 0),
    status,
  };
}

export async function runPostProviderWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
  overrides: Readonly<Pick<
    PostStatementsRunDependencies,
    "collectSourceStatements" | "readCurrentDepositBalances"
  >> = {},
): Promise<PostWorkflowOutput> {
  const parsed = typedWorkflowInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error("Chunghwa Post workflow sign-in details are missing or invalid.");
  if (!context.financialCommit)
    throw new Error("Canonical Financial Commit port is unavailable.");
  const financialCommit = context.financialCommit;
  context.signal.throwIfAborted();
  await context.event("authentication", "authentication-started");

  return await context.browser.withPage(async (page) => {
    await waitForSignal(
      page.goto(HOME_URL, { waitUntil: "domcontentloaded" }),
      context.signal,
    );
    const usedExistingSession = await isSignedIn(page);
    if (!usedExistingSession) {
      await signInPostWithAssistance(
        page,
        parsed.data.credentials,
        async (contract, signal) => {
          await context.event("authentication", "human-assistance-requested");
          const status = await context.humanAssistance.request(contract, signal);
          await context.event(
            "authentication",
            status === "entered" || status === "verified"
              ? "human-assistance-completed"
              : "human-assistance-failed",
          );
          return status;
        },
        context.signal,
        () => {
          void context.event("authentication", "login-dialog-interrupted");
        },
      );
    }
    context.signal.throwIfAborted();
    await context.event("authentication", "authentication-completed");

    const result = await runPostStatements(page, {
      text: context.text,
      signal: context.signal,
      event: context.event,
      financialCommit,
      observedAt: postObservedAt(new Date(context.now())),
      ...(overrides.collectSourceStatements
        ? { collectSourceStatements: overrides.collectSourceStatements }
        : {}),
      readCurrentDepositBalances: overrides.readCurrentDepositBalances ?? ((candidatePage, input) =>
        readPostCurrentDepositBalancesWithText(
          candidatePage,
          context.text,
          context.signal,
          input,
        )),
    });
    context.signal.throwIfAborted();
    return result;
  });
}
