import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import type { Page, Response } from "playwright";
import { parseProviderDecimal, type ProviderDecimalPolicy } from "../lib/shared-money/exact-money.ts";
import { ProviderResponseCheckError } from "../lib/automation/provider-response-check.ts";
import {
  type ProviderResponse,
  type ProviderResponseDeclaration,
  type ProviderEvidence,
  type VerifiedProviderResponse,
} from "./provider-response.ts";
import { frameScope, type FrameScope } from "./frame-scope.ts";
import type { ProviderResponseReader } from "./provider-response-reader.ts";
import { trimSourceLexeme } from "../lib/automation/source-text.ts";

/**
 * CTBC renders the summary shell first and fills it with this authenticated
 * resource request. The response is the balance source; the page text is only
 * used to reach the provider's normal, user-facing route.
 */
const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["ctbc/domestic-deposit/current-balance-v1"];
/** The provider's observed transport discriminator; its value is never retained. */
export const CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY = "IIhfvu" as const;
export const CTBC_CURRENT_DEPOSIT_BALANCE_PAGE_URL =
  "https://www.ctbcbank.com/twrbc/twrbc-deposit/qu001/010" as const;
export const CTBC_CURRENT_DEPOSIT_BALANCE_METHOD = "POST" as const;

export type CtbcCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  /** The provider amount after only surrounding whitespace cleanup. */
  sourceLexeme: string;
}>;

/** The ebmwResource POST; the named transport key is its only allowed query. */
export const CTBC_CURRENT_DEPOSIT_RESPONSE: ProviderResponseDeclaration<"required"> = {
  label: "CTBC current deposit",
  host: CONTRACT.endpointHost,
  endpoints: [{
    path: CONTRACT.endpointPath,
    method: CTBC_CURRENT_DEPOSIT_BALANCE_METHOD,
    contentType: /^application\/json(?:\s*;|$)/iu,
    search: new RegExp(`^(?:\\?${CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY}(?:=[^&]*)?)?$`, "u"),
  }],
  cacheControl: CONTRACT.requiredCacheTokens,
  providerDate: "required",
};

export type CtbcCurrentDepositBalanceRow = Readonly<{
  source: "ctbc";
  stream: "domestic-deposit";
  /** The complete sixteen-digit accountId from the provider response. */
  accountNumber: string;
  sourceAccountKey: string;
  currency: "TWD";
  /** Only demDepBalSummaryResponse.infoList[].balance is an observation. */
  ledger: CtbcCurrentDepositExactDecimal;
  providerFields: Readonly<{
    accountId: string;
    digiSvType: string;
    acctType: string;
    accountNickName: string;
    openDt: string;
    isRelaC: "N" | "Y";
  }>;
  effectiveAt: string;
  providerServerTime: number;
  providerDataTime: string;
  providerHttpDate: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof CONTRACT.endpointPath;
    requestResource: typeof CONTRACT.requestResource;
    status: 200;
    cacheControl: string;
    contractVersion: typeof CONTRACT.contractVersion;
  }>;
}>;

type JsonRecord = Record<string, unknown>;

const DATA_TIME = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredField(
  value: unknown,
  name: string,
  rowIndex?: number,
): unknown {
  if (value === undefined) {
    const prefix = rowIndex === undefined ? "CTBC current deposit response" : `CTBC current deposit row ${rowIndex}`;
    throw new Error(`${prefix} is missing ${name}.`);
  }
  return value;
}

function requiredString(
  value: unknown,
  name: string,
  options: Readonly<{ allowEmpty?: boolean }> = {},
  rowIndex?: number,
): string {
  if (typeof value !== "string")
    throw new Error(`CTBC current deposit ${name} must be a string.`);
  const text = trimSourceLexeme(value);
  if (!options.allowEmpty && text.length === 0)
    throw new Error(`CTBC current deposit ${name} is empty.`);
  return text;
}

