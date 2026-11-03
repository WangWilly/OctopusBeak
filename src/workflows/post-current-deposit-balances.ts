import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../ledger/canonical/canonical-digest.ts";
import type { Page, Response } from "playwright";
import {
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
} from "../ledger/pglite/current-deposit-admission.ts";
import { parseProviderDecimal, type ProviderDecimalPolicy } from "../lib/shared-money/exact-money.ts";
import { frameScope } from "./frame-scope.ts";
import {
  isDeclaredProviderResponse,
  type CurrentBalanceCaptureMatching,
  type ProviderResponse,
  type ProviderResponseDeclaration,
  type SnapshotEvidence,
  type VerifiedProviderResponse,
} from "./current-state-snapshot-capture.ts";

/**
 * iPost's asset overview is a normal authenticated page.  Its click handler
 * sends this generic dispatcher request; the request discriminants are the
 * only request details retained by this adapter.
 */
export const POST_CURRENT_DEPOSIT_BALANCE_HOST = "ipost.post.gov.tw" as const;
export const POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH =
  "/pst/EsoafDispatcher" as const;
export const POST_CURRENT_DEPOSIT_BALANCE_PAGE_URL =
  "https://ipost.post.gov.tw/pst/index.html" as const;
export const POST_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION =
  "post/current-deposit-balance-v1" as const;
export const POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE = "EB100103" as const;
export const POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE =
  "getOverViewById" as const;
export const POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT = 50 as const;

type JsonRecord = Record<string, unknown>;

export type PostCurrentDepositExactInteger = Readonly<{
  coefficient: string;
  scale: 0;
  /** The provider BAL string after surrounding whitespace cleanup only. */
  sourceLexeme: string;
}>;

/**
 * The EsoafDispatcher POST. HTTP Date is optional because the EndBracket's
 * SERVER_TIMESTAMP may carry the provider time instead.
 */
export const POST_CURRENT_DEPOSIT_RESPONSE: ProviderResponseDeclaration<"optional"> = {
  label: "Post current deposit",
  host: POST_CURRENT_DEPOSIT_BALANCE_HOST,
  endpoints: [{
    path: POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
    method: "POST",
    contentType: /^application\/json(?:\s*;|$)/iu,
  }],
  cacheControl: ["no-store"],
  providerDate: "optional",
};

export type PostCurrentDepositBalanceRow = Readonly<{
  source: "post";
  stream: "domestic-deposit";
  /** The complete fourteen-digit ACT_NO, including leading zeroes. */
  accountNumber: string;
  sourceAccountKey: string;
  currency: "TWD";
  /** Only the PS row's BAL becomes the ledger observation. */
  ledger: PostCurrentDepositExactInteger;
  effectiveAt: string;
  effectiveTimeBasis: "provider-http-date" | "provider-system-time";
  effectiveTimeSourceField: "HTTP Date" | "SERVER_TIMESTAMP";
  effectiveTimeSourceValue: string;
  providerHttpDate?: string;
  providerServerTimestamp?: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH;
    status: 200;
    contentType: string;
    cacheControl: string;
    txnCode: typeof POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE;
    bizCode: typeof POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE;
    pageCount: typeof POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT;
    contractVersion: typeof POST_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION;
  }>;
}>;

export type ExistingPostCurrentDepositFinancialCapture = Readonly<{
  identity: Readonly<{
    integrationNamespace: string;
    sourceConnectionKey: string;
    identityEpochKey: string;
    stream: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
    accountNumber?: Readonly<{ value: string }> | null;
    currency: string | null;
  }>;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: string): string {
  return value.replace(/[\u00a0\u3000]/gu, " ").trim();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new Error(`Post current deposit ${label} must be a string.`);
  const text = cleanText(value);
  if (text === "")
    throw new Error(`Post current deposit ${label} is blank.`);
  return text;
}

function parseServerTimestamp(value: unknown): {
  raw: string;
  effectiveAt: string;
  milliseconds: number;
} | null {
  if (value === undefined || value === null) return null;
  const raw = requiredString(value, "SERVER_TIMESTAMP");
  if (!/^\d{10}$/u.test(raw))
    throw new Error("Post current deposit SERVER_TIMESTAMP must be epoch seconds.");
  const seconds = Number(raw);
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(milliseconds))
    throw new Error("Post current deposit SERVER_TIMESTAMP is invalid.");
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime()))
    throw new Error("Post current deposit SERVER_TIMESTAMP is invalid.");
  return { raw, effectiveAt: date.toISOString(), milliseconds };
}

