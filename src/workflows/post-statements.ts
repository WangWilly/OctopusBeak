import { createHash } from "node:crypto";
import {
  POST_CAPTCHA_INPUT_SELECTOR,
  POST_CAPTCHA_INPUT_SEMANTIC_ID,
  POST_CAPTCHA_STAGE_ID,
} from "../lib/automation/post-captcha.ts";
import { POST_CREDENTIAL_FIELDS, POST_PRODUCTS, POST_SOURCE } from "../lib/automation/server/sources/post.ts";
import type { VerifiedRunInput, VerifiedWorkflowEntry } from "../lib/automation/server/verified-entry.ts";
import { taipeiInstant } from "../lib/time/timezone.ts";
import type { ElementHandle, Locator, Page, Response } from "playwright";
import {
  SourceTextIntegrityError,
  strictSourceText,
  type SourceTextPort,
} from "../lib/automation/source-text.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import type { ProductCollectionHandle, ProductCollectionSummary } from "../lib/automation/product-collection.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import { PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import {
  admitPostDomesticDepositCaptureEvidence,
  admitPostDomesticDepositFinancialCapture,
  POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  derivePostDomesticDepositAccountNumberEvidence,
  type PostDomesticDepositCaptureEvidence,
  type PostDomesticDepositValidatedEvidence,
} from "../ledger/canonical/post-domestic-deposit-admission.ts";
import {
  POST_HUMAN_ATTESTED_V1_MANIFEST,
} from "../ledger/canonical/post-human-attestation-contract.ts";
import { withAbort } from "./abort.ts";
import { frameScope, type FrameScope } from "./frame-scope.ts";
import { signIn, type FormPlan } from "./sign-in.ts";
import {
  captureCurrentStateSnapshots,
  type CurrentStateSnapshotDeclaration,
} from "./current-state-snapshot-capture.ts";
import {
  buildPostCurrentDepositBalanceCapture,
  postCurrentBalanceCaptureMatching,
  parsePostCurrentDepositBalanceSnapshot,
  POST_CURRENT_DEPOSIT_RESPONSE,
  readPostCurrentDepositBalanceResponse,
  type ExistingPostCurrentDepositFinancialCapture,
  type PostCurrentDepositBalanceRow,
  type PostCurrentDepositResponse,
} from "./post-current-deposit-balances.ts";
import type { VerificationStage } from "../lib/automation/verification-stage.ts";

const HOME_URL = "https://ipost.post.gov.tw/pst/home.html";
const INDEX_URL = "https://ipost.post.gov.tw/pst/index.html";
const DISPATCHER_PATH = "/pst/EsoafDispatcher";

type PostVerifiedInput = VerifiedRunInput<typeof POST_CREDENTIAL_FIELDS, typeof POST_PRODUCTS>;
export type PostCredentials = PostVerifiedInput["credentials"];

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

export type PostWorkflowInput = PostVerifiedInput;

/** Every account's terminal statement read from iPost, and when the read began (ADR 0065). */
export type PostDepositSourceSnapshot = Readonly<{
  observedAt: string;
  statements: readonly PostQueriedStatement[];
}>;

/** Observe the asset-overview response; the snapshot module decodes and parses it. */
export type PostReadCurrentDepositBalanceResponse = () => Promise<PostCurrentDepositResponse>;

const postCurrentBalanceSnapshot: CurrentStateSnapshotDeclaration<
  PostCurrentDepositResponse,
  PostCurrentDepositBalanceRow,
  ExistingPostCurrentDepositFinancialCapture,
  "optional"
> = {
  product: "current-balance",
  response: POST_CURRENT_DEPOSIT_RESPONSE,
  parse: (decoded, response, acquired) => parsePostCurrentDepositBalanceSnapshot({
    payload: decoded.value,
    response,
    requestPostData: acquired.requestPostData,
  }),
  matching: postCurrentBalanceCaptureMatching,
  build: buildPostCurrentDepositBalanceCapture,
};

type PostProductRunner = (
  page: Page,
  input: PostWorkflowInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
) => Promise<ProductCollectionSummary>;

export type PostWorkflowDependencies = Readonly<{
  collectDeposit?: PostProductRunner;
}>;

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
    cifId: credentials.post_user_id,
    userCode: credentials.post_account,
    password: credentials.post_password,
  };
}

