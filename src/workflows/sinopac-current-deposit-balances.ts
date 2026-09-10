import type { Page, Response } from "playwright";

/**
 * SinoPac renders the account-summary HTML shell first and fills its balance
 * table from this authenticated POST.  The POST is the balance source; the
 * shell is not a second source of rows or provider time.
 */
export const SINOPAC_CURRENT_DEPOSIT_BALANCE_HOST =
  "mma.sinopac.com" as const;
export const SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH =
  "/ws/bank/bankbal/ws_bankbal.ashx" as const;
export const SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL =
  "https://mma.sinopac.com/mma/bank/bankbal/mma_bankbal.aspx?1" as const;
export const SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION =
  "sinopac/current-deposit-balance-v1" as const;
export const SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTENT_TYPE =
  "application/json;charset=UTF-8" as const;

export type SinopacCurrentDepositStream =
  | "domestic-deposit"
  | "foreign-currency-deposit";

export type SinopacCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  /** The provider string after only surrounding whitespace cleanup. */
  sourceLexeme: string;
}>;

export type SinopacCurrentDepositResponseMetadata = Readonly<{
  url: string;
  status: number;
  method?: string;
  headers: Readonly<Record<string, string>>;
}>;

export type SinopacCurrentDepositBalanceRow = Readonly<{
  source: "sinopac";
  stream: SinopacCurrentDepositStream;
  /** The complete provider account key from AcctValue, including zeroes. */
  accountNumber: string;
  sourceAccountKey: string;
  accountText: string;
  accountValueFormat: string;
  currency: string;
  currencyText: string;
  /** AvailBalance is the provider ledger amount for this contract. */
  ledger: SinopacCurrentDepositExactDecimal;
  /** Retained as source evidence; it is never emitted as an observation. */
  providerFields: Readonly<{
    availBalance: string;
    availBalanceInteger: string | null;
    maxAvail: string;
    outStdLmt: string;
    fixBalance: string;
    nonTrxferFlg: "True" | "False";
    category: string;
    digiTalFg: string;
  }>;
  effectiveAt: string;
  providerHttpDate: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH;
    status: 200;
    contentType: typeof SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTENT_TYPE;
    cacheControl: string;
    contractVersion: typeof SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION;
  }>;
}>;

type JsonRecord = Record<string, unknown>;

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u;
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/gu, " ").trim();
}

function field(row: JsonRecord, name: string, rowIndex: number): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, name)) {
    throw new Error(`SinoPac current deposit row ${rowIndex} is missing ${name}.`);
  }
  return row[name];
}

function requiredString(
  value: unknown,
  label: string,
  options: Readonly<{ allowEmpty?: boolean }> = {},
): string {
  if (typeof value !== "string")
    throw new Error(`SinoPac current deposit ${label} must be a string.`);
  const text = cleanText(value);
  if (!options.allowEmpty && text.length === 0)
    throw new Error(`SinoPac current deposit ${label} is empty.`);
  return text;
}

