import { createHash, randomUUID } from "node:crypto";
import type { Locator, Page, Response } from "playwright";
import {
  CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS,
  type CurrentDepositAuthorityRoute,
  type CurrentDepositRouteContract,
} from "../ledger/canonical/current-deposit-route-contracts.ts";
import { parseProviderDecimal, type ProviderDecimalPolicy } from "../lib/shared-money/exact-money.ts";
import {
  type DecodedProviderEvidence,
  isDeclaredProviderResponse,
  type ProviderResponse,
  type ProviderResponseDeclaration,
  type ProviderEvidence,
  type VerifiedProviderResponse,
} from "./provider-response.ts";
import { frameScope, type FrameScope } from "./frame-scope.ts";
import type { CathayStrictSourceOptions } from "./cathay-statements.ts";
import { collapseSourceWhitespace } from "../lib/automation/source-text.ts";
import {
  assembleCurrentDepositCapture,
  type CurrentDepositBalanceEntry,
  type CurrentBalanceCaptureMatching,
  CURRENT_DEPOSIT_BALANCE_STAGING,
  type CurrentStateSnapshotDeclaration,
} from "./current-state-snapshot-capture.ts";
import type { CanonicalFinancialDepositCapture } from "../ledger/canonical/canonical-financial-deposit-admission.ts";
import type {
  CurrentDepositBalanceCaptureInput,
  CurrentDepositTimeEvidence,
} from "../ledger/pglite/current-deposit-admission.ts";

const DOMESTIC_CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["cathay/domestic-deposit/current-balance-v1"];
const FOREIGN_CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["cathay/foreign-currency/current-balance-v1"];

export const CATHAY_CURRENT_DOMESTIC_UI_PATH =
  "/OnlineBanking/AcctInq/B0101_DepInq" as const;
const CATHAY_CURRENT_FOREIGN_UI_PATH =
  "/OnlineBanking/FAcctInq/R0101_FDepInq" as const;
const CATHAY_CURRENT_DEPOSIT_TIME_BOUND_MS = 5 * 60 * 1000;

export type CathayCurrentDepositKind = "domestic" | "foreign";
type CathayCurrentDepositStream =
  | "domestic-deposit"
  | "foreign-currency-deposit";
type CathayCurrentDepositObservationKind = "ledger" | "available";

type CathayCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  sourceLexeme: string;
}>;

function cathayCurrentDepositResponse(
  contract: CurrentDepositRouteContract,
): ProviderResponseDeclaration<"required"> {
  return {
    label: "Cathay current deposit",
    host: contract.endpointHost,
    endpoints: [{
      path: contract.endpointPath,
      method: "POST",
      // Cathay's JSON APIs have labeled their bodies both ways.
      contentType: /^(?:application\/json|text\/plain)\s*(?:;.*)?$/isu,
      // Cathay has never constrained the overview's query string.
      search: /^.*$/su,
    }],
    cacheControl: contract.requiredCacheTokens,
    providerDate: "required",
  };
}

/** The 臺幣帳戶總覽 overview POST. */
const CATHAY_CURRENT_DOMESTIC_RESPONSE = cathayCurrentDepositResponse(DOMESTIC_CONTRACT);
/** The 外幣帳戶總覽 overview POST. */
const CATHAY_CURRENT_FOREIGN_RESPONSE = cathayCurrentDepositResponse(FOREIGN_CONTRACT);

export function cathayCurrentDepositResponseDeclaration(
  kind: CathayCurrentDepositKind,
): ProviderResponseDeclaration<"required"> {
  return kind === "domestic" ? CATHAY_CURRENT_DOMESTIC_RESPONSE : CATHAY_CURRENT_FOREIGN_RESPONSE;
}

type CathayCurrentDepositObservation = Readonly<{
  kind: CathayCurrentDepositObservationKind;
  amount: CathayCurrentDepositExactDecimal;
  currency: string;
  effectiveAt: string;
  effectiveTimeBasis: "provider-system-time";
  effectiveTimeEvidence: Readonly<{
    sourceField: "systemTime";
    value: string;
    httpDate: string;
  }>;
}>;