function postIdLoginButton(page: Page): Locator {
  return page.locator("#tab1 .loginbtn a").filter({ hasText: "登入" });
}

export function postCaptchaAssistanceStage(
  page: Page,
): VerificationStage {
  const captchaInput = page.locator(POST_CAPTCHA_INPUT_SELECTOR).first();
  return {
    stageId: POST_CAPTCHA_STAGE_ID,
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
  // isVisible ignores its timeout; iPost opens this notice about a second
  // after the login form, over the CAPTCHA image.
  const appeared = await withAbort(
    closeButton.waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false),
    signal,
  );
  if (!appeared || !(await withAbort(closeButton.isVisible().catch(() => false), signal))) {
    return false;
  }

  try {
    await withAbort(closeButton.click({ timeout: 2_000 }), signal);
  } catch (error) {
    signal?.throwIfAborted();
    const remainingVisibleButtons = await closeButtons.count().catch(() => 1);
    if (remainingVisibleButtons > 0) throw error;
    return false;
  }
  await withAbort(page.waitForTimeout(250), signal);
  return true;
}

async function isSignedIn(page: Page): Promise<boolean> {
  return await page
    .locator(postDetailLinkSelector(true))
    .first()
    .isVisible()
    .catch(() => false);
}

function captchaInput(page: Page): Locator {
  return page.locator(POST_CAPTCHA_INPUT_SELECTOR).first();
}