function requireObservedAt(value: string): string {
  const match =
    typeof value === "string"
      ? /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/u.exec(
          value,
        )
      : null;
  if (
    !match ||
    !RFC3339.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    (match[2]?.length ?? 0) > 9
  ) {
    throw new Error("SinoPac current deposit observedAt must be RFC3339.");
  }
  const calendarDate = new Date(`${match[1]}T00:00:00.000Z`);
  if (
    Number.isNaN(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== match[1]
  ) {
    throw new Error("SinoPac current deposit observedAt has an invalid calendar date.");
  }
  if (match[3] !== "Z") {
    const [hours, minutes] = match[3].slice(1).split(":").map(Number);
    if (hours > 23 || minutes > 59)
      throw new Error("SinoPac current deposit observedAt has an invalid offset.");
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

function providerDate(headers: Readonly<Record<string, string>>): {
  raw: string;
  effectiveAt: string;
} {
  const raw = responseHeader(headers, "date");
  if (!HTTP_DATE.test(raw))
    throw new Error("SinoPac current deposit response is missing a valid HTTP Date.");
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== raw)
    throw new Error("SinoPac current deposit HTTP Date is invalid.");
  return { raw, effectiveAt: new Date(timestamp).toISOString() };
}

function hasApprovedTransportQuery(url: URL): boolean {
  const keys = [...url.searchParams.keys()];
  return keys.length === 0 || (keys.length === 1 && /^\d{13}$/u.test(keys[0]!));
}

function requireContentType(
  headers: Readonly<Record<string, string>>,
): typeof SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTENT_TYPE {
  const raw = responseHeader(headers, "content-type");
  if (!/^application\/json\s*;\s*charset\s*=\s*utf-8$/iu.test(raw))
    throw new Error(
      "SinoPac current deposit response content type is not application/json;charset=UTF-8.",
    );
  return SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTENT_TYPE;
}

function requireResponse(
  response: SinopacCurrentDepositResponseMetadata,
): {
  providerDate: { raw: string; effectiveAt: string };
  contentType: typeof SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTENT_TYPE;
  cacheControl: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(response.url);
  } catch {
    throw new Error("SinoPac current deposit response URL is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== SINOPAC_CURRENT_DEPOSIT_BALANCE_HOST ||
    parsed.pathname !== SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH ||
    !hasApprovedTransportQuery(parsed) ||
    parsed.hash !== "" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("SinoPac current deposit response endpoint is unexpected.");
  }
  if (response.method?.toUpperCase() !== "POST")
    throw new Error("SinoPac current deposit response method is not POST.");
  if (response.status !== 200)
    throw new Error("SinoPac current deposit response status is not 200.");
  const contentType = requireContentType(response.headers);
  const cacheControl = responseHeader(response.headers, "cache-control");
  if (!/\bno-cache\b/iu.test(cacheControl) || !/\bno-store\b/iu.test(cacheControl))
    throw new Error(
      "SinoPac current deposit response must carry Cache-Control: no-cache,no-store.",
    );
  return { providerDate: providerDate(response.headers), contentType: SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTENT_TYPE, cacheControl };
}

function parseExactDecimal(
  value: unknown,
  label: string,
): SinopacCurrentDepositExactDecimal {
  const sourceLexeme = requiredString(value, label);
  const match = /^(-?)(\d+|\d{1,3}(?:,\d{3})*)(?:\.(\d+))?$/u.exec(
    sourceLexeme,
  );
  if (!match)
    throw new Error(`SinoPac current deposit ${label} is not an exact decimal.`);
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

function parseCurrency(value: unknown, rowIndex: number): string {
  const currency = requiredString(value, `row ${rowIndex} Curr`).toUpperCase();
  if (
    !/^[A-Z]{3}$/u.test(currency) ||
    !Intl.supportedValuesOf("currency").includes(currency)
  ) {
    throw new Error(`SinoPac current deposit row ${rowIndex} currency is invalid.`);
  }
  return currency;
}

function parseRow(
  value: unknown,
  rowIndex: number,
  effectiveAt: string,
  providerHttpDate: string,
  observedAt: string,
  contentType: typeof SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTENT_TYPE,
  cacheControl: string,
): SinopacCurrentDepositBalanceRow {
  if (!isRecord(value))
    throw new Error(`SinoPac current deposit row ${rowIndex} is not an object.`);
  const accountText = requiredString(field(value, "AcctText", rowIndex), `row ${rowIndex} AcctText`);
  const accountNumber = requiredString(field(value, "AcctValue", rowIndex), `row ${rowIndex} AcctValue`);
  if (!/^\d{14}$/u.test(accountNumber))
    throw new Error(`SinoPac current deposit row ${rowIndex} account is not a fourteen-digit value.`);
  const accountValueFormat = requiredString(
    field(value, "AcctValueFormat", rowIndex),
    `row ${rowIndex} AcctValueFormat`,
  );
  const formattedAccountNumber = accountValueFormat.replaceAll("-", "");
  if (
    accountValueFormat !== "###-###-#######-#" &&
    (!/^\d{3}-\d{3}-\d{7}-\d$/u.test(accountValueFormat) ||
      formattedAccountNumber !== accountNumber)
  )
    throw new Error(`SinoPac current deposit row ${rowIndex} account format is invalid.`);
  const currency = parseCurrency(field(value, "Curr", rowIndex), rowIndex);
  const currencyText = requiredString(field(value, "CurText", rowIndex), `row ${rowIndex} CurText`);
  const ledger = parseExactDecimal(
    field(value, "AvailBalance", rowIndex),
    `row ${rowIndex} AvailBalance`,
  );
  const availBalanceIntegerValue = field(value, "AvailBalInt", rowIndex);
  const availBalanceInteger =
    availBalanceIntegerValue === null
      ? null
      : requiredString(
          availBalanceIntegerValue,
          `row ${rowIndex} AvailBalInt`,
          { allowEmpty: true },
        );
  const maxAvail = requiredString(field(value, "MaxAvail", rowIndex), `row ${rowIndex} MaxAvail`);
  const outStdLmt = requiredString(field(value, "OutStdLmt", rowIndex), `row ${rowIndex} OutStdLmt`);
  const fixBalance = requiredString(field(value, "FixBalance", rowIndex), `row ${rowIndex} FixBalance`);
  const nonTrxferFlg = requiredString(field(value, "NonTrxferFlg", rowIndex), `row ${rowIndex} NonTrxferFlg`);
  if (nonTrxferFlg !== "True" && nonTrxferFlg !== "False")
    throw new Error(`SinoPac current deposit row ${rowIndex} NonTrxferFlg is invalid.`);
  const category = requiredString(field(value, "Category", rowIndex), `row ${rowIndex} Category`);
  if (!/^\d{4}$/u.test(category))
    throw new Error(`SinoPac current deposit row ${rowIndex} Category is invalid.`);
  const digiTalFg = requiredString(field(value, "DigiTalFg", rowIndex), `row ${rowIndex} DigiTalFg`, { allowEmpty: true });
  const stream: SinopacCurrentDepositStream =
    currency === "TWD" ? "domestic-deposit" : "foreign-currency-deposit";
  return {
    source: "sinopac",
    stream,
    accountNumber,
    sourceAccountKey: accountNumber,
    accountText,
    accountValueFormat,
    currency,
    currencyText,
    ledger,
    providerFields: {
      availBalance: ledger.sourceLexeme,
      availBalanceInteger,
      maxAvail,
      outStdLmt,
      fixBalance,
      nonTrxferFlg,
      category,
      digiTalFg,
    },
    effectiveAt,
    providerHttpDate,
    observedAt,
    sourceEvidence: {
      endpoint: SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
      status: 200,
      contentType,
      cacheControl,
      contractVersion: SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
    },
  };
}

/** Parse one completed ws_bankbal JSON response without coercing provider amounts. */
export function parseSinopacCurrentDepositBalanceSnapshot(input: Readonly<{
  payload: unknown;
  response: SinopacCurrentDepositResponseMetadata;
  observedAt: string;
}>): readonly SinopacCurrentDepositBalanceRow[] {
  const { providerDate, contentType, cacheControl } = requireResponse(input.response);
  const observedAt = requireObservedAt(input.observedAt);
  if (!Array.isArray(input.payload) || input.payload.length !== 1)
    throw new Error("SinoPac current deposit response must contain one envelope.");
  const envelope = input.payload[0];
  if (!isRecord(envelope))
    throw new Error("SinoPac current deposit response envelope is invalid.");
  if (envelope.Header !== "SUCCESS")
    throw new Error(`SinoPac current deposit response failed: ${String(envelope.Message ?? "unknown")}`);
  if (!Array.isArray(envelope.SubInfo) || envelope.SubInfo.length === 0)
    throw new Error("SinoPac current deposit response SubInfo is missing or empty.");
  const rows = envelope.SubInfo.map((row, rowIndex) =>
    parseRow(
      row,
      rowIndex,
      providerDate.effectiveAt,
      providerDate.raw,
      observedAt,
      contentType,
      cacheControl,
    ),
  );
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.sourceAccountKey}\u0000${row.currency}`;
    if (seen.has(key))
      throw new Error("SinoPac current deposit response has a duplicate account/currency row.");
    seen.add(key);
  }
  return rows;
}

export type SinopacCurrentDepositResponseDiagnostic = Readonly<{
  hostname: string;
  pathname: string;
  queryKeys: readonly string[];
}>;

/**
 * Keep timeout evidence useful without retaining response URLs, query values,
 * credentials, or response bodies.  The path filter keeps unrelated POSTs out
 * of the bounded candidate list while still exposing host/query mismatches.
 */
export function sinopacCurrentDepositResponseDiagnostic(
  response: Response,
): SinopacCurrentDepositResponseDiagnostic | null {
  try {
    const url = new URL(response.url());
    if (
      url.pathname !== SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH ||
      response.request().method().toUpperCase() !== "POST"
    )
      return null;
    return {
      hostname: url.hostname,
      pathname: url.pathname,
      queryKeys: [...new Set(
        [...url.searchParams.keys()].filter((key) => /^[A-Za-z0-9_.-]+$/u.test(key)),
      )].sort(),
    };
  } catch {
    return null;
  }
}

function formatResponseDiagnostics(
  diagnostics: readonly SinopacCurrentDepositResponseDiagnostic[],
): string {
  return diagnostics
    .slice(0, 8)
    .map(
      (entry) =>
        `hostname=${entry.hostname || "<empty>"}, path=${entry.pathname}, queryKeys=${
          entry.queryKeys.join(",") || "<none>"
        }`,
    )
    .join("; ");
}

function responseMatches(response: Response): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.protocol === "https:" &&
      url.hostname === SINOPAC_CURRENT_DEPOSIT_BALANCE_HOST &&
      url.pathname === SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH &&
      hasApprovedTransportQuery(url) &&
      response.request().method().toUpperCase() === "POST"
    );
  } catch {
    return false;
  }
}

/**
 * Navigate to the authenticated balance page and passively capture the POST
 * it triggers.  The response body is awaited to completion before parsing;
 * the HTML shell is never treated as a balance table or time source.
 */
export async function readSinopacCurrentDepositBalances(
  page: Page,
  input: Readonly<{ observedAt: string; timeoutMs?: number }>,
): Promise<readonly SinopacCurrentDepositBalanceRow[]> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const diagnostics: SinopacCurrentDepositResponseDiagnostic[] = [];
  const diagnosticListener = (candidate: Response) => {
    const diagnostic = sinopacCurrentDepositResponseDiagnostic(candidate);
    if (diagnostic) diagnostics.push(diagnostic);
  };
  page.on("response", diagnosticListener);
  try {
    let listener: ((response: Response) => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const responsePromise = new Promise<Response>((resolve, reject) => {
      listener = (response) => {
        if (!responseMatches(response)) return;
        if (timeout) clearTimeout(timeout);
        resolve(response);
      };
      page.on("response", listener);
      timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for SinoPac ${SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}.`,
          ),
        );
      }, timeoutMs);
    });
    // Consume rejection immediately so a response timeout cannot become an
    // unhandled rejection while page.goto is still waiting on navigation.
    const responseOutcome = responsePromise.then(
      (response) => ({ response } as const),
      (error) => ({ error } as const),
    );
    try {
      await page.goto(SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      const settled = await responseOutcome;
      if ("error" in settled) throw settled.error;
      const response = settled.response;
      const headers = await response.allHeaders();
      const body = await response.body();
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(body).toString("utf8"));
      } catch {
        throw new Error("SinoPac current deposit balance response is not valid JSON.");
      }
      return parseSinopacCurrentDepositBalanceSnapshot({
        payload,
        response: {
          url: response.url(),
          status: response.status(),
          method: response.request().method(),
          headers,
        },
        observedAt: input.observedAt,
      });
    } catch (error) {
      if (diagnostics.length === 0) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message} SinoPac balance response candidates: ${formatResponseDiagnostics(diagnostics)}`,
        { cause: error },
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      if (listener) page.off("response", listener);
    }
  } finally {
    page.off("response", diagnosticListener);
  }
}
