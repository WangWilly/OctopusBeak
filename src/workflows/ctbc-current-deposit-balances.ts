import type { Page, Response } from "playwright";

/**
 * CTBC renders the summary shell first and fills it with this authenticated
 * resource request. The response is the balance source; the page text is only
 * used to reach the provider's normal, user-facing route.
 */
export const CTBC_CURRENT_DEPOSIT_BALANCE_HOST = "www.ctbcbank.com" as const;
export const CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH =
  "/IB/api/adapters/IB_Adapter/resource/ebmwResource" as const;
/** The provider's observed transport discriminator; its value is never retained. */
export const CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY = "IIhfvu" as const;
export const CTBC_CURRENT_DEPOSIT_BALANCE_PAGE_URL =
  "https://www.ctbcbank.com/twrbc/twrbc-deposit/qu001/010" as const;
export const CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE =
  "/twrbc-deposit/qu001/010" as const;
export const CTBC_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION =
  "ctbc/current-deposit-balance-v1" as const;
export const CTBC_CURRENT_DEPOSIT_BALANCE_METHOD = "POST" as const;

export type CtbcCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  /** The provider amount after only surrounding whitespace cleanup. */
  sourceLexeme: string;
}>;

export type CtbcCurrentDepositResponseMetadata = Readonly<{
  url: string;
  status: number;
  method?: string;
  headers: Readonly<Record<string, string>>;
  /** Only the request discriminator is retained after parsing. */
  requestPostData?: string | null;
}>;

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
    endpoint: typeof CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH;
    requestResource: typeof CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE;
    status: 200;
    cacheControl: string;
    contractVersion: typeof CTBC_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION;
  }>;
}>;

type JsonRecord = Record<string, unknown>;

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u;
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
const DATA_TIME = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: string): string {
  return value.replace(/[\u00a0\u3000]/gu, " ").trim();
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
  const text = cleanText(value);
  if (!options.allowEmpty && text.length === 0)
    throw new Error(`CTBC current deposit ${name} is empty.`);
  return text;
}

function requireObservedAt(value: string): string {
  if (
    typeof value !== "string" ||
    !RFC3339.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("CTBC current deposit observedAt must be RFC3339.");
  }
  return value;
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

function requireProviderDate(headers: Readonly<Record<string, string>>): string {
  const raw = responseHeader(headers, "date");
  if (!HTTP_DATE.test(raw))
    throw new Error("CTBC current deposit response is missing a valid HTTP Date.");
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== raw)
    throw new Error("CTBC current deposit HTTP Date is invalid.");
  return raw;
}

function requireCacheControl(headers: Readonly<Record<string, string>>): string {
  const cacheControl = responseHeader(headers, "cache-control");
  for (const token of ["no-cache", "no-store", "must-revalidate"])
    if (!new RegExp(`\\b${token}\\b`, "iu").test(cacheControl))
      throw new Error(
        `CTBC current deposit response must carry Cache-Control: ${token}.`,
      );
  return cacheControl;
}

function hasApprovedTransportQuery(url: URL): boolean {
  const keys = [...url.searchParams.keys()];
  return (
    keys.length === 0 ||
    (keys.length === 1 &&
      keys[0] === CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY)
  );
}

function requireResponse(
  response: CtbcCurrentDepositResponseMetadata,
): { providerHttpDate: string; cacheControl: string; requestResource: string } {
  let parsed: URL;
  try {
    parsed = new URL(response.url);
  } catch {
    throw new Error("CTBC current deposit response URL is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== CTBC_CURRENT_DEPOSIT_BALANCE_HOST ||
    parsed.pathname !== CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH ||
    !hasApprovedTransportQuery(parsed) ||
    parsed.hash !== "" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("CTBC current deposit response endpoint is unexpected.");
  }
  if (response.method?.toUpperCase() !== CTBC_CURRENT_DEPOSIT_BALANCE_METHOD)
    throw new Error("CTBC current deposit response method is not POST.");
  if (response.status !== 200)
    throw new Error("CTBC current deposit response status is not 200.");
  const contentType = responseHeader(response.headers, "content-type");
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType))
    throw new Error("CTBC current deposit response content type is not JSON.");
  const requestPostData = response.requestPostData;
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
  if (resource !== CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE)
    throw new Error("CTBC current deposit request resource is unexpected.");
  const rqData = requiredField(request.rqData, "request rqData");
  if (!isRecord(rqData))
    throw new Error("CTBC current deposit request rqData is not an object.");
  return {
    providerHttpDate: requireProviderDate(response.headers),
    cacheControl: requireCacheControl(response.headers),
    requestResource: resource,
  };
}