function providerTime(
  httpDate: VerifiedProviderResponse<"optional">["providerDate"],
  serverTimestamp: unknown,
): {
  effectiveAt: string;
  effectiveTimeBasis: PostCurrentDepositBalanceRow["effectiveTimeBasis"];
  effectiveTimeSourceField: PostCurrentDepositBalanceRow["effectiveTimeSourceField"];
  effectiveTimeSourceValue: string;
  providerHttpDate?: string;
  providerServerTimestamp?: string;
} {
  const serverTime = parseServerTimestamp(serverTimestamp);
  if (!httpDate && !serverTime)
    throw new Error(
      "Post current deposit response has no supported provider timestamp.",
    );
  if (
    httpDate &&
    serverTime &&
    Math.abs(Date.parse(httpDate.effectiveAt) - serverTime.milliseconds) > 10_000
  )
    throw new Error(
      "Post current deposit provider timestamps disagree by more than ten seconds.",
    );
  if (httpDate) {
    return {
      effectiveAt: httpDate.effectiveAt,
      effectiveTimeBasis: "provider-http-date",
      effectiveTimeSourceField: "HTTP Date",
      effectiveTimeSourceValue: httpDate.raw,
      providerHttpDate: httpDate.raw,
      ...(serverTime ? { providerServerTimestamp: serverTime.raw } : {}),
    };
  }
  return {
    effectiveAt: serverTime!.effectiveAt,
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeSourceField: "SERVER_TIMESTAMP",
    effectiveTimeSourceValue: serverTime!.raw,
    providerServerTimestamp: serverTime!.raw,
  };
}

/** The request body is parsed for its discriminants and never returned. */
function requireRequest(requestPostData: string | null): {
  txnCode: typeof POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE;
  bizCode: typeof POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE;
  pageCount: typeof POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT;
} {
  if (typeof requestPostData !== "string" || requestPostData.trim() === "")
    throw new Error("Post current deposit request body is missing.");
  let request: unknown;
  try {
    request = JSON.parse(requestPostData);
  } catch {
    throw new Error("Post current deposit request body is not valid JSON.");
  }
  if (!isRecord(request))
    throw new Error("Post current deposit request body is not an object.");
  if (!isRecord(request.header))
    throw new Error("Post current deposit request header is missing.");
  if (request.header.TxnCode !== POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE)
    throw new Error("Post current deposit request TxnCode is unexpected.");
  if (request.header.BizCode !== POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE)
    throw new Error("Post current deposit request BizCode is unexpected.");
  if (!isRecord(request.body) || request.body.pageCount !== POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT)
    throw new Error("Post current deposit request pageCount is unexpected.");
  return {
    txnCode: POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
    bizCode: POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
    pageCount: POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT,
  };
}

const POST_AMOUNT: ProviderDecimalPolicy = {
  internalWhitespace: "reject",
  grouping: "none",
  digits: "integer",
};

function parseExactInteger(
  value: unknown,
  label: string,
): PostCurrentDepositExactInteger {
  const sourceLexeme = requiredString(value, label);
  const amount = parseProviderDecimal(sourceLexeme, POST_AMOUNT);
  if (!amount)
    throw new Error(`Post current deposit ${label} must be an exact integer string.`);
  return { coefficient: amount.coefficient, scale: 0, sourceLexeme };
}