type CathayCurrentDomesticDepositBalanceRow = Readonly<{
  source: "cathay";
  kind: "domestic";
  stream: "domestic-deposit";
  /** Existing Cathay account identity from the UI selector. */
  sourceAccountKey: string;
  /** The UI account value used for the exact overview binding. */
  uiAccountNumber: string;
  /** Provider overview evidence; never used as the canonical account key. */
  providerAccountNumber: string;
  currency: "TWD";
  ledger: CathayCurrentDepositExactDecimal;
  available: CathayCurrentDepositExactDecimal;
  observations: readonly [CathayCurrentDepositObservation, CathayCurrentDepositObservation];
  providerSystemTime: string;
  effectiveAt: string;
  httpDate: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof DOMESTIC_CONTRACT.endpointPath;
    uiPath: typeof CATHAY_CURRENT_DOMESTIC_UI_PATH;
    status: 200;
    responseDigest: string;
    contractVersion: typeof DOMESTIC_CONTRACT.contractVersion;
  }>;
}>;

type CathayCurrentForeignDepositBalanceRow = Readonly<{
  source: "cathay";
  kind: "foreign";
  stream: "foreign-currency-deposit";
  /** Cathay's existing FX demand-account identity. */
  sourceAccountKey: string;
  accountNumber: string;
  currency: string;
  currencySourceCode: string;
  ledger: CathayCurrentDepositExactDecimal;
  /** FX current-state source does not provide an available balance. */
  observations: readonly [CathayCurrentDepositObservation];
  providerSystemTime: string;
  effectiveAt: string;
  httpDate: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof FOREIGN_CONTRACT.endpointPath;
    uiPath: typeof CATHAY_CURRENT_FOREIGN_UI_PATH;
    status: 200;
    responseDigest: string;
    contractVersion: typeof FOREIGN_CONTRACT.contractVersion;
  }>;
}>;

type CathayCurrentDepositBalanceRow =
  | CathayCurrentDomesticDepositBalanceRow
  | CathayCurrentForeignDepositBalanceRow;

type CathayCurrentDepositSnapshotInput = Readonly<{
  kind: CathayCurrentDepositKind;
  response: VerifiedProviderResponse<"required">;
  rawBody: string;
  /** Required for domestic rows to bind API accountNo to the UI account key. */
  uiAccountNumbers?: readonly string[];
}>;

type CathayDomesticApiRow = {
  accountType?: unknown;
  accountNo?: unknown;
  accountName?: unknown;
  accountNickName?: unknown;
  accountBalance?: unknown;
  avaliableBalance?: unknown;
  datas?: unknown;
};

type CathayDomesticApiResponse = {
  success?: unknown;
  systemTime?: unknown;
  content?: {
    depositData?: {
      queryStatus?: unknown;
      totalAccountBalance?: unknown;
      totalAvaliableBalance?: unknown;
      datas?: unknown;
    };
    timeDepositData?: unknown;
  };
};

type CathayForeignApiDetail = {
  currencyId?: unknown;
  currencyCode?: unknown;
  currency?: unknown;
  balance?: unknown;
  equalTwdBalance?: unknown;
  dueDate?: unknown;
};

type CathayForeignApiAccount = {
  account?: unknown;
  nickName?: unknown;
  demandType?: unknown;
  status?: unknown;
  details?: unknown;
};

type CathayForeignApiResponse = {
  success?: unknown;
  systemTime?: unknown;
  content?: {
    isGetDemandAccountSuccess?: unknown;
    demandAccounts?: unknown;
    depositAccounts?: unknown;
  };
};

type CathayJsonParseContext = { source: string };

/** Preserve the provider's numeric token lexeme before decimal admission. */
function parseCathayCurrentApiJson<T>(source: string): T {
  const reviver = function (
    this: unknown,
    _key: string,
    value: unknown,
  ): unknown {
    const context = arguments[2] as CathayJsonParseContext | undefined;
    if (typeof value !== "number") return value;
    if (!context || typeof context.source !== "string") {
      throw new Error("Cathay current deposit numeric response lacks lexical evidence.");
    }
    return context.source;
  };
  return JSON.parse(source, reviver) as T;
}

function responseDigest(rawBody: string): string {
  return `sha256:${createHash("sha256").update(rawBody, "utf8").digest("base64url")}`;
}

function validateCalendarDate(date: string, label: string): void {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`${label} has an invalid calendar date.`);
  }
}

