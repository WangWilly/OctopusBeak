import { parseProviderDecimal, type ProviderDecimalPolicy } from "../lib/shared-money/exact-money.ts";
import {
  isDeclaredProviderResponse,
  type ProviderResponse,
  type ProviderResponseDeclaration,
  type SnapshotEvidence,
  type VerifiedProviderResponse,
} from "./current-state-snapshot-capture.ts";
import type { SinopacMmaRoute, SinopacMmaSite } from "./sinopac-mma-site.ts";

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

/** The ws_bankbal POST; a 13-digit cache-busting key is its only allowed query. */
export const SINOPAC_CURRENT_DEPOSIT_RESPONSE: ProviderResponseDeclaration<"required"> = {
  label: "SinoPac current deposit",
  host: SINOPAC_CURRENT_DEPOSIT_BALANCE_HOST,
  endpoints: [{
    path: SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
    method: "POST",
    contentType: /^application\/json\s*;\s*charset\s*=\s*utf-8$/iu,
    search: /^(?:\?\d{13}(?:=[^&]*)?)?$/u,
  }],
  cacheControl: ["no-cache", "no-store"],
  providerDate: "required",
};

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

const SINOPAC_AMOUNT: ProviderDecimalPolicy = {
  internalWhitespace: "reject",
  grouping: "thousands",
  digits: "decimal",
};

function parseExactDecimal(
  value: unknown,
  label: string,
): SinopacCurrentDepositExactDecimal {
  const sourceLexeme = requiredString(value, label);
  const amount = parseProviderDecimal(sourceLexeme, SINOPAC_AMOUNT);
  if (!amount)
    throw new Error(`SinoPac current deposit ${label} is not an exact decimal.`);
  return { ...amount, sourceLexeme };
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
  response: VerifiedProviderResponse<"required">,
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
    effectiveAt: response.providerDate.effectiveAt,
    providerHttpDate: response.providerDate.raw,
    observedAt: response.observedAt,
    sourceEvidence: {
      endpoint: SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
      status: 200,
      contentType: SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTENT_TYPE,
      cacheControl: response.cacheControl,
      contractVersion: SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
    },
  };
}

/** Parse one completed ws_bankbal JSON response without coercing provider amounts. */
export function parseSinopacCurrentDepositBalanceSnapshot(input: Readonly<{
  payload: unknown;
  response: VerifiedProviderResponse<"required">;
}>): readonly SinopacCurrentDepositBalanceRow[] {
  if (!Array.isArray(input.payload) || input.payload.length !== 1)
    throw new Error("SinoPac current deposit response must contain one envelope.");
  const envelope = input.payload[0];
  if (!isRecord(envelope))
    throw new Error("SinoPac current deposit response envelope is invalid.");
  if (envelope.Header !== "SUCCESS")
    throw new Error(`SinoPac current deposit response failed: ${String(envelope.Message ?? "unknown")}`);
  if (!Array.isArray(envelope.SubInfo) || envelope.SubInfo.length === 0)
    throw new Error("SinoPac current deposit response SubInfo is missing or empty.");
  const rows = envelope.SubInfo.map((row, rowIndex) => parseRow(row, rowIndex, input.response));
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.sourceAccountKey}\u0000${row.currency}`;
    if (seen.has(key))
      throw new Error("SinoPac current deposit response has a duplicate account/currency row.");
    seen.add(key);
  }
  return rows;
}

/** The ws_bankbal response SinoPac's balance page triggers, before decoding. */
export type SinopacCurrentDepositResponse = Readonly<{
  evidence: Extract<SnapshotEvidence, { kind: "json" }>;
  response: ProviderResponse;
}>;

/** The balance page; its HTML shell is never treated as a balance table or time source. */
export const SINOPAC_CURRENT_DEPOSIT_BALANCE_ROUTE: SinopacMmaRoute = {
  url: SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL,
  description: "the SinoPac balance page",
  response: (url, method) => isDeclaredProviderResponse(SINOPAC_CURRENT_DEPOSIT_RESPONSE, url, method),
};

/** Open the authenticated balance page and observe the POST it triggers. */
export async function readSinopacCurrentDepositBalanceResponse(site: SinopacMmaSite): Promise<SinopacCurrentDepositResponse> {
  const { bytes, response } = await site.open(SINOPAC_CURRENT_DEPOSIT_BALANCE_ROUTE);
  return { evidence: { kind: "json", bytes }, response };
}