function parseScreenAndEndBracket(
  payload: unknown,
): {
  itemList: readonly JsonRecord[];
  serverTimestamp?: string;
} {
  if (!Array.isArray(payload) || payload.length !== 2)
    throw new Error("Post current deposit response must contain Screen and EndBracket envelopes.");
  const screen = payload[0];
  const endBracket = payload[1];
  if (!isRecord(screen) || !isRecord(screen.header) || !isRecord(screen.body))
    throw new Error("Post current deposit Screen envelope is malformed.");
  if (screen.header.EndBracket !== false || screen.header.OutputType !== "Screen")
    throw new Error("Post current deposit Screen envelope discriminant is unexpected.");
  if (!Array.isArray(screen.body.itemList))
    throw new Error("Post current deposit Screen itemList is missing.");
  if (!screen.body.itemList.every(isRecord))
    throw new Error("Post current deposit Screen itemList contains a malformed row.");
  if (!isRecord(endBracket) || !isRecord(endBracket.header) || !isRecord(endBracket.body))
    throw new Error("Post current deposit EndBracket envelope is malformed.");
  if (
    endBracket.header.EndBracket !== false ||
    endBracket.header.OutputType !== "EndBracket" ||
    endBracket.body.result !== "success"
  )
    throw new Error("Post current deposit EndBracket success discriminant is invalid.");
  let serverTimestamp: string | undefined;
  if (endBracket.header.OutputData !== undefined) {
    if (!isRecord(endBracket.header.OutputData))
      throw new Error("Post current deposit EndBracket timestamp is malformed.");
    if (endBracket.header.OutputData.SERVER_TIMESTAMP !== undefined)
      serverTimestamp = requiredString(
        endBracket.header.OutputData.SERVER_TIMESTAMP,
        "SERVER_TIMESTAMP",
      );
  }
  return {
    itemList: screen.body.itemList,
    serverTimestamp,
  };
}

/**
 * Parse one complete EB100103 response.  Unsupported account categories are
 * ignored after their discriminator is checked; only PS rows can establish a
 * current domestic-deposit ledger balance.
 */
export function parsePostCurrentDepositBalanceSnapshot(input: Readonly<{
  payload: unknown;
  response: VerifiedProviderResponse<"optional">;
  requestPostData: string | null;
}>): readonly PostCurrentDepositBalanceRow[] {
  const request = requireRequest(input.requestPostData);
  const { itemList, serverTimestamp } = parseScreenAndEndBracket(input.payload);
  const time = providerTime(input.response.providerDate, serverTimestamp);
  if (itemList.length === 0)
    throw new Error("Post current deposit response itemList is empty.");
  const rows: PostCurrentDepositBalanceRow[] = [];
  const seen = new Set<string>();
  for (const [index, item] of itemList.entries()) {
    const accountType = requiredString(
      item.ACT_TYPE,
      `itemList[${index}].ACT_TYPE`,
    );
    if (accountType !== "PS") continue;
    const accountNumber = requiredString(
      item.ACT_NO,
      `itemList[${index}].ACT_NO`,
    );
    if (!/^\d{14}$/u.test(accountNumber))
      throw new Error(
        `Post current deposit itemList[${index}].ACT_NO must be a fourteen-digit account number.`,
      );
    if (seen.has(accountNumber))
      throw new Error("Post current deposit response contains a duplicate PS account.");
    seen.add(accountNumber);
    const ledger = parseExactInteger(item.BAL, `itemList[${index}].BAL`);
    rows.push({
      source: "post",
      stream: "domestic-deposit",
      accountNumber,
      sourceAccountKey: accountNumber,
      currency: "TWD",
      ledger,
      effectiveAt: time.effectiveAt,
      effectiveTimeBasis: time.effectiveTimeBasis,
      effectiveTimeSourceField: time.effectiveTimeSourceField,
      effectiveTimeSourceValue: time.effectiveTimeSourceValue,
      ...(time.providerHttpDate ? { providerHttpDate: time.providerHttpDate } : {}),
      ...(time.providerServerTimestamp
        ? { providerServerTimestamp: time.providerServerTimestamp }
        : {}),
      observedAt: input.response.observedAt,
      sourceEvidence: {
        endpoint: POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
        status: 200,
        contentType: input.response.contentType,
        cacheControl: input.response.cacheControl,
        txnCode: request.txnCode,
        bizCode: request.bizCode,
        pageCount: request.pageCount,
        contractVersion: POST_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
      },
    });
  }
  if (rows.length === 0)
    throw new Error("Post current deposit response contains no PS account.");
  return rows;
}

function requestMatchesCurrentBalanceDiscriminants(response: Response): boolean {
  const postData = response.request().postData();
  if (!postData) return false;
  try {
    const request: unknown = JSON.parse(postData);
    return (
      isRecord(request) &&
      isRecord(request.header) &&
      request.header.TxnCode === POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE &&
      request.header.BizCode === POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE &&
      isRecord(request.body) &&
      request.body.pageCount === POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT
    );
  } catch {
    return false;
  }
}