function validateSystemTime(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Cathay current deposit response systemTime is required.");
  }
  const match =
    /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/u.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) {
    throw new Error("Cathay current deposit systemTime is invalid.");
  }
  validateCalendarDate(match[1]!, "Cathay current deposit systemTime");
  return value;
}

function compareProviderTimes(systemTime: string, httpEffectiveAt: string): void {
  const delta = Math.abs(Date.parse(systemTime) - Date.parse(httpEffectiveAt));
  if (!Number.isFinite(delta) || delta > CATHAY_CURRENT_DEPOSIT_TIME_BOUND_MS) {
    throw new Error("Cathay current deposit systemTime is inconsistent with HTTP Date.");
  }
}

const CATHAY_AMOUNT: ProviderDecimalPolicy = {
  internalWhitespace: "strip",
  grouping: "thousands",
  digits: "decimal",
};

function parseExactDecimal(value: unknown, label: string): CathayCurrentDepositExactDecimal {
  if (typeof value !== "string") {
    throw new Error(`Cathay current deposit ${label} lacks exact JSON lexical evidence.`);
  }
  const sourceLexeme = collapseSourceWhitespace(value);
  const amount = parseProviderDecimal(sourceLexeme, CATHAY_AMOUNT);
  if (!amount) {
    throw new Error(`Cathay current deposit ${label} is not an exact decimal.`);
  }
  return { ...amount, sourceLexeme };
}

function parseAccount(value: unknown, label: string, digits: number): string {
  if (typeof value !== "string" || !new RegExp(`^\\d{${digits}}$`, "u").test(value)) {
    throw new Error(`Cathay current deposit ${label} account is invalid.`);
  }
  return value;
}

