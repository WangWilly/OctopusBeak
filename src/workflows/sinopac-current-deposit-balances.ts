import { canonicalDigest } from "../ledger/canonical/canonical-digest.ts";
import {
  CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS,
  type CurrentDepositAuthorityRoute,
} from "../ledger/canonical/current-deposit-route-contracts.ts";
import type {
  CurrentDepositBalanceCaptureInput,
  CurrentDepositExactAmount,
} from "../ledger/pglite/current-deposit-admission.ts";
import { parseProviderDecimal, type ProviderDecimalPolicy } from "../lib/shared-money/exact-money.ts";
import {
  type ProviderResponse,
  type ProviderResponseDeclaration,
  type ProviderEvidence,
  type VerifiedProviderResponse,
} from "./provider-response.ts";
import type { ProviderResponseReader } from "./provider-response-reader.ts";
import type { SinopacMmaRoute, SinopacMmaSite } from "./sinopac-mma-site.ts";
import { trimSourceLexeme } from "../lib/automation/source-text.ts";
import {
  assembleCurrentDepositCapture,
  CURRENT_DEPOSIT_BALANCE_STAGING,
  type CurrentBalanceCaptureMatching,
  type CurrentStateSnapshotDeclaration,
} from "./current-state-snapshot-capture.ts";

export const SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL =
  "https://mma.sinopac.com/mma/bank/bankbal/mma_bankbal.aspx?1" as const;
const SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTENT_TYPE =
  "application/json;charset=UTF-8" as const;

type SinopacCurrentDepositStream =
  | "domestic-deposit"
  | "foreign-currency-deposit";

type SinopacCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  /** The provider string after only surrounding whitespace cleanup. */
  sourceLexeme: string;
}>;

/**
 * SinoPac renders the account-summary HTML shell first and fills its balance
 * table from this authenticated POST.  The POST is the balance source; the
 * shell is not a second source of rows or provider time.
 *
 * One POST serves both streams, so the declaration reads the domestic route's
 * contract; a check pins that the foreign route's contract agrees.
 */
const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["sinopac/domestic-deposit/current-balance-v1"];

/** The ws_bankbal POST; a 13-digit cache-busting key is its only allowed query. */
export const SINOPAC_CURRENT_DEPOSIT_RESPONSE: ProviderResponseDeclaration<"required"> = {
  label: "SinoPac current deposit",
  host: CONTRACT.endpointHost,
  endpoints: [{
    path: CONTRACT.endpointPath,
    method: "POST",
    contentType: /^application\/json\s*;\s*charset\s*=\s*utf-8$/iu,
    search: /^(?:\?\d{13}(?:=[^&]*)?)?$/u,
  }],
  cacheControl: CONTRACT.requiredCacheTokens,
  providerDate: "required",
};

type SinopacCurrentDepositBalanceRow = Readonly<{
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
    endpoint: typeof CONTRACT.endpointPath;
    status: 200;
    contentType: typeof SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTENT_TYPE;
    cacheControl: string;
    contractVersion: typeof CONTRACT.contractVersion;
  }>;
}>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const text = trimSourceLexeme(value);
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
      endpoint: CONTRACT.endpointPath,
      status: 200,
      contentType: SINOPAC_CURRENT_DEPOSIT_BALANCE_CONTENT_TYPE,
      cacheControl: response.cacheControl,
      contractVersion: CONTRACT.contractVersion,
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
  evidence: Extract<ProviderEvidence, { kind: "json" }>;
  response: ProviderResponse;
}>;

/** The balance page; its HTML shell is never treated as a balance table or time source. */
export const SINOPAC_CURRENT_DEPOSIT_BALANCE_ROUTE: SinopacMmaRoute = {
  url: SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL,
  description: "the SinoPac balance page",
  response: SINOPAC_CURRENT_DEPOSIT_RESPONSE,
};

/** Open the authenticated balance page and read the POST it triggers; the snapshot module accepts it. */
export async function readSinopacCurrentDepositBalanceResponse(
  site: SinopacMmaSite,
  reader: ProviderResponseReader,
): Promise<SinopacCurrentDepositResponse> {
  return await site.open(SINOPAC_CURRENT_DEPOSIT_BALANCE_ROUTE, reader);
}

/** The admitted SinoPac statement identity a current balance joins. */
export type ExistingSinopacFinancialCapture = Readonly<{
  identity: Readonly<{
    integrationNamespace: string;
    sourceConnectionKey: string;
    identityEpochKey: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
    stream: string;
  }>;
  /** The statement's typed currency scope is needed for FX identity joining. */
  sourceCurrency: string;
}>;

/**
 * Build a point-in-time current-balance capture from a row and an identity
 * that has already crossed the ordinary SinoPac financial admission.  The
 * provider's AvailBalance is the only observation; MaxAvail and FixBalance
 * remain source evidence and never become available or ledger amounts.
 */