function isPostIndexUrl(href: string): boolean {
  try {
    const current = new URL(href);
    const expected = new URL(POST_CURRENT_DEPOSIT_BALANCE_PAGE_URL);
    return (
      current.origin === expected.origin &&
      current.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

/** The asset-overview response iPost's page triggers, before decoding. */
export type PostCurrentDepositResponse = Readonly<{
  evidence: Extract<SnapshotEvidence, { kind: "json" }>;
  response: ProviderResponse;
  /** The request body is parsed for its discriminants and never returned. */
  requestPostData: string | null;
}>;

/**
 * Enter the authenticated asset-overview page and passively observe its POST.
 * The snapshot module decodes the body as UTF-8, so a response declaring any
 * other charset is refused here, before its bytes are decoded.
 */
export async function readPostCurrentDepositBalanceResponse(
  page: Page,
  input: Readonly<{ signal: AbortSignal; timeoutMs?: number }>,
): Promise<PostCurrentDepositResponse> {
  const scope = frameScope(page, input.signal);
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!isPostIndexUrl(page.url())) {
    await scope.withSignal((signal) =>
      page.goto(POST_CURRENT_DEPOSIT_BALANCE_PAGE_URL, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
        signal,
      }));
  }
  const overview = page.getByText("資產總覽", { exact: true }).first();
  await scope.withSignal((signal) => overview.waitFor({ state: "visible", timeout: timeoutMs, signal }));
  const responsePromise = scope.withSignal((signal) =>
    page.waitForResponse((response) =>
      isDeclaredProviderResponse(POST_CURRENT_DEPOSIT_RESPONSE, response.url(), response.request().method()) &&
      requestMatchesCurrentBalanceDiscriminants(response), { timeout: timeoutMs, signal }));
  void responsePromise.catch(() => undefined);
  await scope.withSignal((signal) => overview.click({ signal }));
  const response = await responsePromise;
  const [bytes, headers] = await scope.race(Promise.all([response.body(), response.allHeaders()]));
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(
    headers["content-type"] ?? "",
  )?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8")
    throw new Error("Post current deposit response charset is not UTF-8.");
  return {
    evidence: { kind: "json", bytes },
    response: {
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      headers,
    },
    requestPostData: response.request().postData(),
  };
}

/**
 * Join a PS row to an already admitted Post financial account.  This function
 * never creates identity keys from a current-summary row.
 */
export function buildPostCurrentDepositBalanceCapture(
  row: PostCurrentDepositBalanceRow,
  financialCapture: ExistingPostCurrentDepositFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const identity = financialCapture.identity;
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  if (
    identity.integrationNamespace !== "post" ||
    identity.stream !== "domestic-deposit" ||
    identity.currency !== "TWD"
  )
    throw new Error("Post current deposit identity is not an admitted TWD domestic account.");
  if (
    identity.accountNo !== row.accountNumber ||
    sourceAccountKey !== row.sourceAccountKey ||
    (identity.accountNumber?.value !== undefined &&
      identity.accountNumber.value !== row.accountNumber)
  )
    throw new Error(
      "Post current deposit ACT_NO does not exactly match the existing financial account.",
    );
  const balance: CurrentDepositExactAmount = {
    coefficient: row.ledger.coefficient,
    scale: row.ledger.scale,
  };
  const time = {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: row.effectiveTimeBasis,
    effectiveTimeRuleVersion: POST_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
    sourceField: row.effectiveTimeSourceField,
    sourceValue: row.effectiveTimeSourceValue,
    contractVersion: POST_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
  } as const;
  const sourceRecordKey = canonicalDigest(
    "post-current-deposit-source-record-v1",
    row.sourceAccountKey,
    row.currency,
    row.effectiveAt,
    balance.coefficient,
    String(balance.scale),
  );
  const compact = {
    source: "post",
    accountNumber: row.accountNumber,
    sourceAccountKey: row.sourceAccountKey,
    currency: row.currency,
    balanceSourceLexeme: row.ledger.sourceLexeme,
    effectiveAt: row.effectiveAt,
    effectiveTimeSourceField: row.effectiveTimeSourceField,
    effectiveTimeSourceValue: row.effectiveTimeSourceValue,
    sourceEvidence: { ...row.sourceEvidence },
    ...(row.providerHttpDate ? { providerHttpDate: row.providerHttpDate } : {}),
    ...(row.providerServerTimestamp
      ? { providerServerTimestamp: row.providerServerTimestamp }
      : {}),
  } satisfies Record<string, unknown>;
  const provisional = currentDepositSourceRecord({
    sourceRecordKey,
    providerKey: canonicalDigest(
      "post-current-deposit-provider-record-v1",
      row.sourceAccountKey,
      row.currency,
      row.effectiveAt,
    ),
    contentHash: "sha256:placeholder",
    sourceField: "BAL",
    balanceKind: "ledger",
    currency: row.currency,
    value: balance,
    time,
    compact,
  });
  const record: CurrentDepositSourceRecordInput = {
    ...provisional,
    contentHash: currentDepositSourceRecordContentHash(provisional.compact),
  };
  const observation: CurrentDepositBalanceObservationInput = {
    observationKey: canonicalDigest(
      "post-current-deposit-observation-v1",
      row.sourceAccountKey,
      row.currency,
    ),
    balanceKind: "ledger",
    balance,
    currency: row.currency,
    time,
    sourceRecordKey,
    sourceField: "BAL",
  };
  const scopeDate = row.effectiveAt.slice(0, 10);
  return {
    captureId: `post-current-${randomUUID()}`,
    authorityRoute: "post/domestic-deposit/current-balance-v1",
    contractVersion: POST_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "post",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: "domestic-deposit",
      sourceAccountKey,
    },
    observedAt: row.observedAt,
    scope: {
      startDate: scopeDate,
      endDate: scopeDate,
      contractFingerprint: canonicalDigest(
        "post-current-deposit-contract-v1",
        POST_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
      ),
      preflightFingerprint: canonicalDigest(
        "post-current-deposit-preflight-v1",
        identity.subjectDigest,
        scopeDate,
      ),
    },
    providerResponse: {
      endpoint: `https://${POST_CURRENT_DEPOSIT_BALANCE_HOST}${row.sourceEvidence.endpoint}`,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
      requestDiscriminant: {
        txnCode: row.sourceEvidence.txnCode,
        bizCode: row.sourceEvidence.bizCode,
        pageCount: row.sourceEvidence.pageCount,
      },
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: {
          source: "post-current-deposit-overview",
          endpoint: row.sourceEvidence.endpoint,
          txnCode: row.sourceEvidence.txnCode,
          bizCode: row.sourceEvidence.bizCode,
          pageCount: row.sourceEvidence.pageCount,
          accountNumber: row.accountNumber,
          balanceSourceLexeme: row.ledger.sourceLexeme,
          effectiveAt: row.effectiveAt,
          effectiveTimeSourceField: row.effectiveTimeSourceField,
          contractVersion: row.sourceEvidence.contractVersion,
          ...(row.providerHttpDate
            ? { providerHttpDate: row.providerHttpDate }
            : {}),
          ...(row.providerServerTimestamp
            ? { providerServerTimestamp: row.providerServerTimestamp }
            : {}),
        },
      },
    ],
    records: [record],
    observations: [observation],
  };
}