function requireSuccess(value: unknown): void {
  if (value !== true) throw new Error("Cathay current deposit API response was not successful.");
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Cathay current deposit ${label} is missing.`);
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cathay current deposit ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function observation(
  kind: CathayCurrentDepositObservationKind,
  amount: CathayCurrentDepositExactDecimal,
  currency: string,
  systemTime: string,
  httpDate: string,
): CathayCurrentDepositObservation {
  return {
    kind,
    amount,
    currency,
    effectiveAt: systemTime,
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeEvidence: {
      sourceField: "systemTime",
      value: systemTime,
      httpDate,
    },
  };
}

function domesticRows(
  response: VerifiedProviderResponse<"required">,
  rawBody: string,
  uiAccountNumbers: readonly string[] | undefined,
): readonly CathayCurrentDomesticDepositBalanceRow[] {
  const { observedAt } = response;
  const httpDate = response.providerDate.raw;
  const parsed = parseCathayCurrentApiJson<CathayDomesticApiResponse>(rawBody);
  requireSuccess(parsed.success);
  const systemTime = validateSystemTime(parsed.systemTime);
  compareProviderTimes(systemTime, response.providerDate.effectiveAt);
  const digest = responseDigest(rawBody);
  const content = requireObject(parsed.content, "domestic content");
  const depositData = requireObject(content.depositData, "domestic depositData");
  const queryStatus = depositData.queryStatus;
  if (typeof queryStatus !== "string" || !queryStatus.trim()) {
    throw new Error("Cathay current domestic response queryStatus is missing.");
  }
  const accounts = requireArray(depositData.datas, "domestic account data");
  if (!uiAccountNumbers || uiAccountNumbers.length === 0) {
    throw new Error("Cathay current domestic UI account binding is missing.");
  }
  const normalizedUi = uiAccountNumbers.map((value) => parseAccount(value, "UI", 12));
  const rows: CathayCurrentDomesticDepositBalanceRow[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < accounts.length; index += 1) {
    const account = requireObject(accounts[index], `domestic account ${index}`) as CathayDomesticApiRow;
    const providerAccountNumber = parseAccount(account.accountNo, `domestic row ${index}`, 16);
    const matchingUi = normalizedUi.filter((ui) => providerAccountNumber === `0000${ui}`);
    if (matchingUi.length !== 1) {
      throw new Error(`Cathay current domestic row ${index} does not bind exactly to a UI account.`);
    }
    const uiAccountNumber = matchingUi[0]!;
    if (seen.has(uiAccountNumber)) throw new Error("Cathay current domestic has duplicate UI account rows.");
    seen.add(uiAccountNumber);
    const ledger = parseExactDecimal(account.accountBalance, `domestic row ${index} ledger balance`);
    const available = parseExactDecimal(account.avaliableBalance, `domestic row ${index} available balance`);
    rows.push({
      source: "cathay",
      kind: "domestic",
      stream: "domestic-deposit",
      sourceAccountKey: uiAccountNumber,
      uiAccountNumber,
      providerAccountNumber,
      currency: "TWD",
      ledger,
      available,
      observations: [
        observation("ledger", ledger, "TWD", systemTime, httpDate),
        observation("available", available, "TWD", systemTime, httpDate),
      ],
      providerSystemTime: systemTime,
      effectiveAt: systemTime,
      httpDate,
      observedAt,
      sourceEvidence: {
        endpoint: DOMESTIC_CONTRACT.endpointPath,
        uiPath: CATHAY_CURRENT_DOMESTIC_UI_PATH,
        status: 200,
        responseDigest: digest,
        contractVersion: DOMESTIC_CONTRACT.contractVersion,
      },
    });
  }
  if (rows.length === 0) throw new Error("Cathay current domestic response has no accounts.");
  if (seen.size !== normalizedUi.length) {
    throw new Error("Cathay current domestic UI account binding is incomplete.");
  }
  return rows;
}

function foreignRows(
  response: VerifiedProviderResponse<"required">,
  rawBody: string,
): readonly CathayCurrentForeignDepositBalanceRow[] {
  const { observedAt } = response;
  const httpDate = response.providerDate.raw;
  const parsed = parseCathayCurrentApiJson<CathayForeignApiResponse>(rawBody);
  requireSuccess(parsed.success);
  const systemTime = validateSystemTime(parsed.systemTime);
  compareProviderTimes(systemTime, response.providerDate.effectiveAt);
  const digest = responseDigest(rawBody);
  const content = requireObject(parsed.content, "foreign content");
  if (content.isGetDemandAccountSuccess !== true) {
    throw new Error("Cathay current foreign demand-account response was not successful.");
  }
  const accounts = requireArray(content.demandAccounts, "foreign demand accounts");
  const rows: CathayCurrentForeignDepositBalanceRow[] = [];
  const seen = new Set<string>();
  for (let accountIndex = 0; accountIndex < accounts.length; accountIndex += 1) {
    const account = requireObject(accounts[accountIndex], `foreign account ${accountIndex}`) as CathayForeignApiAccount;
    if (account.demandType !== "DemandDeposit" || account.status !== "Normal") {
      throw new Error(`Cathay current foreign account ${accountIndex} is not a normal demand account.`);
    }
    const accountNumber = parseAccount(account.account, `foreign row ${accountIndex}`, 12);
    const details = requireArray(account.details, `foreign account ${accountIndex} details`);
    if (details.length === 0) throw new Error(`Cathay current foreign account ${accountIndex} has no currency details.`);
    for (let detailIndex = 0; detailIndex < details.length; detailIndex += 1) {
      const detail = requireObject(details[detailIndex], `foreign detail ${accountIndex}/${detailIndex}`) as CathayForeignApiDetail;
      if (typeof detail.currencyCode !== "string" || !/^[A-Z]{3}$/u.test(detail.currencyCode)) {
        throw new Error(`Cathay current foreign detail ${accountIndex}/${detailIndex} currencyCode is invalid.`);
      }
      const currency = detail.currencyCode;
      const duplicateKey = `${accountNumber}\u0000${currency}`;
      if (seen.has(duplicateKey)) throw new Error("Cathay current foreign has duplicate account/currency rows.");
      seen.add(duplicateKey);
      const ledger = parseExactDecimal(detail.balance, `foreign detail ${accountIndex}/${detailIndex} ledger balance`);
      rows.push({
        source: "cathay",
        kind: "foreign",
        stream: "foreign-currency-deposit",
        sourceAccountKey: accountNumber,
        accountNumber,
        currency,
        currencySourceCode: currency,
        ledger,
        observations: [observation("ledger", ledger, currency, systemTime, httpDate)],
        providerSystemTime: systemTime,
        effectiveAt: systemTime,
        httpDate,
        observedAt,
        sourceEvidence: {
          endpoint: FOREIGN_CONTRACT.endpointPath,
          uiPath: CATHAY_CURRENT_FOREIGN_UI_PATH,
          status: 200,
          responseDigest: digest,
          contractVersion: FOREIGN_CONTRACT.contractVersion,
        },
      });
    }
  }
  if (rows.length === 0) throw new Error("Cathay current foreign response has no demand-account currencies.");
  return rows;
}

export function parseCathayCurrentDepositBalanceSnapshot(
  input: CathayCurrentDepositSnapshotInput,
): readonly CathayCurrentDepositBalanceRow[] {
  if (input.kind === "domestic") return domesticRows(input.response, input.rawBody, input.uiAccountNumbers);
  return foreignRows(input.response, input.rawBody);
}

async function findExactControl(
  scope: FrameScope,
  text: string,
  timeoutMs: number,
): Promise<Locator> {
  const { page } = scope;
  const matcher = new RegExp(`^\\s*${text}\\s*$`, "u");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const controls = scope.locator("a, button, [role='button']").filter({ hasText: matcher });
      const count = await controls.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (await control.isVisible().catch(() => false)) return control;
      }
    }
    await scope.pause(250);
  }
  throw new Error(`Could not find Cathay control "${text}".`);
}

async function readDomesticUiAccountNumbers(scope: FrameScope, timeoutMs: number): Promise<readonly string[]> {
  const { page } = scope;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const buttons = scope.locator("table button");
      const count = await buttons.count().catch(() => 0);
      const accounts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const label = collapseSourceWhitespace(await buttons.nth(index).innerText().catch(() => ""));
        if (/^\d{12}$/u.test(label)) accounts.push(label);
      }
      if (accounts.length > 0) return accounts;
    }
    await scope.pause(250);
  }
  throw new Error("Could not read Cathay domestic UI account buttons.");
}

function responseMatches(
  kind: CathayCurrentDepositKind,
  response: Response,
): boolean {
  return isDeclaredProviderResponse(
    cathayCurrentDepositResponseDeclaration(kind),
    response.url(),
    response.request().method(),
  );
}

/** The overview response Cathay's page triggers, before decoding. */
export type CathayCurrentDepositResponse = Readonly<{
  evidence: Extract<ProviderEvidence, { kind: "json" }>;
  response: ProviderResponse;
  /** Domestic only: the account buttons the overview renders, which bind each row to its UI account. */
  uiAccountNumbers?: readonly string[];
}>;

/**
 * Open the 臺幣 or 外幣 account overview through the authenticated menu and
 * passively observe the one overview POST it triggers.
 */
export async function readCathayCurrentDepositBalanceResponse(
  page: Page,
  kind: CathayCurrentDepositKind,
  source: CathayStrictSourceOptions,
  input: Readonly<{ timeoutMs?: number }> = {},
): Promise<CathayCurrentDepositResponse> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const scope = frameScope(page, source.signal);
  let matching = 0;
  const listener = (candidate: Response) => {
    if (responseMatches(kind, candidate)) matching += 1;
  };
  page.on("response", listener);
  try {
    const section = await findExactControl(scope, kind === "domestic" ? "臺幣" : "外幣", timeoutMs);
    await scope.withSignal((signal) => section.click({ signal }));
    const overview = await findExactControl(
      scope,
      kind === "domestic" ? "臺幣帳戶總覽" : "外幣帳戶總覽",
      timeoutMs,
    );
    const { response, evidence } = await source.reader.acquire(
      scope,
      cathayCurrentDepositResponseDeclaration(kind),
      {
        evidence: "json",
        trigger: () => scope.withSignal((signal) => overview.click({ signal })),
        timeoutMs,
      },
    );
    const uiAccountNumbers =
      kind === "domestic"
        ? await readDomesticUiAccountNumbers(scope, timeoutMs)
        : undefined;
    if (matching !== 1) {
      throw new Error("Cathay current balance source response was missing or ambiguous.");
    }
    return { evidence, response, ...(uiAccountNumbers ? { uiAccountNumbers } : {}) };
  } finally {
    page.off("response", listener);
  }
}

const CATHAY_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE =
  "cathay/domestic-deposit/current-balance-v1" as const;
const CATHAY_CURRENT_FOREIGN_BALANCE_AUTHORITY_ROUTE =
  "cathay/foreign-currency/current-balance-v1" as const;

type CathayCurrentDepositCanonicalContext = Readonly<{
  sourceConnectionKey: string;
  identityEpochKey: string;
  subjectDigest: string;
  observedAt: string;
  scopeDate: string;
}>;

type Group = {
  readonly row: CathayCurrentDepositBalanceRow;
  readonly rows: readonly CathayCurrentDepositBalanceRow[];
};

function token(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}

function routeFor(row: CathayCurrentDepositBalanceRow): CurrentDepositAuthorityRoute {
  return row.kind === "domestic"
    ? CATHAY_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE
    : CATHAY_CURRENT_FOREIGN_BALANCE_AUTHORITY_ROUTE;
}

function sourceField(
  row: CathayCurrentDepositBalanceRow,
  kind: CathayCurrentDepositObservation["kind"],
): string {
  if (row.kind === "foreign") return "balance";
  return kind === "ledger" ? "accountBalance" : "avaliableBalance";
}

function sourceAccountEvidence(row: CathayCurrentDepositBalanceRow): Record<string, unknown> {
  if (row.kind === "domestic") {
    return {
      uiAccountNumber: row.uiAccountNumber,
      providerAccountNumber: row.providerAccountNumber,
    };
  }
  return {
    providerAccountNumber: row.accountNumber,
    currencySourceCode: row.currencySourceCode,
  };
}

function timeEvidence(
  row: CathayCurrentDepositBalanceRow,
): CurrentDepositTimeEvidence {
  const { contractVersion } = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[routeFor(row)];
  return {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeRuleVersion: contractVersion,
    sourceField: "systemTime",
    sourceValue: row.providerSystemTime,
    contractVersion,
  };
}

function balanceEntry(
  row: CathayCurrentDepositBalanceRow,
  observation: CathayCurrentDepositObservation,
): CurrentDepositBalanceEntry {
  const route = routeFor(row);
  const identity = `${route}|${row.sourceAccountKey}|${observation.currency}|${observation.kind}`;
  const sourceRecordKey = token(
    `cathay/current-deposit-source-record/v1|${identity}|${row.sourceEvidence.responseDigest}`,
  );
  return {
    sourceRecordKey,
    providerKey: token(`cathay/current-deposit-provider-record/v1|${sourceRecordKey}`),
    observationKey: token(`cathay/current-deposit-observation/v1|${identity}`),
    balanceKind: observation.kind,
    sourceField: sourceField(row, observation.kind),
    currency: observation.currency,
    value: {
      coefficient: observation.amount.coefficient,
      scale: observation.amount.scale,
    },
    time: timeEvidence(row),
    timeInRecord: true,
    compact: {
      source: "cathay",
      endpoint: row.sourceEvidence.endpoint,
      responseDigest: row.sourceEvidence.responseDigest,
      httpDate: row.httpDate,
      providerSystemTime: row.providerSystemTime,
      sourceLexeme: observation.amount.sourceLexeme,
      ...sourceAccountEvidence(row),
    },
  };
}

function groupRows(
  rows: readonly CathayCurrentDepositBalanceRow[],
): readonly Group[] {
  if (rows.length === 0) {
    throw new Error("Cathay current deposit balance capture has no rows.");
  }
  const groups = new Map<string, CathayCurrentDepositBalanceRow[]>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.stream}\u0000${row.sourceAccountKey}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ row: group[0]!, rows: group }));
}

function validateGroupMetadata(group: Group): void {
  const first = group.row;
  for (const row of group.rows) {
    if (
      row.sourceEvidence.endpoint !== first.sourceEvidence.endpoint ||
      row.sourceEvidence.responseDigest !== first.sourceEvidence.responseDigest ||
      row.providerSystemTime !== first.providerSystemTime ||
      row.effectiveAt !== first.effectiveAt ||
      row.httpDate !== first.httpDate ||
      row.observedAt !== first.observedAt
    ) {
      throw new Error("Cathay current deposit account rows have inconsistent source metadata.");
    }
  }
}

function buildCathayCurrentDepositBalanceCaptures(
  rows: readonly CathayCurrentDepositBalanceRow[],
  context: CathayCurrentDepositCanonicalContext,
): readonly CurrentDepositBalanceCaptureInput[] {
  const captures: CurrentDepositBalanceCaptureInput[] = [];
  for (const group of groupRows(rows)) {
    validateGroupMetadata(group);
    const row = group.row;
    if (context.observedAt !== row.observedAt) {
      throw new Error(
        "Cathay current deposit capture observedAt must be sampled after the provider response.",
      );
    }
    const entries = group.rows.flatMap((currentRow) =>
      currentRow.observations.map((observation) => balanceEntry(currentRow, observation)),
    );
    const route = routeFor(row);
    const contract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[route];
    const endpoint = `https://${contract.endpointHost}${row.sourceEvidence.endpoint}`;
    captures.push(assembleCurrentDepositCapture({
      captureId: randomUUID(),
      authorityRoute: route,
      contractVersion: contract.contractVersion,
      subjectDigest: context.subjectDigest,
      identity: {
        integrationNamespace: "cathay",
        sourceConnectionKey: context.sourceConnectionKey,
        identityEpochKey: context.identityEpochKey,
        stream: row.stream,
        sourceAccountKey: row.sourceAccountKey,
      },
      observedAt: context.observedAt,
      scope: {
        startDate: context.scopeDate,
        endDate: context.scopeDate,
        contractFingerprint: route,
        preflightFingerprint: `${route}/source-page-v1`,
      },
      providerResponse: {
        endpoint,
        status: 200,
      },
      page: {
        responseDigest: row.sourceEvidence.responseDigest,
        proofKind: "cathay-current-deposit-provider-snapshot",
        contractFingerprint: route,
        preflightFingerprint: `${route}/source-page-v1`,
        metadata: {
          source: "cathay",
          endpoint: row.sourceEvidence.endpoint,
          uiPath: row.sourceEvidence.uiPath,
          httpDate: row.httpDate,
          providerSystemTime: row.providerSystemTime,
          responseDigest: row.sourceEvidence.responseDigest,
          scopeDate: context.scopeDate,
        },
      },
    }, entries));
  }
  return captures;
}

