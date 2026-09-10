import { createHash, randomUUID } from "node:crypto";
import type { Page, Response } from "playwright";
import {
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
} from "../ledger/canonical/current-deposit-balance-writer.ts";

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

export type PostCurrentDepositResponseMetadata = Readonly<{
  url: string;
  status: number;
  method?: string;
  headers: Readonly<Record<string, string>>;
  /** The request body is parsed for its discriminants and never returned. */
  requestPostData?: string | null;
}>;

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

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u;
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

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

function responseHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value.trim();
  }
  return "";
}

function requireObservedAt(value: string): string {
  if (
    !RFC3339.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value)
  )
    throw new Error("Post current deposit observedAt must be RFC3339.");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/u.exec(
    value,
  );
  if (!match || (match[2]?.length ?? 0) > 9)
    throw new Error("Post current deposit observedAt has invalid precision.");
  const civil = new Date(`${match[1]}Z`);
  if (
    Number.isNaN(civil.getTime()) ||
    civil.toISOString().slice(0, 19) !== match[1]
  )
    throw new Error("Post current deposit observedAt has an invalid calendar date.");
  if (match[3] !== "Z") {
    const [hours, minutes] = match[3].slice(1).split(":").map(Number);
    if (hours > 23 || minutes > 59)
      throw new Error("Post current deposit observedAt has an invalid offset.");
  }
  return value;
}

function parseHttpDate(
  headers: Readonly<Record<string, string>>,
): { raw: string; effectiveAt: string } | null {
  const raw = responseHeader(headers, "date");
  if (raw === "") return null;
  if (!HTTP_DATE.test(raw))
    throw new Error("Post current deposit response HTTP Date is invalid.");
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== raw)
    throw new Error("Post current deposit response HTTP Date is invalid.");
  return { raw, effectiveAt: new Date(timestamp).toISOString() };
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
  headers: Readonly<Record<string, string>>,
  serverTimestamp: unknown,
): {
  effectiveAt: string;
  effectiveTimeBasis: PostCurrentDepositBalanceRow["effectiveTimeBasis"];
  effectiveTimeSourceField: PostCurrentDepositBalanceRow["effectiveTimeSourceField"];
  effectiveTimeSourceValue: string;
  providerHttpDate?: string;
  providerServerTimestamp?: string;
} {
  const httpDate = parseHttpDate(headers);
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

function requireResponse(
  response: PostCurrentDepositResponseMetadata,
): {
  contentType: string;
  cacheControl: string;
  request: {
    txnCode: typeof POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE;
    bizCode: typeof POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE;
    pageCount: typeof POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT;
  };
} {
  let parsed: URL;
  try {
    parsed = new URL(response.url);
  } catch {
    throw new Error("Post current deposit response URL is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== POST_CURRENT_DEPOSIT_BALANCE_HOST ||
    parsed.pathname !== POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    throw new Error("Post current deposit response endpoint is unexpected.");
  if (response.method?.toUpperCase() !== "POST")
    throw new Error("Post current deposit response method is not POST.");
  if (response.status !== 200)
    throw new Error("Post current deposit response status is not 200.");
  const contentType = responseHeader(response.headers, "content-type");
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType))
    throw new Error("Post current deposit response content type is not JSON.");
  const cacheControl = responseHeader(response.headers, "cache-control");
  if (!/\bno-store\b/iu.test(cacheControl))
    throw new Error("Post current deposit response must carry Cache-Control: no-store.");
  if (
    typeof response.requestPostData !== "string" ||
    response.requestPostData.trim() === ""
  )
    throw new Error("Post current deposit request body is missing.");
  let request: unknown;
  try {
    request = JSON.parse(response.requestPostData);
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
    contentType,
    cacheControl,
    request: {
      txnCode: POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
      bizCode: POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
      pageCount: POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT,
    },
  };
}

function parseExactInteger(
  value: unknown,
  label: string,
): PostCurrentDepositExactInteger {
  const sourceLexeme = requiredString(value, label);
  if (!/^-?\d+$/u.test(sourceLexeme))
    throw new Error(`Post current deposit ${label} must be an exact integer string.`);
  const negative = sourceLexeme.startsWith("-");
  const unsigned = negative ? sourceLexeme.slice(1) : sourceLexeme;
  const digits = unsigned.replace(/^0+(?=\d)/u, "") || "0";
  return {
    coefficient: digits === "0" ? "0" : negative ? `-${digits}` : digits,
    scale: 0,
    sourceLexeme,
  };
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
  response: PostCurrentDepositResponseMetadata;
  observedAt?: string;
}>): readonly PostCurrentDepositBalanceRow[] {
  const response = requireResponse(input.response);
  const { itemList, serverTimestamp } = parseScreenAndEndBracket(input.payload);
  const time = providerTime(input.response.headers, serverTimestamp);
  const observedAt = requireObservedAt(input.observedAt ?? new Date().toISOString());
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
      observedAt,
      sourceEvidence: {
        endpoint: POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
        status: 200,
        contentType: response.contentType,
        cacheControl: response.cacheControl,
        txnCode: response.request.txnCode,
        bizCode: response.request.bizCode,
        pageCount: response.request.pageCount,
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

function responseMatches(response: Response): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.protocol === "https:" &&
      url.hostname === POST_CURRENT_DEPOSIT_BALANCE_HOST &&
      url.pathname === POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH &&
      url.search === "" &&
      url.hash === "" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      response.request().method().toUpperCase() === "POST" &&
      requestMatchesCurrentBalanceDiscriminants(response)
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

/** Enter the authenticated asset-overview page and passively capture its POST. */
export async function readPostCurrentDepositBalances(
  page: Page,
  input: Readonly<{ observedAt?: string; timeoutMs?: number }> = {},
): Promise<readonly PostCurrentDepositBalanceRow[]> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!isPostIndexUrl(page.url())) {
    await page.goto(POST_CURRENT_DEPOSIT_BALANCE_PAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
  }
  const overview = page.getByText("資產總覽", { exact: true }).first();
  await overview.waitFor({ state: "visible", timeout: timeoutMs });
  const responsePromise = page.waitForResponse(responseMatches, {
    timeout: timeoutMs,
  });
  await overview.click();
  const response = await responsePromise;
  const headers = await response.allHeaders();
  const body = await response.body();
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new Error("Post current deposit balance response is not valid JSON.");
  }
  return parsePostCurrentDepositBalanceSnapshot({
    payload,
    response: {
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      headers,
      requestPostData: response.request().postData(),
    },
    observedAt: input.observedAt,
  });
}

