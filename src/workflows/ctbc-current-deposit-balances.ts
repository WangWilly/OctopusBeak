import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../ledger/canonical/canonical-digest.ts";
import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import type {
  CurrentDepositBalanceCaptureInput,
  CurrentDepositExactAmount,
} from "../ledger/pglite/current-deposit-admission.ts";
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
import {
  assembleCurrentDepositCapture,
  CURRENT_DEPOSIT_BALANCE_STAGING,
  type CurrentBalanceCaptureMatching,
  type CurrentStateSnapshotDeclaration,
} from "./current-state-snapshot-capture.ts";

/**
 * CTBC renders the summary shell first and fills it with this authenticated
 * resource request. The response is the balance source; the page text is only
 * used to reach the provider's normal, user-facing route.
 */
const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["ctbc/domestic-deposit/current-balance-v1"];
/** The provider's observed transport discriminator; its value is never retained. */
export const CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY = "IIhfvu" as const;
const CTBC_CURRENT_DEPOSIT_BALANCE_PAGE_URL =
  "https://www.ctbcbank.com/twrbc/twrbc-deposit/qu001/010" as const;
const CTBC_CURRENT_DEPOSIT_BALANCE_METHOD = "POST" as const;

type CtbcCurrentDepositExactDecimal = Readonly<{
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

type CtbcCurrentDepositBalanceRow = Readonly<{
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

/** The admitted CTBC statement identity a current balance joins. */
export type ExistingCtbcFinancialCapture = Readonly<{
  authorityRoute: string;
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

/**
 * Join the current summary to an already admitted CTBC statement identity.
 * The provider accountId is retained as exact evidence, including leading
 * zeroes; no current-summary row can create a new canonical account.
 */
function buildCtbcCurrentDepositBalanceCapture(
  row: CtbcCurrentDepositBalanceRow,
  financialCapture: ExistingCtbcFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const identity = financialCapture.identity;
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  if (
    financialCapture.authorityRoute !== "ctbc/domestic-deposit/human-attested-v1" ||
    identity.integrationNamespace !== "ctbc" ||
    identity.stream !== "domestic-deposit" ||
    identity.currency !== "TWD"
  )
    throw new Error("CTBC current deposit identity is not an admitted TWD CTBC account.");
  if (
    identity.accountNo !== row.accountNumber ||
    sourceAccountKey !== row.sourceAccountKey ||
    identity.accountNumber?.value !== row.accountNumber
  )
    throw new Error(
      "CTBC current deposit accountId does not exactly match existing account evidence.",
    );

  const balance: CurrentDepositExactAmount = {
    coefficient: row.ledger.coefficient,
    scale: row.ledger.scale,
  };
  const sourceRecordKey = canonicalDigest(
    "ctbc-current-deposit-source-record-v1",
    sourceAccountKey,
    row.effectiveAt,
    balance.coefficient,
    String(balance.scale),
  );
  const scopeDate = row.providerDataTime.slice(0, 10).replaceAll("/", "-");
  const route = "ctbc/domestic-deposit/current-balance-v1";
  const contract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[route];
  const contractVersion = contract.contractVersion;
  return assembleCurrentDepositCapture({
    captureId: `ctbc-current-${randomUUID()}`,
    authorityRoute: route,
    contractVersion,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "ctbc",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: "domestic-deposit",
      sourceAccountKey,
    },
    observedAt: row.observedAt,
    scope: {
      startDate: scopeDate,
      endDate: scopeDate,
      contractFingerprint: canonicalDigest("ctbc-current-deposit-contract-v1", route),
      preflightFingerprint: canonicalDigest(
        "ctbc-current-deposit-preflight-v1",
        identity.subjectDigest,
        scopeDate,
      ),
    },
    providerResponse: {
      endpoint: `https://${contract.endpointHost}${row.sourceEvidence.endpoint}`,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
      requestResource: row.sourceEvidence.requestResource,
    },
    page: {
      metadata: {
        source: "ctbc-current-deposit-summary",
        endpoint: row.sourceEvidence.endpoint,
        resource: row.sourceEvidence.requestResource,
        accountId: row.accountNumber,
        providerServerTime: row.providerServerTime,
        providerDataTime: row.providerDataTime,
        providerHttpDate: row.providerHttpDate,
      },
    },
  }, [{
    sourceRecordKey,
    providerKey: canonicalDigest(
      "ctbc-current-deposit-provider-record-v1",
      sourceAccountKey,
      row.effectiveAt,
    ),
    observationKey: canonicalDigest("ctbc-current-deposit-observation-v1", sourceAccountKey),
    balanceKind: "ledger",
    sourceField: "balance",
    currency: row.currency,
    value: balance,
    time: {
      effectiveAt: row.effectiveAt,
      effectiveTimeBasis: "provider-system-time",
      effectiveTimeRuleVersion: contractVersion,
      sourceField: "serverTime",
      sourceValue: String(row.providerServerTime),
      contractVersion,
    },
    timeInRecord: true,
    compact: {
      source: "ctbc",
      accountId: row.accountNumber,
      sourceAccountKey,
      currency: row.currency,
      sourceLexeme: row.ledger.sourceLexeme,
      providerFields: { ...row.providerFields },
      providerServerTime: row.providerServerTime,
      providerDataTime: row.providerDataTime,
      providerHttpDate: row.providerHttpDate,
      requestResource: row.sourceEvidence.requestResource,
      sourceEvidence: { ...row.sourceEvidence },
    },
  }]);
}

/**
 * CTBC keys a balance by each capture's own stream and source account key.
 * Every CTBC capture carries one constant source connection and the identity
 * epoch of the run's single human attestation manifest, so captures spanning
 * more than one connection or epoch fail closed before matching. A row with
 * no admitted capture fails the run. The first capture wins.
 */
const ctbcCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  Readonly<{ stream: string; sourceAccountKey: string }>,
  ExistingCtbcFinancialCapture
> = {
  captureKey: ({ identity }) =>
    `${identity.stream}\u0000${identity.sourceAccountKey ?? identity.accountNo}`,
  rowKey: (row) => `${row.stream}\u0000${row.sourceAccountKey}`,
  duplicates: "first-wins",
  sameIdentity: (kept, candidate) =>
    kept.identity.sourceConnectionKey === candidate.identity.sourceConnectionKey &&
    kept.identity.identityEpochKey === candidate.identity.identityEpochKey &&
    kept.authorityRoute === candidate.authorityRoute &&
    kept.identity.accountNo === candidate.identity.accountNo &&
    kept.identity.accountNumber?.value === candidate.identity.accountNumber?.value &&
    kept.identity.subjectDigest === candidate.identity.subjectDigest &&
    kept.identity.currency === candidate.identity.currency,
  ambiguousMessage: "CTBC current deposit identities are ambiguous across financial captures.",
  oneScope: {
    scope: ({ identity }) => `${identity.sourceConnectionKey}\u0000${identity.identityEpochKey}`,
    message:
      "CTBC current deposit captures span more than one source connection or identity epoch.",
  },
  unmatched: {
    kind: "throw",
    message: "CTBC current deposit snapshot has no admitted account identity.",
  },
};

export const ctbcCurrentBalanceSnapshot: CurrentStateSnapshotDeclaration<
  CtbcCurrentDepositResponse,
  CtbcCurrentDepositBalanceRow,
  ExistingCtbcFinancialCapture
> = {
  product: "current-balance",
  response: CTBC_CURRENT_DEPOSIT_RESPONSE,
  parse: (decoded, response, acquired) => parseCtbcCurrentDepositBalanceSnapshot({
    payload: decoded.value,
    response,
    requestPostData: acquired.requestPostData,
  }),
  kind: CURRENT_DEPOSIT_BALANCE_STAGING,
  matching: ctbcCurrentBalanceCaptureMatching,
  build: buildCtbcCurrentDepositBalanceCapture,
};