export function postSignInPlan(credentials: PostCredentials): FormPlan {
  const { cifId, userCode, password } = postLoginFieldValues(credentials);
  // The CAPTCHA the stage solved must be the one submitted: the stage and submit share this snapshot.
  let assisted: Readonly<{ url: string; element: ElementHandle }> | undefined;
  return {
    signedIn: (scope) => isSignedIn(scope.page),
    fill: async ({ page, signal }) => {
      if (!postLoginEntryUrl(page.url()))
        await withAbort(page.goto(HOME_URL, { waitUntil: "domcontentloaded" }), signal);
      await withAbort(page.locator("#cifID").waitFor({ state: "visible", timeout: 60_000 }), signal);
      await dismissPostNoticeIfPresent(page, signal);
      await withAbort(page.locator("#cifID").fill(cifId), signal);
      await withAbort(page.locator("#userID_1_Input").fill(userCode), signal);
      await withAbort(page.locator("#userPWD_1_Input").fill(password), signal);
      await dismissPostNoticeIfPresent(page, signal);
      await withAbort(captchaInput(page).focus(), signal);
    },
    captcha: {
      stage: async (page) => {
        const element = await captchaInput(page).elementHandle();
        if (!element) throw new Error("iPost CAPTCHA input is unavailable for assistance.");
        assisted = { url: page.url(), element };
        return postCaptchaAssistanceStage(page);
      },
      answer: captchaInput,
    },
    submit: async ({ page, signal }) => {
      if (!assisted) throw new Error("iPost CAPTCHA assistance did not run before submit.");
      const sameElement = await withAbort(
        captchaInput(page)
          .evaluate((current, element) => current === element, assisted.element)
          .catch(() => false),
        signal,
      );
      await assisted.element.dispose().catch(() => undefined);
      if (!postCaptchaGenerationUnchanged(assisted.url, page.url(), sameElement))
        throw new Error(
          "iPost login document or CAPTCHA changed during assistance; start a fresh CAPTCHA assistance session.",
        );
      await withAbort(postIdLoginButton(page).click(), signal);
    },
    dialogs: "fail",
    session: { none: "needs live verification" },
    timeoutMs: 300_000,
  };
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

async function openDetailPage(scope: FrameScope, index: number): Promise<void> {
  const { page } = scope;
  await scope.withSignal((signal) => page.goto(INDEX_URL, { waitUntil: "domcontentloaded", signal }));
  await scope.withSignal((signal) =>
    visibleDetailLinks(page).first().waitFor({ state: "visible", timeout: 60_000, signal }));
  await scope.withSignal((signal) => visibleDetailLinks(page).nth(index).click({ signal }));
  await scope.withSignal((signal) =>
    sixMonthDateLabel(page).waitFor({ state: "visible", timeout: 60_000, signal }));
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

async function queryCurrentStatement(scope: FrameScope, text: SourceTextPort) {
  const { page } = scope;
  if (!(await scope.withSignal((signal) => sixMonthDateInput(page).isChecked({ signal })))) {
    await scope.withSignal((signal) => sixMonthDateLabel(page).click({ signal }));
  }
  const responsePromise = scope.withSignal((signal) =>
    page.waitForResponse(isEsoafResponse("EB100200", "inquire"), { timeout: 60_000, signal }));
  void responsePromise.catch(() => undefined);
  await scope.withSignal((signal) =>
    page.locator("a.css_btn_class:visible").filter({ hasText: "查詢" }).first().click({ signal }));
  const response = await responsePromise;
  const [body, headers] = await scope.race(Promise.all([response.body(), response.allHeaders()]));
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

/** Read every visible account's statement from iPost: the only part of the deposit run that touches the page. */
export async function readPostDepositSource(
  page: Page,
  _input: PostWorkflowInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<PostDepositSourceSnapshot> {
  const observedAt = taipeiInstant(context.now());
  const statements = await collectPostStatementSources(
    frameScope(page, context.signal),
    context.text,
    product.event,
  );
  return { observedAt, statements };
}

async function collectPostStatementSources(
  scope: FrameScope,
  text: SourceTextPort,
  event: ProductCollectionHandle["event"],
): Promise<PostQueriedStatement[]> {
  const { page, signal } = scope;
  await scope.withSignal((signal) => page.goto(INDEX_URL, { waitUntil: "domcontentloaded", signal }));
  await scope.withSignal((signal) =>
    visibleDetailLinks(page).first().waitFor({ state: "visible", timeout: 60_000, signal }));
  const accountCount = await scope.race(visibleDetailLinks(page).count());
  if (accountCount === 0)
    throw new Error("No Post accounts are visible in the authenticated session.");
  await event("collection", "started", "collection-started", {
    completed: 0,
    total: accountCount,
  });

  const statements: PostQueriedStatement[] = [];
  for (let index = 0; index < accountCount; index += 1) {
    await openDetailPage(scope, index);
    await event("decoding", "started", "source-decoding-started", {
      completed: index,
      total: accountCount,
    });
    let statement: PostQueriedStatement;
    try {
      statement = await queryCurrentStatement(scope, text);
    } catch (error) {
      await event(
        error instanceof SourceTextIntegrityError ? "decoding" : "validation",
        "failed",
        error instanceof SourceTextIntegrityError
          ? "source-decode-rejected"
          : "source-response-rejected",
        { completed: index, total: accountCount },
      );
      throw error;
    }
    signal.throwIfAborted();
    await event("decoding", "advanced", "source-decoding-completed", {
      completed: index + 1,
      total: accountCount,
    });
    statements.push(statement);
    await event("collection", "advanced", "account-source-collected", {
      completed: index + 1,
      total: accountCount,
    });
  }
  return statements;
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

/** Admit a read snapshot, read current balances for the admitted accounts, and stage both. */
export async function stagePostDeposit(
  snapshot: PostDepositSourceSnapshot,
  _input: PostWorkflowInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
  readCurrentBalanceResponse: PostReadCurrentDepositBalanceResponse,
): Promise<ProductCollectionSummary> {
  const { observedAt, statements } = snapshot;
  if (statements.length === 0)
    throw new Error("No Post accounts reached a terminal source result.");
  const captures: PostDomesticDepositValidatedEvidence[] = [];
  for (const [index, statement] of statements.entries()) {
    context.signal.throwIfAborted();
    const admission = admitPostDomesticDepositCaptureEvidence(
      buildPostDomesticDepositCapture(statement, observedAt),
    );
    if (admission.status !== "admissible" || !admission.capture)
      throw new Error(
        `Post domestic deposit source admission blocked: ${admission.diagnostics.join(", ")}`,
      );
    captures.push(admission.capture);
    await product.event("validation", "advanced", "source-validation-completed", {
      completed: index + 1,
      total: statements.length,
    });
  }
  const captureEntries = captures.map((capture, index) => ({
    capture,
    captureId: postCaptureId(observedAt, index),
  }));
  const financialInputs: Array<{
    captureId: string;
    financialCapture: NonNullable<ReturnType<typeof admitPostDomesticDepositFinancialCapture>["capture"]>;
  }> = [];
  const financialCaptures: ExistingPostCurrentDepositFinancialCapture[] = [];
  const manifest = POST_HUMAN_ATTESTED_V1_MANIFEST;
  for (const { capture, captureId } of captureEntries) {
    const input = {
      capture,
      captureId: `post-financial-${captureId}`,
      humanAttestation: manifest,
    };
    const admission = admitPostDomesticDepositFinancialCapture(input);
    if (admission.status !== "admitted" || !admission.capture)
      throw new Error(
        `Post domestic deposit financial admission failed: ${[
          ...new Set(admission.diagnostics),
        ].join(", ")}`,
      );
    financialInputs.push({
      captureId: input.captureId,
      financialCapture: admission.capture,
    });
    financialCaptures.push({ identity: admission.capture.identity });
  }
  // The overview response is staged before opening the execution run. Each
  // row still commits only after its statement identity item has committed.
  const balances = await captureCurrentStateSnapshots(postCurrentBalanceSnapshot, {
    captures: financialCaptures,
    acquire: readCurrentBalanceResponse,
    now: () => context.now(),
    product,
    text: context.text,
    signal: context.signal,
  });

  context.signal.throwIfAborted();
  product.stage(
    ...financialInputs.map((entry) => ({
      product: "domestic-deposit", itemKey: entry.captureId,
      command: {
        kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
        request: { capture: entry.financialCapture },
      },
    } as const)),
    ...balances.items,
  );
  return {
    sourceCaptureCount: statements.length,
    rowCount: statements.reduce((sum, statement) => sum + statement.rows.length, 0),
  };
}

async function runPostDeposit(
  page: Page,
  input: PostWorkflowInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<ProductCollectionSummary> {
  const snapshot = await readPostDepositSource(page, input, context, product);
  return await stagePostDeposit(
    snapshot,
    input,
    context,
    product,
    () => readPostCurrentDepositBalanceResponse(page, { signal: context.signal }),
  );
}

export type PostWorkflowEntry = VerifiedWorkflowEntry<
  "financialCommit" | "products",
  PostWorkflowInput,
  WorkflowRunResult,
  never,
  PostVerifiedInput
>;

/** Chunghwa Post's entry with its deposit runner replaced, for checks that run without a bank page. */
export function postWorkflowWith(overrides: PostWorkflowDependencies): PostWorkflowEntry {
  return {
    parseInput: (verified) => verified,
    run: (context, input) => runPostWorkflow(context, input, overrides),
  };
}

export const postWorkflow = postWorkflowWith({});

async function runPostWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products">,
  input: PostWorkflowInput,
  overrides: PostWorkflowDependencies,
): Promise<WorkflowRunResult> {
  const collectDeposit = overrides.collectDeposit ?? runPostDeposit;

  return await context.browser.withPage(async (page) => {
    await signIn(context, page, POST_SOURCE, postSignInPlan(input.credentials));

    let accountCount = 0;
    const summary = await context.products.collect({
      deposit: async (product): Promise<ProductCollectionSummary> => {
        const collected = await collectDeposit(page, input, context, product);
        // Every admitted account is one source capture.
        accountCount = collected.sourceCaptureCount;
        return collected;
      },
    });
    return productRunResult(summary, { counts: { accountCount } });
  });
}