/** The request body is parsed only for its resource discriminant. */
function requireRequest(requestPostData: string | null): void {
  if (typeof requestPostData !== "string" || requestPostData.trim() === "")
    throw new Error("CTBC current deposit request body is missing.");
  let request: unknown;
  try {
    request = JSON.parse(requestPostData);
  } catch {
    throw new Error("CTBC current deposit request body is not valid JSON.");
  }
  if (!isRecord(request))
    throw new Error("CTBC current deposit request body is not an object.");
  const resource = requiredString(
    requiredField(request.resource, "request resource"),
    "request resource",
  );
  if (resource !== CONTRACT.requestResource)
    throw new Error("CTBC current deposit request resource is unexpected.");
  const rqData = requiredField(request.rqData, "request rqData");
  if (!isRecord(rqData))
    throw new Error("CTBC current deposit request rqData is not an object.");
}

const CTBC_AMOUNT: ProviderDecimalPolicy = {
  internalWhitespace: "reject",
  grouping: "thousands",
  digits: "decimal",
};

function parseExactDecimal(value: unknown, label: string): CtbcCurrentDepositExactDecimal {
  if (typeof value !== "string")
    throw new Error(`CTBC current deposit ${label} must be a string.`);
  const sourceLexeme = trimSourceLexeme(value);
  const amount = parseProviderDecimal(sourceLexeme, CTBC_AMOUNT);
  if (!amount)
    throw new Error(`CTBC current deposit ${label} is not an exact decimal.`);
  return { ...amount, sourceLexeme };
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{8}$/u.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function requireDataTime(value: unknown, serverTime: number): string {
  const dataTime = requiredString(value, "dataTime");
  const match = DATA_TIME.exec(dataTime);
  if (!match) throw new Error("CTBC current deposit dataTime is invalid.");
  const [, year, month, day, hour, minute, second] = match;
  const civil = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  if (
    civil.getUTCFullYear() !== Number(year) ||
    civil.getUTCMonth() !== Number(month) - 1 ||
    civil.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    throw new Error("CTBC current deposit dataTime is not a valid Taipei date-time.");
  const expectedServerTime =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ) - 8 * 60 * 60 * 1_000;
  if (Math.floor(serverTime / 1_000) * 1_000 !== expectedServerTime)
    throw new Error("CTBC current deposit dataTime does not match serverTime in Asia/Taipei.");
  return dataTime;
}

function parseRow(
  value: unknown,
  rowIndex: number,
  effectiveAt: string,
  serverTime: number,
  dataTime: string,
  response: VerifiedProviderResponse<"required">,
): CtbcCurrentDepositBalanceRow {
  if (!isRecord(value))
    throw new Error(`CTBC current deposit row ${rowIndex} is not an object.`);
  const accountNumber = requiredString(
    requiredField(value.accountId, "accountId", rowIndex),
    `row ${rowIndex} accountId`,
  );
  if (!/^\d{16}$/u.test(accountNumber))
    throw new Error(`CTBC current deposit row ${rowIndex} accountId is not a sixteen-digit string.`);
  const ledger = parseExactDecimal(
    requiredField(value.balance, "balance", rowIndex),
    `row ${rowIndex} balance`,
  );
  const availableBalance = parseExactDecimal(
    requiredField(value.availableBalance, "availableBalance", rowIndex),
    `row ${rowIndex} availableBalance`,
  );
  // Parse the provider's other fields to prove the row shape, while leaving
  // aggregate and available amounts out of the ledger observation.
  void availableBalance;
  const digiSvType = requiredString(
    requiredField(value.digiSvType, "digiSvType", rowIndex),
    `row ${rowIndex} digiSvType`,
    { allowEmpty: true },
  );
  const acctType = requiredString(
    requiredField(value.acctType, "acctType", rowIndex),
    `row ${rowIndex} acctType`,
  );
  if (!/^\d{2}$/u.test(acctType))
    throw new Error(`CTBC current deposit row ${rowIndex} acctType is invalid.`);
  const accountNickName = requiredString(
    requiredField(value.accountNickName, "accountNickName", rowIndex),
    `row ${rowIndex} accountNickName`,
    { allowEmpty: true },
  );
  const openDt = requiredString(
    requiredField(value.openDt, "openDt", rowIndex),
    `row ${rowIndex} openDt`,
  );
  if (!validCalendarDate(openDt))
    throw new Error(`CTBC current deposit row ${rowIndex} openDt is invalid.`);
  const isRelaC = requiredString(
    requiredField(value.isRelaC, "isRelaC", rowIndex),
    `row ${rowIndex} isRelaC`,
  );
  if (isRelaC !== "N" && isRelaC !== "Y")
    throw new Error(`CTBC current deposit row ${rowIndex} isRelaC is invalid.`);
  return {
    source: "ctbc",
    stream: "domestic-deposit",
    accountNumber,
    sourceAccountKey: accountNumber,
    currency: "TWD",
    ledger,
    providerFields: {
      accountId: accountNumber,
      digiSvType,
      acctType,
      accountNickName,
      openDt,
      isRelaC,
    },
    effectiveAt,
    providerServerTime: serverTime,
    providerDataTime: dataTime,
    providerHttpDate: response.providerDate.raw,
    observedAt: response.observedAt,
    sourceEvidence: {
      endpoint: CONTRACT.endpointPath,
      requestResource: CONTRACT.requestResource,
      status: 200,
      cacheControl: response.cacheControl,
      contractVersion: CONTRACT.contractVersion,
    },
  };
}

/** Parse one complete CTBC current-deposit summary response. */
export function parseCtbcCurrentDepositBalanceSnapshot(input: Readonly<{
  payload: unknown;
  response: VerifiedProviderResponse<"required">;
  requestPostData: string | null;
}>): readonly CtbcCurrentDepositBalanceRow[] {
  requireRequest(input.requestPostData);
  if (!isRecord(input.payload))
    throw new Error("CTBC current deposit response envelope is invalid.");
  if (input.payload.code !== "0000")
    throw new Error(`CTBC current deposit response failed: ${String(input.payload.code ?? "unknown")}`);
  const serverTime = input.payload.serverTime;
  if (
    typeof serverTime !== "number" ||
    !Number.isSafeInteger(serverTime) ||
    serverTime <= 0
  )
    throw new Error("CTBC current deposit serverTime is missing or invalid.");
  const data = input.payload.rsData;
  if (!isRecord(data))
    throw new Error("CTBC current deposit response rsData is missing.");
  const summary = data.twdAcctSummaryResponse;
  if (!isRecord(summary))
    throw new Error("CTBC current deposit twdAcctSummaryResponse is missing.");
  parseExactDecimal(
    requiredField(summary.twdAcctSummaryTotalAmount, "twdAcctSummaryTotalAmount"),
    "twdAcctSummaryTotalAmount",
  );
  const dataTime = requireDataTime(summary.dataTime, serverTime);
  const demand = summary.demDepBalSummaryResponse;
  if (!isRecord(demand))
    throw new Error("CTBC current deposit demDepBalSummaryResponse is missing.");
  parseExactDecimal(requiredField(demand.totalAmount, "totalAmount"), "totalAmount");
  if (!Array.isArray(demand.infoList) || demand.infoList.length === 0)
    throw new Error("CTBC current deposit infoList must be a non-empty array.");
  parseExactDecimal(
    requiredField(summary.twdAcctSummaryTotalAmountIB, "twdAcctSummaryTotalAmountIB"),
    "twdAcctSummaryTotalAmountIB",
  );
  const effectiveAt = new Date(serverTime).toISOString();
  const rows = demand.infoList.map((row, rowIndex) =>
    parseRow(row, rowIndex, effectiveAt, serverTime, dataTime, input.response),
  );
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.accountNumber))
      throw new Error("CTBC current deposit response has a duplicate accountId.");
    seen.add(row.accountNumber);
  }
  return rows;
}