function parseExactDecimal(value: unknown, label: string): CtbcCurrentDepositExactDecimal {
  if (typeof value !== "string")
    throw new Error(`CTBC current deposit ${label} must be a string.`);
  const sourceLexeme = cleanText(value);
  const match = /^(-?)(\d+|\d{1,3}(?:,\d{3})*)(?:\.(\d+))?$/u.exec(sourceLexeme);
  if (!match)
    throw new Error(`CTBC current deposit ${label} is not an exact decimal.`);
  const sign = match[1] === "-" ? "-" : "";
  const whole = (match[2] ?? "").replaceAll(",", "");
  const fraction = match[3] ?? "";
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/u, "") || "0";
  return {
    coefficient: digits === "0" ? "0" : `${sign}${digits}`,
    scale: fraction.length,
    sourceLexeme,
  };
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
  providerHttpDate: string,
  cacheControl: string,
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
    providerHttpDate,
    observedAt: "",
    sourceEvidence: {
      endpoint: CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
      requestResource: CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE,
      status: 200,
      cacheControl,
      contractVersion: CTBC_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
    },
  };
}

/** Parse one complete CTBC current-deposit summary response. */
export function parseCtbcCurrentDepositBalanceSnapshot(input: Readonly<{
  payload: unknown;
  response: CtbcCurrentDepositResponseMetadata;
  observedAt: string;
}>): readonly CtbcCurrentDepositBalanceRow[] {
  const { providerHttpDate, cacheControl } = requireResponse(input.response);
  const observedAt = requireObservedAt(input.observedAt);
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
    parseRow(
      row,
      rowIndex,
      effectiveAt,
      serverTime,
      dataTime,
      providerHttpDate,
      cacheControl,
    ),
  );
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.accountNumber))
      throw new Error("CTBC current deposit response has a duplicate accountId.");
    seen.add(row.accountNumber);
  }
  return rows.map((row) => ({ ...row, observedAt }));
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

function requestResource(response: Response): string | null {
  const postData = response.request().postData();
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
      url.pathname !== CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH ||
      response.request().method().toUpperCase() !== CTBC_CURRENT_DEPOSIT_BALANCE_METHOD
    )
      return null;
    return {
      hostname: url.hostname,
      pathname: url.pathname,
      queryKeys: [...new Set([...url.searchParams.keys()]
        .filter((key) => /^[A-Za-z0-9_.-]+$/u.test(key)))].sort(),
      requestResource: requestResource(response),
    };
  } catch {
    return null;
  }
}

function responseMatches(response: Response): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.protocol === "https:" &&
      url.hostname === CTBC_CURRENT_DEPOSIT_BALANCE_HOST &&
      url.pathname === CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH &&
      hasApprovedTransportQuery(url) &&
      url.hash === "" &&
      response.request().method().toUpperCase() === CTBC_CURRENT_DEPOSIT_BALANCE_METHOD &&
      requestResource(response) === CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE
    );
  } catch {
    return false;
  }
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

async function clickExactText(page: Page, text: string, timeoutMs: number): Promise<void> {
  const control = page.getByText(text, { exact: true }).first();
  await control.waitFor({ state: "visible", timeout: timeoutMs });
  await control.click();
}

/**
 * Enter CTBC's current-summary page through the normal authenticated menu and
 * passively parse the POST it triggers. The request body is used only for the
 * resource discriminant and is never returned or retained.
 */
export async function readCtbcCurrentDepositBalances(
  page: Page,
  input: Readonly<{ observedAt: string; timeoutMs?: number }>,
): Promise<readonly CtbcCurrentDepositBalanceRow[]> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  try {
    const diagnostics: CtbcResponseDiagnostic[] = [];
    const diagnosticListener = (candidate: Response) => {
      const diagnostic = responseDiagnostic(candidate);
      if (diagnostic) diagnostics.push(diagnostic);
    };
    page.on("response", diagnosticListener);
    try {
      const responsePromise = page.waitForResponse(responseMatches, { timeout: timeoutMs });
      await clickExactText(page, "臺幣/轉帳", timeoutMs);
      await clickExactText(page, "臺幣存款概要", timeoutMs);
      await page.waitForURL(CTBC_CURRENT_DEPOSIT_BALANCE_PAGE_URL, { timeout: timeoutMs });
      const response = await responsePromise;
      const body = await response.body();
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(body).toString("utf8"));
      } catch {
        throw new Error("CTBC current deposit balance response is not valid JSON.");
      }
      const headers = await response.allHeaders();
      return parseCtbcCurrentDepositBalanceSnapshot({
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
    } catch (error) {
      if (diagnostics.length === 0) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message} CTBC balance response candidates: ${formatResponseDiagnostics(diagnostics)}`,
        { cause: error },
      );
    } finally {
      page.off("response", diagnosticListener);
    }
  } catch (error) {
    throw error;
  }
}