/**
 * The module's parsed value has lost the provider's numeric lexemes, which
 * carry each balance's scale, so the row parser reads its decoded text.
 */
function parseOverview(
  kind: CathayCurrentDepositKind,
  decoded: DecodedProviderEvidence<CathayCurrentDepositResponse["evidence"]>,
  response: VerifiedProviderResponse<"required">,
  acquired: CathayCurrentDepositResponse,
): readonly CathayCurrentDepositBalanceRow[] {
  return parseCathayCurrentDepositBalanceSnapshot({
    kind,
    response,
    rawBody: decoded.text,
    ...(acquired.uiAccountNumbers ? { uiAccountNumbers: acquired.uiAccountNumbers } : {}),
  });
}

function requireEveryAdmittedAccount(
  admittedKeys: readonly string[],
  matched: readonly Readonly<{ row: Readonly<{ sourceAccountKey: string }> }>[],
  message: string,
): void {
  const matchedKeys = new Set(matched.map(({ row }) => row.sourceAccountKey));
  if (admittedKeys.some((key) => !matchedKeys.has(key))) throw new Error(message);
}

/** One foreign account's overview rows, one per currency it holds. */
type CathayForeignOverviewAccount = Readonly<{
  sourceAccountKey: string;
  rows: readonly CathayCurrentDepositBalanceRow[];
}>;