type CtbcResponseDiagnostic = Readonly<{
  hostname: string;
  pathname: string;
  queryKeys: readonly string[];
  requestResource: string | null;
}>;

function safePath(value: unknown): string | null {
  return typeof value === "string" && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(value)
    ? value
    : null;
}

function requestResource(postData: string | null): string | null {
  if (!postData) return null;
  try {
    const parsed: unknown = JSON.parse(postData);
    if (!isRecord(parsed)) return null;
    return safePath(parsed.resource);
  } catch {
    return null;
  }
}

function responseDiagnostic(response: Response): CtbcResponseDiagnostic | null {
  try {
    const url = new URL(response.url());
    if (
      url.protocol !== "https:" ||
      url.pathname !== CONTRACT.endpointPath ||
      response.request().method().toUpperCase() !== CTBC_CURRENT_DEPOSIT_BALANCE_METHOD
    )
      return null;
    return {
      hostname: url.hostname,
      pathname: url.pathname,
      queryKeys: [...new Set([...url.searchParams.keys()]
        .filter((key) => /^[A-Za-z0-9_.-]+$/u.test(key)))].sort(),
      requestResource: requestResource(response.request().postData()),
    };
  } catch {
    return null;
  }
}

/** Any summary POST to the endpoint, whatever its query: more than one is ambiguous. */
function summaryResponseCandidate(response: Response): boolean {
  const request = response.request();
  return (
    request.method() === CTBC_CURRENT_DEPOSIT_BALANCE_METHOD &&
    response.url().startsWith(`https://${CONTRACT.endpointHost}${CONTRACT.endpointPath}`) &&
    requestResource(request.postData()) === CONTRACT.requestResource
  );
}