/**
 * Chunghwa Post keys a balance by each capture's own stream and source account
 * key. Every Post capture carries one constant source connection and the
 * identity epoch of the run's single human attestation manifest, so captures
 * spanning more than one connection or epoch fail closed before matching. A
 * row with no admitted capture fails the run. The first capture wins.
 */
export const postCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  Readonly<{ stream: string; sourceAccountKey: string }>,
  ExistingPostCurrentDepositFinancialCapture
> = {
  captureKey: ({ identity }) =>
    `${identity.stream}\u0000${identity.sourceAccountKey ?? identity.accountNo}`,
  rowKey: (row) => `${row.stream}\u0000${row.sourceAccountKey}`,
  duplicates: "first-wins",
  sameIdentity: (kept, candidate) =>
    kept.identity.sourceConnectionKey === candidate.identity.sourceConnectionKey &&
    kept.identity.identityEpochKey === candidate.identity.identityEpochKey &&
    kept.identity.accountNo === candidate.identity.accountNo &&
    kept.identity.accountNumber?.value === candidate.identity.accountNumber?.value &&
    kept.identity.subjectDigest === candidate.identity.subjectDigest &&
    kept.identity.currency === candidate.identity.currency,
  ambiguousMessage: "Post current deposit identities are ambiguous across financial captures.",
  oneScope: {
    scope: ({ identity }) => `${identity.sourceConnectionKey}\u0000${identity.identityEpochKey}`,
    message:
      "Post current deposit captures span more than one source connection or identity epoch.",
  },
  unmatched: {
    kind: "throw",
    message:
      "Post current deposit snapshot contains an account without an existing admitted identity.",
  },
};