function groupForeignAccounts(
  rows: readonly CathayCurrentDepositBalanceRow[],
): readonly CathayForeignOverviewAccount[] {
  const accounts = new Map<string, CathayCurrentDepositBalanceRow[]>();
  for (const row of rows) {
    const account = accounts.get(row.sourceAccountKey) ?? [];
    account.push(row);
    accounts.set(row.sourceAccountKey, account);
  }
  return [...accounts].map(([sourceAccountKey, accountRows]) => ({ sourceAccountKey, rows: accountRows }));
}

/** The admitted deposit capture a Cathay balance row joins to. */
export type CathayAdmittedDeposit = Readonly<{
  identity: Pick<
    CanonicalFinancialDepositCapture["identity"],
    "sourceConnectionKey" | "identityEpochKey" | "stream" | "subjectDigest" | "accountNo" | "sourceAccountKey"
  >;
}>;

function admittedAccountKey({ identity }: CathayAdmittedDeposit): string {
  return identity.sourceAccountKey ?? identity.accountNo;
}

/**
 * A Cathay balance row joins the admitted deposit of its account. Captures
 * sharing an account, such as one per foreign currency, must agree on its
 * identity, and a row for an account the run did not admit is skipped.
 */
const cathayCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  Readonly<{ sourceAccountKey: string }>,
  CathayAdmittedDeposit