function formatResponseDiagnostics(
  diagnostics: readonly CtbcResponseDiagnostic[],
): string {
  return diagnostics
    .slice(0, 8)
    .map(
      (entry) =>
        `hostname=${entry.hostname || "<empty>"}, path=${entry.pathname}, queryKeys=${
          entry.queryKeys.join(",") || "<none>"
        }, requestResource=${entry.requestResource ?? "<missing>"}`,
    )
    .join("; ");
}

async function clickExactText(scope: FrameScope, text: string, timeoutMs: number): Promise<void> {
  const control = scope.page.getByText(text, { exact: true }).first();
  await scope.withSignal((signal) => control.waitFor({ state: "visible", timeout: timeoutMs, signal }));
  await scope.withSignal((signal) => control.click({ signal }));
}

/** The summary response CTBC's page triggers, before decoding. */
export type CtbcCurrentDepositResponse = Readonly<{
  evidence: Extract<ProviderEvidence, { kind: "json" }>;
  response: ProviderResponse;
  /** Only the request discriminator is retained after parsing. */
  requestPostData: string | null;
}>;

/**
 * Enter CTBC's current-summary page through the normal authenticated menu and
 * passively observe the one POST it triggers, read through `reader` so a
 * refused reply fails inside its validation. The request body is used only
 * for the resource discriminant and is never returned beyond the metadata the
 * parser validates.
 */
export async function readCtbcCurrentDepositBalanceResponse(
  page: Page,
  signal: AbortSignal,
  reader: ProviderResponseReader,
  input: Readonly<{ timeoutMs?: number }> = {},
): Promise<CtbcCurrentDepositResponse> {
  const scope = frameScope(page, signal);
  const timeoutMs = input.timeoutMs ?? 60_000;
  const diagnostics: CtbcResponseDiagnostic[] = [];
  let matching = 0;
  const listener = (candidate: Response) => {
    const diagnostic = responseDiagnostic(candidate);
    if (diagnostic) diagnostics.push(diagnostic);
    if (summaryResponseCandidate(candidate)) matching += 1;
  };
  page.on("response", listener);
  try {
    const captured = await reader.acquire(scope, CTBC_CURRENT_DEPOSIT_RESPONSE, {
      evidence: "json",
      request: (request) => requestResource(request.postData) === CONTRACT.requestResource,
      timeoutMs,
      trigger: async () => {
        await clickExactText(scope, "臺幣/轉帳", timeoutMs);
        await clickExactText(scope, "臺幣存款概要", timeoutMs);
        await scope.withSignal((signal) =>
          page.waitForURL(CTBC_CURRENT_DEPOSIT_BALANCE_PAGE_URL, { timeout: timeoutMs, signal }));
      },
    });
    if (matching !== 1)
      throw new Error("CTBC current balance source response was missing or ambiguous.");
    return { evidence: captured.evidence, response: captured.response, requestPostData: captured.request.postData };
  } catch (error) {
    // A refused reply is the reader's validation failure; the candidates only explain a missing one.
    if (signal.aborted || diagnostics.length === 0 || error instanceof ProviderResponseCheckError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} CTBC balance response candidates: ${formatResponseDiagnostics(diagnostics)}`,
      { cause: error },
    );
  } finally {
    page.off("response", listener);
  }
}