function opaqueKey(domain: string, ...parts: readonly string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(`${domain}\u0000`)
    .update(parts.join("\u0000"))
    .digest("base64url")}`;
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
  const sourceRecordKey = opaqueKey(
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
    providerKey: opaqueKey(
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
    observationKey: opaqueKey(
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
      contractFingerprint: opaqueKey(
        "post-current-deposit-contract-v1",
        POST_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
      ),
      preflightFingerprint: opaqueKey(
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

export function indexPostCurrentDepositFinancialCaptures(
  financialCaptures: readonly ExistingPostCurrentDepositFinancialCapture[],
): ReadonlyMap<string, ExistingPostCurrentDepositFinancialCapture> {
  const result = new Map<string, ExistingPostCurrentDepositFinancialCapture>();
  for (const candidate of financialCaptures) {
    const identity = candidate.identity;
    const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
    const key = `${identity.sourceConnectionKey}\u0000${identity.identityEpochKey}\u0000${identity.stream}\u0000${sourceAccountKey}`;
    const prior = result.get(key);
    if (
      prior &&
      (prior.identity.accountNo !== identity.accountNo ||
        prior.identity.accountNumber?.value !== identity.accountNumber?.value ||
        prior.identity.subjectDigest !== identity.subjectDigest ||
        prior.identity.currency !== identity.currency)
    )
      throw new Error("Post current deposit identities are ambiguous across financial captures.");
    if (!prior) result.set(key, candidate);
  }
  return result;
}