> = {
  captureKey: admittedAccountKey,
  rowKey: (row) => row.sourceAccountKey,
  duplicates: "first-wins",
  sameIdentity: (kept, candidate) => kept.identity.subjectDigest === candidate.identity.subjectDigest,
  ambiguousMessage: "Cathay admitted deposit identities are ambiguous.",
  oneScope: {
    scope: ({ identity }) => `${identity.sourceConnectionKey}\u0000${identity.identityEpochKey}\u0000${identity.stream}`,
    message: "Cathay admitted deposits do not share one source identity.",
  },
  unmatched: { kind: "skip" },
};

/** One balance capture per admitted domestic account, from its overview row. */
export function cathayDomesticCurrentBalanceSnapshot(
  admitted: readonly CathayAdmittedDeposit[],
): CurrentStateSnapshotDeclaration<CathayCurrentDepositResponse, CathayCurrentDepositBalanceRow, CathayAdmittedDeposit> {
  return {
    product: "domestic-current-balance",
    response: CATHAY_CURRENT_DOMESTIC_RESPONSE,
    parse: (decoded, response, acquired) => parseOverview("domestic", decoded, response, acquired),
    kind: CURRENT_DEPOSIT_BALANCE_STAGING,
    matching: cathayCurrentBalanceCaptureMatching,
    build: (row, { identity }) => {
      if (row.stream !== identity.stream) {
        throw new Error("Cathay domestic current balance row stream does not match its admitted capture.");
      }
      return onlyCapture(buildCathayCurrentDepositBalanceCaptures([row], {
        sourceConnectionKey: identity.sourceConnectionKey,
        identityEpochKey: identity.identityEpochKey,
        subjectDigest: cathayCurrentSubjectDigest(identity.sourceConnectionKey, identity.identityEpochKey),
        observedAt: row.observedAt,
        scopeDate: row.observedAt.slice(0, 10),
      }));
    },
    validate: ({ matched }) => requireEveryAdmittedAccount(
      admitted.map(admittedAccountKey),
      matched,
      "Cathay domestic current balance source omitted a selected account.",
    ),
  };
}