function buildSinopacCurrentDepositBalanceCapture(
  row: SinopacCurrentDepositBalanceRow,
  financialCapture: ExistingSinopacFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const identity = financialCapture.identity;
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  if (identity.integrationNamespace !== "sinopac")
    throw new Error("SinoPac current deposit identity has the wrong source.");
  if (sourceAccountKey !== row.sourceAccountKey || identity.accountNo !== row.accountNumber)
    throw new Error(
      "SinoPac current deposit account does not match an existing DataValue identity.",
    );

  const route: CurrentDepositAuthorityRoute =
    row.stream === "domestic-deposit"
      ? "sinopac/domestic-deposit/current-balance-v1"
      : "sinopac/foreign-currency/current-balance-v1";
  const contract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[route];
  const contractVersion = contract.contractVersion;
  const balance: CurrentDepositExactAmount = {
    coefficient: row.ledger.coefficient,
    scale: row.ledger.scale,
  };
  const sourceField = "AvailBalance";
  const time = {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: "provider-http-date" as const,
    effectiveTimeRuleVersion: contractVersion,
    sourceField: "HTTP Date",
    sourceValue: row.providerHttpDate,
    contractVersion,
  };
  const scopeDate = row.effectiveAt.slice(0, 10);
  return assembleCurrentDepositCapture({
    captureId: `sinopac-current-${canonicalDigest(
      "sinopac-current-deposit-capture-v1",
      row.stream,
      sourceAccountKey,
      row.currency,
      row.effectiveAt,
    ).slice("sha256:".length)}-${Date.now()}`,
    authorityRoute: route,
    contractVersion,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "sinopac",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: row.stream,
      sourceAccountKey,
    },
    observedAt: row.observedAt,
    scope: { startDate: scopeDate, endDate: scopeDate },
    providerResponse: {
      endpoint: `https://${contract.endpointHost}${row.sourceEvidence.endpoint}`,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
    },
    page: {
      metadata: {
        source: "sinopac-current-deposit-summary",
        sourceRowCount: 1,
        balanceField: sourceField,
        contentType: row.sourceEvidence.contentType,
        providerHttpDate: row.providerHttpDate,
      },
    },
  }, [{
    sourceRecordKey: canonicalDigest(
      "sinopac-current-deposit-source-record-v1",
      row.stream,
      sourceAccountKey,
      row.currency,
      row.effectiveAt,
      balance.coefficient,
      String(balance.scale),
    ),
    providerKey: canonicalDigest(
      "sinopac-current-deposit-provider-record-v1",
      row.stream,
      row.accountNumber,
      row.currency,
      row.effectiveAt,
    ),
    observationKey: canonicalDigest(
      "sinopac-current-deposit-observation-v1",
      row.stream,
      sourceAccountKey,
      row.currency,
    ),
    balanceKind: "ledger",
    sourceField,
    currency: row.currency,
    value: balance,
    time,
    timeInRecord: true,
    compact: {
      source: "sinopac",
      accountNumber: row.accountNumber,
      sourceAccountKey,
      accountText: row.accountText,
      accountValueFormat: row.accountValueFormat,
      currencyText: row.currencyText,
      effectiveAt: row.effectiveAt,
      effectiveTimeSourceField: "HTTP Date",
      effectiveTimeSourceValue: row.providerHttpDate,
      sourceEvidence: { ...row.sourceEvidence },
      providerFields: { ...row.providerFields },
    },
  }]);
}

function sinopacCaptureAccount(capture: ExistingSinopacFinancialCapture): string {
  const sourceAccountKey = capture.identity.sourceAccountKey ?? capture.identity.accountNo;
  return `${capture.identity.stream}\u0000${sourceAccountKey}`;
}

/**
 * SinoPac keys a balance by stream, source account and currency. A row for an
 * account the run never admitted is skipped, but a row for an admitted account
 * in another currency is a currency mismatch. The first capture under a key wins.
 */
const sinopacCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  SinopacCurrentDepositBalanceRow,
  ExistingSinopacFinancialCapture
> = {
  captureKey: (capture) => `${sinopacCaptureAccount(capture)}\u0000${capture.sourceCurrency}`,
  rowKey: (row) => `${row.stream}\u0000${row.sourceAccountKey}\u0000${row.currency}`,
  duplicates: "first-wins",
  sameIdentity: (kept, candidate) =>
    kept.identity.sourceConnectionKey === candidate.identity.sourceConnectionKey &&
    kept.identity.identityEpochKey === candidate.identity.identityEpochKey &&
    kept.identity.subjectDigest === candidate.identity.subjectDigest,
  ambiguousMessage: "SinoPac current deposit identities are ambiguous across financial captures.",
  unmatched: {
    kind: "skip",
    throwWhenAccountAdmitted: {
      rowAccount: (row) => `${row.stream}\u0000${row.sourceAccountKey}`,
      captureAccount: sinopacCaptureAccount,
      message: "SinoPac current deposit currency does not match the existing statement scope.",
    },
  },
};


export const sinopacCurrentBalanceSnapshot: CurrentStateSnapshotDeclaration<
  SinopacCurrentDepositResponse,
  SinopacCurrentDepositBalanceRow,
  ExistingSinopacFinancialCapture
> = {
  product: "current-balance",
  response: SINOPAC_CURRENT_DEPOSIT_RESPONSE,
  parse: (decoded, response) => parseSinopacCurrentDepositBalanceSnapshot({ payload: decoded.value, response }),
  kind: CURRENT_DEPOSIT_BALANCE_STAGING,
  matching: sinopacCurrentBalanceCaptureMatching,
  build: buildSinopacCurrentDepositBalanceCapture,
};