/** One balance capture per admitted foreign account, holding every currency the overview lists for it. */
export function cathayForeignCurrentBalanceSnapshot(
  admitted: readonly CathayAdmittedDeposit[],
): CurrentStateSnapshotDeclaration<CathayCurrentDepositResponse, CathayForeignOverviewAccount, CathayAdmittedDeposit> {
  return {
    product: "foreign-current-balance",
    response: CATHAY_CURRENT_FOREIGN_RESPONSE,
    parse: (decoded, response, acquired) =>
      groupForeignAccounts(parseOverview("foreign", decoded, response, acquired)),
    kind: CURRENT_DEPOSIT_BALANCE_STAGING,
    matching: cathayCurrentBalanceCaptureMatching,
    build: (account, { identity }) => onlyCapture(buildCathayCurrentDepositBalanceCaptures(account.rows, {
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      subjectDigest: identity.subjectDigest,
      observedAt: account.rows[0]!.observedAt,
      scopeDate: account.rows[0]!.observedAt.slice(0, 10),
    })),
    validate: ({ matched }) => {
      if (matched.length === 0) {
        throw new Error("Cathay current foreign balance response did not contain an admitted account.");
      }
      requireEveryAdmittedAccount(
        admitted.map(admittedAccountKey),
        matched,
        "Cathay current foreign balance response omitted an admitted account.",
      );
    },
  };
}

function onlyCapture(
  captures: readonly CurrentDepositBalanceCaptureInput[],
): CurrentDepositBalanceCaptureInput {
  if (captures.length !== 1) throw new Error("Cathay current deposit account built more than one capture.");
  return captures[0]!;
}

function cathayCurrentSubjectDigest(
  sourceConnectionKey: string,
  identityEpochKey: string,
): string {
  return token(
    `cathay/current-deposit-subject/v1|${sourceConnectionKey}|${identityEpochKey}`,
  );
}
