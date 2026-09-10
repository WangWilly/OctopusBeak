import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  withCanonicalSourceCaptureAdmissionTransaction,
  type CanonicalSourceCaptureAdmissionTransactionCapability,
} from "./canonical-source-capture-admission.ts";
import {
  stableCanonicalSourceJson,
  type CanonicalSourcePage,
} from "./canonical-source-evidence.ts";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import { assertValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";

export type CurrentDepositBalanceKind = "ledger" | "available";

export type CurrentDepositExactAmount = Readonly<{
  coefficient: string;
  scale: number;
}>;

export type CurrentDepositAccountScope = Readonly<{
  integrationNamespace: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  stream: "domestic-deposit" | "foreign-currency-deposit";
  /** Existing canonical source identity. This may be an opaque digest. */
  sourceAccountKey: string;
}>;

export type CurrentDepositTimeEvidence = Readonly<{
  effectiveAt: string;
  effectiveTimeBasis: "provider-http-date" | "provider-system-time";
  effectiveTimeRuleVersion: string;
  sourceField: string;
  sourceValue: string;
  contractVersion: string;
}>;

/**
 * Typed discriminants for providers whose balance endpoint is shared by many
 * business operations.  Only these routing fields cross the canonical seam;
 * request headers, credentials, and payload data stay in the browser adapter.
 */
export type CurrentDepositRequestDiscriminant = Readonly<{
  txnCode: string;
  bizCode: string;
  pageCount: number;
}>;

export type CurrentDepositBalanceObservationInput = Readonly<{
  /** Provider-stable observation key before currency is added to identity. */
  observationKey: string;
  balanceKind: CurrentDepositBalanceKind;
  balance: CurrentDepositExactAmount;
  currency: string;
  time: CurrentDepositTimeEvidence;
  sourceRecordKey: string;
  /** Exact source field label, such as 帳面餘額 or availableBalance. */
  sourceField: string;
}>;

export type CurrentDepositSourceRecordInput = Readonly<{
  sourceRecordKey: string;
  providerKey: string;
  contentHash: string;
  compact: Record<string, unknown>;
  description?: string | null;
}>;

export type CurrentDepositBalanceCaptureInput = Readonly<{
  captureId: string;
  authorityRoute: string;
  contractVersion: string;
  subjectDigest: string;
  identity: CurrentDepositAccountScope;
  observedAt: string;
  scope: Readonly<{
    startDate: string;
    endDate: string;
    contractFingerprint?: string;
    preflightFingerprint?: string;
  }>;
  providerResponse: Readonly<{
    endpoint: string;
    status: 200;
    cacheControl?: string;
    /** Provider request discriminant required by routes that share an endpoint. */
    requestResource?: string;
    /** Typed business-operation discriminant for a shared provider endpoint. */
    requestDiscriminant?: CurrentDepositRequestDiscriminant;
  }>;
  pages: readonly CanonicalSourcePage[];
  records: readonly CurrentDepositSourceRecordInput[];
  observations: readonly CurrentDepositBalanceObservationInput[];
}>;

export type CurrentDepositBalanceValidatedCapture =
  CurrentDepositBalanceCaptureInput & {
    readonly __runtimeValidatedCurrentDepositBalance: true;
  };

export type CurrentDepositBalanceWriterStore = CanonicalSourceStore;

export type CurrentDepositBalanceCommitResult = Readonly<{
  status: "canonical-live";
  captureId: string;
  accountId: string;
  commitSequence: number;
  observationCount: number;
  revisionCount: number;
  deduplicatedRevisionCount: number;
}>;

export class CanonicalCurrentDepositBalanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalCurrentDepositBalanceConflictError";
  }
}

type CurrentDepositRouteContract = Readonly<{
  integrationNamespace: string;
  stream: CurrentDepositAccountScope["stream"];
  contractVersion: string;
  endpointHost: string;
  endpointPath: string;
  endpointQuery?: Readonly<Record<string, string>>;
  /** Additional query keys whose values are validated against a route pattern. */
  endpointQueryPatterns?: Readonly<Record<string, RegExp>>;
  /** Optional request discriminator for a shared provider endpoint. */
  requestResource?: string;
  /** Optional typed business-operation discriminator for a shared endpoint. */
  requestDiscriminant?: CurrentDepositRequestDiscriminant;
  effectiveTimeBasis: CurrentDepositTimeEvidence["effectiveTimeBasis"];
  effectiveTimeSourceField: string;
  /** Additional provider time evidence accepted by this route. */
  effectiveTimeAlternates?: readonly Readonly<{
    effectiveTimeBasis: CurrentDepositTimeEvidence["effectiveTimeBasis"];
    effectiveTimeSourceField: string;
  }>[];
  requiredCacheTokens: readonly string[];
  fields: Readonly<{
    ledger: readonly string[];
    available: readonly string[];
  }>;
}>;

/** The only current-balance endpoint/time contracts accepted by the core. */
export const CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS: Readonly<
  Record<string, CurrentDepositRouteContract>
> = Object.freeze({
  "cathay/domestic-deposit/current-balance-v1": {
    integrationNamespace: "cathay",
    stream: "domestic-deposit",
    contractVersion: "cathay/current-deposit-balance-v1",
    endpointHost: "www.cathaybk.com.tw",
    endpointPath:
      "/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_DepositOverview",
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeSourceField: "systemTime",
    requiredCacheTokens: [],
    fields: {
      ledger: ["accountBalance"],
      available: ["avaliableBalance"],
    },
  },
  "cathay/foreign-currency/current-balance-v1": {
    integrationNamespace: "cathay",
    stream: "foreign-currency-deposit",
    contractVersion: "cathay/current-deposit-balance-v1",
    endpointHost: "www.cathaybk.com.tw",
    endpointPath:
      "/OnlineBankingApi/ClientForeign/Api/ClientForeign/R_ACCT_Q_OverView",
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeSourceField: "systemTime",
    requiredCacheTokens: [],
    fields: {
      ledger: ["balance"],
      available: [],
    },
  },
  "ctbc/domestic-deposit/current-balance-v1": {
    integrationNamespace: "ctbc",
    stream: "domestic-deposit",
    contractVersion: "ctbc/current-deposit-balance-v1",
    endpointHost: "www.ctbcbank.com",
    endpointPath: "/IB/api/adapters/IB_Adapter/resource/ebmwResource",
    requestResource: "/twrbc-deposit/qu001/010",
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeSourceField: "serverTime",
    requiredCacheTokens: ["no-cache", "no-store", "must-revalidate"],
    fields: {
      ledger: ["balance"],
      available: [],
    },
  },
  "fubon/domestic-deposit/current-balance-v1": {
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    contractVersion: "fubon/current-deposit-balance-v1",
    endpointHost: "ebank.taipeifubon.com.tw",
    endpointPath: "/B2C/cboqu/cboqu003/CBOQU003_Home.faces",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-store", "no-cache"],
    fields: {
      ledger: ["即時餘額"],
      available: ["可用餘額"],
    },
  },
  "hncb/domestic-deposit/current-balance-v1": {
    integrationNamespace: "hncb",
    stream: "domestic-deposit",
    contractVersion: "hncb/current-deposit-balance-v1",
    endpointHost: "netbank.hncb.com.tw",
    endpointPath: "/netbank/servlet/TrxDispatcher",
    endpointQuery: { trx: "com.lb.wibc.trx.EAccDDSummary" },
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-store"],
    fields: {
      ledger: ["帳上餘額"],
      available: ["可用餘額"],
    },
  },
  "hncb/domestic-deposit/current-balance-overview-v1": {
    integrationNamespace: "hncb",
    stream: "domestic-deposit",
    contractVersion: "hncb/current-deposit-balance-overview-v1",
    endpointHost: "netbank.hncb.com.tw",
    endpointPath: "/netbank/servlet/TrxDispatcher",
    endpointQuery: {
      trx: "com.lb.wibc.trx.AcctInfoInq",
      state: "prompt",
    },
    endpointQueryPatterns: {
      time_str: /^\d{14}$/u,
    },
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-store"],
    fields: {
      ledger: ["帳上餘額"],
      available: ["原幣"],
    },
  },
  "sinopac/domestic-deposit/current-balance-v1": {
    integrationNamespace: "sinopac",
    stream: "domestic-deposit",
    contractVersion: "sinopac/current-deposit-balance-v1",
    endpointHost: "mma.sinopac.com",
    endpointPath: "/ws/bank/bankbal/ws_bankbal.ashx",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-cache", "no-store"],
    fields: {
      ledger: ["AvailBalance"],
      available: [],
    },
  },
  "sinopac/foreign-currency/current-balance-v1": {
    integrationNamespace: "sinopac",
    stream: "foreign-currency-deposit",
    contractVersion: "sinopac/current-deposit-balance-v1",
    endpointHost: "mma.sinopac.com",
    endpointPath: "/ws/bank/bankbal/ws_bankbal.ashx",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-cache", "no-store"],
    fields: {
      ledger: ["AvailBalance"],
      available: [],
    },
  },
  "yuanta/domestic-deposit/current-balance-v1": {
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersion: "yuanta/current-deposit-balance-v1",
    endpointHost: "ebank.yuantabank.com.tw",
    endpointPath: "/nib/tx/finance_overview_for_summary",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-store"],
    fields: {
      ledger: ["帳面餘額"],
      available: ["可用餘額"],
    },
  },
  "yuanta/foreign-currency/current-balance-v1": {
    integrationNamespace: "yuanta",
    stream: "foreign-currency-deposit",
    contractVersion: "yuanta/current-deposit-balance-v1",
    endpointHost: "ebank.yuantabank.com.tw",
    endpointPath: "/nib/tx/finance_overview_for_summary",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-store"],
    fields: {
      ledger: ["帳面餘額"],
      available: ["可用餘額"],
    },
  },
  "linebank/domestic-deposit/current-balance-v1": {
    integrationNamespace: "linebank",
    stream: "domestic-deposit",
    contractVersion: "linebank/current-deposit-balance-v1",
    endpointHost: "accessibility.linebank.com.tw",
    endpointPath: "/v1/account/common/payables",
    endpointQuery: { featureTypeCode: "01" },
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-cache", "no-store"],
    fields: {
      ledger: [],
      available: ["wdrwAvblAmt"],
    },
  },
  "post/domestic-deposit/current-balance-v1": {
    integrationNamespace: "post",
    stream: "domestic-deposit",
    contractVersion: "post/current-deposit-balance-v1",
    endpointHost: "ipost.post.gov.tw",
    endpointPath: "/pst/EsoafDispatcher",
    requestDiscriminant: {
      txnCode: "EB100103",
      bizCode: "getOverViewById",
      pageCount: 50,
    },
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    effectiveTimeAlternates: [
      {
        effectiveTimeBasis: "provider-system-time",
        effectiveTimeSourceField: "SERVER_TIMESTAMP",
      },
    ],
    requiredCacheTokens: ["no-store"],
    fields: {
      ledger: ["BAL"],
      available: [],
    },
  },
});

const HNCB_CURRENT_DEPOSIT_OVERVIEW_ROUTE =
  "hncb/domestic-deposit/current-balance-overview-v1";

const VALIDATED_CAPTURES = new WeakSet<object>();
const OPAQUE = /^sha256:[A-Za-z0-9_-]+$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u;

function fail(message: string): never {
  throw new CanonicalCurrentDepositBalanceConflictError(message);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required.`);
  return value.trim();
}

function requireOpaque(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!OPAQUE.test(text)) fail(`${label} must be an opaque sha256 token.`);
  return text;
}

function requireIsoDate(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!ISO_DATE.test(text) || new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text)
    fail(`${label} must be a valid YYYY-MM-DD date.`);
  return text;
}

function requireRfc3339(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!RFC3339.test(text) || !Number.isFinite(Date.parse(text)))
    fail(`${label} must be RFC3339.`);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/u.exec(text);
  if (!match) fail(`${label} must be RFC3339.`);
  if ((match[2]?.length ?? 0) > 9)
    fail(`${label} must use at most 9 fractional-second digits.`);
  const civil = new Date(`${match[1]}Z`);
  if (Number.isNaN(civil.getTime()) || civil.toISOString().slice(0, 19) !== match[1])
    fail(`${label} must contain a valid calendar instant.`);
  if (match[3] !== "Z") {
    const [hours, minutes] = match[3].slice(1).split(":").map(Number);
    if (hours > 23 || minutes > 59) fail(`${label} has an invalid numeric offset.`);
  }
  return text;
}

const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

function canonicalInstant(value: string): string {
  if (RFC3339.test(value)) {
    requireRfc3339(value, "Current deposit instant");
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/u.exec(value);
    if (!match) fail("Current deposit instant must be RFC3339.");
    const milliseconds = Date.parse(value);
    const seconds = Math.floor(milliseconds / 1000);
    const fraction = (match[2] ?? "").padEnd(9, "0").slice(0, 9);
    return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${fraction}Z`;
  }
  if (HTTP_DATE.test(value)) {
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toUTCString() !== value)
      fail("Current deposit provider HTTP Date is invalid.");
    const iso = new Date(milliseconds).toISOString();
    // RFC3339 inputs are normalized to nanosecond-shaped precision above.
    // Keep the original HTTP Date as evidence, but compare and key the same
    // instant with the same canonical precision (`.000Z` must equal
    // `.000000000Z`).
    return `${iso.slice(0, 19)}.${iso.slice(20, 23).padEnd(9, "0")}Z`;
  }
  fail("Current deposit provider time must be RFC3339 or an IMF-fixdate HTTP Date.");
}

function providerTimeInstant(
  value: string,
  basis: CurrentDepositTimeEvidence["effectiveTimeBasis"],
): string {
  if (basis === "provider-http-date" && !HTTP_DATE.test(value))
    fail("Current deposit provider HTTP Date is invalid.");
  if (basis === "provider-system-time") {
    if (RFC3339.test(value)) return canonicalInstant(value);
    if (/^\d{13}$/u.test(value)) {
      const milliseconds = Number(value);
      if (Number.isSafeInteger(milliseconds)) {
        const instant = new Date(milliseconds);
        if (
          !Number.isNaN(instant.getTime()) &&
          instant.getTime() === milliseconds
        )
          return canonicalInstant(instant.toISOString());
      }
    }
    if (/^\d{10}$/u.test(value)) {
      const milliseconds = Number(value) * 1_000;
      if (Number.isSafeInteger(milliseconds)) {
        const instant = new Date(milliseconds);
        if (!Number.isNaN(instant.getTime())) return canonicalInstant(instant.toISOString());
      }
    }
    fail("Current deposit provider system time is invalid.");
  }
  return canonicalInstant(value);
}

function requireCurrency(value: unknown, label: string): string {
  const text = requireText(value, label).toUpperCase();
  if (!/^[A-Z]{3}$/u.test(text) || !Intl.supportedValuesOf("currency").includes(text))
    fail(`${label} must be a supported ISO 4217 currency.`);
  return text;
}

function requireAmount(value: unknown, label: string): CurrentDepositExactAmount {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { coefficient?: unknown }).coefficient !== "string" ||
    !/^-?(?:0|[1-9]\d*)$/u.test((value as { coefficient: string }).coefficient) ||
    !Number.isSafeInteger((value as { scale?: unknown }).scale) ||
    Number((value as { scale: number }).scale) < 0
  )
    fail(`${label} must be an exact coefficient/scale amount.`);
  return {
    coefficient: (value as { coefficient: string }).coefficient,
    scale: Number((value as { scale: number }).scale),
  };
}

function normalizedAmount(value: CurrentDepositExactAmount): CurrentDepositExactAmount {
  let coefficient = BigInt(value.coefficient);
  let scale = value.scale;
  if (coefficient === 0n) return { coefficient: "0", scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient: coefficient.toString(), scale };
}

function amountsEqual(left: CurrentDepositExactAmount, right: CurrentDepositExactAmount): boolean {
  const normalizedLeft = normalizedAmount(left);
  const normalizedRight = normalizedAmount(right);
  return normalizedLeft.coefficient === normalizedRight.coefficient &&
    normalizedLeft.scale === normalizedRight.scale;
}

function parseEndpoint(endpoint: string, contract: CurrentDepositRouteContract): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint, "https://canonical.invalid");
  } catch {
    fail("Current deposit provider endpoint is invalid.");
  }
  const authority = /^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/u.exec(endpoint)?.[1] ?? "";
  if (parsed.pathname !== contract.endpointPath)
    fail(`Current deposit endpoint does not match ${contract.endpointPath}.`);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== contract.endpointHost ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    authority.includes("@") ||
    endpoint.includes("#")
  )
    fail("Current deposit provider endpoint host is not contract-approved.");
  const expectedQuery = Object.entries(contract.endpointQuery ?? {});
  const expectedQueryPatterns = Object.entries(contract.endpointQueryPatterns ?? {});
  const actualQuery = [...parsed.searchParams.entries()];
  if (actualQuery.length !== expectedQuery.length + expectedQueryPatterns.length)
    fail("Current deposit endpoint query is not contract-approved.");
  const expectedQueryCounts = new Map<string, number>();
  for (const [key, value] of expectedQuery) {
    const identity = `${key}\u0000${value}`;
    expectedQueryCounts.set(identity, (expectedQueryCounts.get(identity) ?? 0) + 1);
  }
  for (const [key, value] of actualQuery) {
    // Pattern-qualified keys are validated below. Keep them out of the
    // exact-key multiset so a timestamp query cannot be mistaken for an
    // unexpected exact value.
    if (contract.endpointQueryPatterns?.[key] !== undefined) continue;
    const identity = `${key}\u0000${value}`;
    const count = expectedQueryCounts.get(identity) ?? 0;
    if (count === 0)
      fail(`Current deposit endpoint query ${key} is not contract-approved.`);
    if (count === 1) expectedQueryCounts.delete(identity);
    else expectedQueryCounts.set(identity, count - 1);
  }
  if (expectedQueryCounts.size > 0)
    fail("Current deposit endpoint query is not contract-approved.");
  const actualPatternCounts = new Map<string, number>();
  for (const [key, value] of actualQuery) {
    const pattern = contract.endpointQueryPatterns?.[key];
    if (!pattern) continue;
    if (!pattern.test(value))
      fail(`Current deposit endpoint query ${key} is not contract-approved.`);
    actualPatternCounts.set(key, (actualPatternCounts.get(key) ?? 0) + 1);
  }
  for (const [key] of expectedQueryPatterns)
    if (actualPatternCounts.get(key) !== 1)
      fail(`Current deposit endpoint query ${key} is not contract-approved.`);
  return parsed;
}

function validateProviderTime(
  observation: CurrentDepositBalanceObservationInput,
  contract: CurrentDepositRouteContract,
): void {
  const time = observation.time;
  const approvedTimeEvidence = [
    {
      effectiveTimeBasis: contract.effectiveTimeBasis,
      effectiveTimeSourceField: contract.effectiveTimeSourceField,
    },
    ...(contract.effectiveTimeAlternates ?? []),
  ];
  if (!approvedTimeEvidence.some(
    (candidate) =>
      candidate.effectiveTimeBasis === time.effectiveTimeBasis &&
      candidate.effectiveTimeSourceField === time.sourceField,
  ))
    fail("Current deposit effective-time evidence does not match the route contract.");
  if (time.contractVersion !== contract.contractVersion)
    fail("Current deposit effective-time contract version does not match the route.");
  if (time.effectiveTimeRuleVersion !== contract.contractVersion)
    fail("Current deposit time rule version does not match the route.");
  const sourceValue = providerTimeInstant(time.sourceValue, time.effectiveTimeBasis);
  const effectiveAt = canonicalInstant(requireRfc3339(time.effectiveAt, "Current deposit effective time"));
  if (sourceValue !== effectiveAt)
    fail("Current deposit effective time does not match provider time evidence.");
}

function validateCapture(
  input: CurrentDepositBalanceCaptureInput,
  options: Readonly<{ allowExistingIdentityKeys?: boolean }> = {},
): CurrentDepositRouteContract {
  const contract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[input.authorityRoute];
  if (!contract) fail("Current deposit authority route is not contract-approved.");
  if (input.contractVersion !== contract.contractVersion)
    fail("Current deposit capture contract version does not match its route.");
  if (input.identity.integrationNamespace !== contract.integrationNamespace)
    fail("Current deposit integration namespace does not match its route.");
  if (input.identity.stream !== contract.stream)
    fail("Current deposit stream does not match its route.");
  requireText(input.captureId, "Current deposit capture ID");
  requireOpaque(input.subjectDigest, "Current deposit subject digest");
  if (options.allowExistingIdentityKeys) {
    requireText(input.identity.sourceConnectionKey, "Current deposit source connection key");
    requireText(input.identity.identityEpochKey, "Current deposit identity epoch key");
  } else {
    requireOpaque(input.identity.sourceConnectionKey, "Current deposit source connection key");
    requireOpaque(input.identity.identityEpochKey, "Current deposit identity epoch key");
  }
  requireText(input.identity.sourceAccountKey, "Current deposit source account key");
  requireRfc3339(input.observedAt, "Current deposit observedAt");
  const start = requireIsoDate(input.scope.startDate, "Current deposit scope start");
  const end = requireIsoDate(input.scope.endDate, "Current deposit scope end");
  if (start !== end) fail("Current deposit point-in-time scope must have one date.");
  if (input.providerResponse.status !== 200) fail("Current deposit response must be HTTP 200.");
  parseEndpoint(input.providerResponse.endpoint, contract);
  if (
    contract.requestResource !== undefined &&
    input.providerResponse.requestResource !== contract.requestResource
  )
    fail("Current deposit provider request resource is not contract-approved.");
  if (contract.requestResource !== undefined && input.pages.some(
    (page) => page.metadata?.resource !== contract.requestResource,
  ))
    fail("Current deposit source evidence does not preserve the provider request resource.");
  const requestDiscriminant = input.providerResponse.requestDiscriminant;
  if (contract.requestDiscriminant !== undefined) {
    if (
      requestDiscriminant?.txnCode !== contract.requestDiscriminant.txnCode ||
      requestDiscriminant?.bizCode !== contract.requestDiscriminant.bizCode ||
      requestDiscriminant?.pageCount !== contract.requestDiscriminant.pageCount
    )
      fail("Current deposit provider request discriminant is not contract-approved.");
    if (input.pages.some(
      (page) =>
        page.metadata?.txnCode !== contract.requestDiscriminant!.txnCode ||
        page.metadata?.bizCode !== contract.requestDiscriminant!.bizCode ||
        page.metadata?.pageCount !== contract.requestDiscriminant!.pageCount,
    ))
      fail("Current deposit source evidence does not preserve the provider request discriminant.");
  } else if (requestDiscriminant !== undefined) {
    fail("Current deposit provider request discriminant is not route-approved.");
  }
  const cache = (input.providerResponse.cacheControl ?? "").toLowerCase();
  for (const token of contract.requiredCacheTokens)
    if (!new RegExp(`\\b${token}\\b`, "u").test(cache))
      fail(`Current deposit response must carry Cache-Control: ${token}.`);
  if (input.pages.length === 0) fail("Current deposit capture requires a source page.");
  const recordKeys = new Set<string>();
  for (const [index, record] of input.records.entries()) {
    const sourceRecordKey = requireOpaque(record.sourceRecordKey, `Current deposit record ${index} key`);
    requireOpaque(record.providerKey, `Current deposit record ${index} provider key`);
    requireOpaque(record.contentHash, `Current deposit record ${index} content hash`);
    if (recordKeys.has(sourceRecordKey)) fail("Current deposit records contain a duplicate source key.");
    recordKeys.add(sourceRecordKey);
    if (!record.compact || typeof record.compact !== "object" || Array.isArray(record.compact))
      fail(`Current deposit record ${index} compact payload is invalid.`);
    if (currentDepositSourceRecordContentHash(record.compact) !== record.contentHash)
      fail(`Current deposit record ${index} content hash does not match its compact evidence.`);
    if (input.authorityRoute === "hncb/domestic-deposit/current-balance-overview-v1") {
      const currencyResolution = record.compact.currencyResolution;
      if (currencyResolution !== "provider" && currencyResolution !== "canonical-account")
        fail("HNCB current deposit overview currency provenance is missing.");
      if (
        currencyResolution === "canonical-account" &&
        record.compact.currencySourceLexeme !== ""
      )
        fail("HNCB current deposit overview canonical currency must retain a blank provider lexeme.");
    }
  }
  if (input.observations.length === 0) fail("Current deposit capture requires a balance observation.");
  const identities = new Set<string>();
  for (const [index, observation] of input.observations.entries()) {
    const key = requireText(observation.observationKey, `Current deposit observation ${index} key`);
    if (observation.balanceKind !== "ledger" && observation.balanceKind !== "available")
      fail("Current deposit balance kind is unsupported.");
    const currency = requireCurrency(observation.currency, `Current deposit observation ${index} currency`);
    requireAmount(observation.balance, `Current deposit observation ${index} balance`);
    const identity = `${key}\u0000${observation.balanceKind}\u0000${currency}`;
    if (identities.has(identity)) fail("Current deposit observations contain a duplicate identity.");
    identities.add(identity);
    const sourceRecordKey = requireOpaque(observation.sourceRecordKey, `Current deposit observation ${index} source record key`);
    if (!recordKeys.has(sourceRecordKey)) fail("Current deposit observation has no matching source record.");
    const allowedFields = contract.fields[observation.balanceKind];
    if (!allowedFields.includes(observation.sourceField))
      fail("Current deposit balance source field is not contract-approved.");
    validateProviderTime(observation, contract);
    const matchingRecord = input.records.find((record) => record.sourceRecordKey === sourceRecordKey);
    const compact = matchingRecord?.compact;
    if (compact?.sourceField !== observation.sourceField)
      fail("Current deposit source record does not preserve the provider field mapping.");
    if (compact?.balanceKind !== observation.balanceKind)
      fail("Current deposit source record does not preserve the balance kind.");
    if (typeof compact?.currency !== "string" || compact.currency.toUpperCase() !== currency)
      fail("Current deposit source record does not preserve the balance currency.");
    const compactValue = compact?.value;
    if (compactValue === null || typeof compactValue !== "object")
      fail("Current deposit source record does not preserve the exact balance.");
    const compactAmount = requireAmount(compactValue, "Current deposit source record value");
    if (!amountsEqual(compactAmount, observation.balance))
      fail("Current deposit source record amount does not match the observation.");
    if (typeof compact?.effectiveAt !== "string")
      fail("Current deposit source record does not preserve the effective time.");
    if (canonicalInstant(compact.effectiveAt) !== canonicalInstant(requireRfc3339(observation.time.effectiveAt, "Current deposit effective time")))
      fail("Current deposit source record effective time does not match the observation.");
    if (compact.effectiveTimeSourceField !== observation.time.sourceField)
      fail("Current deposit source record does not preserve the time evidence field.");
    if (compact.effectiveTimeSourceValue !== observation.time.sourceValue)
      fail("Current deposit source record does not preserve the time evidence value.");
  }
  const pageRows = input.pages.reduce((sum, page) => sum + page.rowCount, 0);
  if (pageRows !== input.records.length)
    fail("Current deposit page row counts do not match source records.");
  return contract;
}

export function admitCurrentDepositBalanceCapture(
  input: CurrentDepositBalanceCaptureInput,
): CurrentDepositBalanceValidatedCapture {
  // The provider identity is allowed to retain a pre-v26 plain key at this
  // structural seam. Commit-time admission still requires an exact existing
  // financial account before it can persist any evidence.
  validateCapture(input, { allowExistingIdentityKeys: true });
  Object.defineProperty(input, "__runtimeValidatedCurrentDepositBalance", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
  VALIDATED_CAPTURES.add(input);
  return input as CurrentDepositBalanceValidatedCapture;
}

function requireValidatedCapture(input: CurrentDepositBalanceValidatedCapture): void {
  if (!VALIDATED_CAPTURES.has(input)) fail("Current deposit capture did not cross the validated seam.");
}

function sourceEvidenceFromCapture(
  capture: CurrentDepositBalanceValidatedCapture,
): Readonly<{
  captureId: string;
  integrationNamespace: string;
  sourceConnectionKey: string;
  identityEpoch: string;
  stream: string;
  recordKind: string;
  routeKey: string;
  contractVersion: string;
  subjectDigest: string;
  observedAt: string;
  scope: {
    startDate: string;
    endDate: string;
    dateFormat: "YYYY-MM-DD";
    kind: "point-in-time";
    completeness: "single-page";
    ruleVersion: string;
    completenessBasis: string;
    contractFingerprint?: string;
    preflightFingerprint?: string;
    sourceAccountKey: string;
  };
  pages: CanonicalSourcePage[];
  records: {
    occurrenceKey: string;
    collisionKey: string;
    providerKey: string;
    contentHash: string;
    compact: Record<string, unknown>;
    sequenceLexeme: string;
    description: string | null;
  }[];
}> {
  return {
    captureId: capture.captureId,
    integrationNamespace: capture.identity.integrationNamespace,
    sourceConnectionKey: capture.identity.sourceConnectionKey,
    identityEpoch: capture.identity.identityEpochKey,
    stream: capture.identity.stream,
    recordKind: "current-deposit-balance",
    routeKey: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    subjectDigest: capture.subjectDigest,
    observedAt: capture.observedAt,
    scope: {
      startDate: capture.scope.startDate,
      endDate: capture.scope.endDate,
      dateFormat: "YYYY-MM-DD",
      kind: "point-in-time",
      completeness: "single-page",
      ruleVersion: capture.contractVersion,
      completenessBasis: "provider-current-balance-snapshot",
      ...(capture.scope.contractFingerprint && OPAQUE.test(capture.scope.contractFingerprint)
        ? { contractFingerprint: capture.scope.contractFingerprint }
        : {}),
      ...(capture.scope.preflightFingerprint && OPAQUE.test(capture.scope.preflightFingerprint)
        ? { preflightFingerprint: capture.scope.preflightFingerprint }
        : {}),
      sourceAccountKey: capture.identity.sourceAccountKey,
    },
    pages: [...capture.pages],
    records: capture.records.map((record) => ({
      occurrenceKey: record.sourceRecordKey,
      collisionKey: record.sourceRecordKey,
      providerKey: record.providerKey,
      contentHash: record.contentHash,
      compact: record.compact,
      sequenceLexeme: record.sourceRecordKey,
      description: record.description ?? null,
    })),
  };
}

function findExistingAccount(
  db: DatabaseSync,
  identity: CurrentDepositAccountScope,
): { accountId: Buffer; currency: string | null } {
  const row = db
    .prepare(
      `SELECT account.account_id, account.currency
         FROM financial_accounts account
         JOIN source_connections connection_row
           ON connection_row.source_connection_id = account.source_connection_id
         JOIN identity_epochs epoch
           ON epoch.identity_epoch_id = account.identity_epoch_id
        WHERE connection_row.integration_namespace = ?
          AND connection_row.source_connection_key = ?
          AND epoch.epoch_key = ?
          AND account.stream = ?
          AND account.source_account_key = ?
          AND account.account_type = 'depository'`,
    )
    .get(
      identity.integrationNamespace,
      identity.sourceConnectionKey,
      identity.identityEpochKey,
      identity.stream,
      identity.sourceAccountKey,
    ) as { account_id?: unknown; currency?: unknown } | undefined;
  if (!(row?.account_id instanceof Uint8Array))
    fail("Current deposit balance must attach to an existing depository account.");
  return {
    accountId: Buffer.from(row.account_id),
    currency: row.currency == null ? null : String(row.currency),
  };
}

function canonicalObservationKey(
  observation: CurrentDepositBalanceObservationInput,
  currency: string,
): string {
  const effectiveAt = canonicalInstant(
    requireRfc3339(observation.time.effectiveAt, "Current deposit effective time"),
  );
  return `sha256:${createHash("sha256")
    .update(`canonical/depository-balance-observation/v2|${observation.observationKey}|${observation.balanceKind}|${currency}|${effectiveAt}`)
    .digest("base64url")}`;
}

function sourceRecordIdByKey(
  capture: CurrentDepositBalanceValidatedCapture,
  sourceRecordIds: readonly Uint8Array[],
): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  capture.records.forEach((record, index) => {
    const sourceRecordId = sourceRecordIds[index];
    if (!sourceRecordId) fail("Current deposit source record identity is missing.");
    result.set(record.sourceRecordKey, sourceRecordId);
  });
  return result;
}

function persistObservations(
  db: DatabaseSync,
  capture: CurrentDepositBalanceValidatedCapture,
  accountId: Uint8Array,
  sourceCaptureId: Uint8Array,
  commitId: Uint8Array,
  sourceRecordIds: readonly Uint8Array[],
): { revisionCount: number; deduplicatedRevisionCount: number } {
  const recordIds = sourceRecordIdByKey(capture, sourceRecordIds);
  let revisionCount = 0;
  let deduplicatedRevisionCount = 0;
  for (const observation of capture.observations) {
    const currency = observation.currency.toUpperCase();
    const observationKey = canonicalObservationKey(observation, currency);
    const effectiveAt = canonicalInstant(
      requireRfc3339(observation.time.effectiveAt, "Current deposit effective time"),
    );
    const sourceRecordId = recordIds.get(observation.sourceRecordKey);
    if (!sourceRecordId) fail("Current deposit observation source record is missing.");
    const existing = db
      .prepare(
        `SELECT observation_id
           FROM balance_observations
          WHERE account_id = ? AND observation_key = ?
            AND balance_kind = ? AND balance_currency = ?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(accountId, observationKey, observation.balanceKind, currency) as
      | { observation_id?: unknown }
      | undefined;
    const observationId = existing?.observation_id instanceof Uint8Array
      ? Buffer.from(existing.observation_id)
      : randomBytes(16);
    if (!existing)
      db.prepare(
        `INSERT INTO balance_observations(
           observation_id, account_id, observation_key, balance_kind,
           balance_currency, created_capture_id, created_commit_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        observationId,
        accountId,
        observationKey,
        observation.balanceKind,
        currency,
        sourceCaptureId,
        commitId,
      );

    const duplicate = db
      .prepare(
        `SELECT revision_id, balance_coefficient, balance_scale
           FROM balance_observation_revisions
          WHERE observation_id = ? AND currency = ? AND effective_at = ?`,
      )
      .get(
        observationId,
        currency,
        effectiveAt,
      ) as { revision_id?: unknown; balance_coefficient?: unknown; balance_scale?: unknown } | undefined;
    if (duplicate) {
      const existingAmount = requireAmount(
        {
          coefficient: String(duplicate.balance_coefficient ?? ""),
          scale: Number(duplicate.balance_scale ?? -1),
        },
        "Existing current deposit balance",
      );
      if (!amountsEqual(existingAmount, observation.balance))
        fail("Current deposit balance contradicts an existing measurement at the same provider instant.");
      deduplicatedRevisionCount += 1;
      continue;
    }
    const prior = db
      .prepare(
        "SELECT COALESCE(MAX(revision_number), 0) AS revision_number FROM balance_observation_revisions WHERE observation_id = ?",
      )
      .get(observationId) as { revision_number?: unknown };
    db.prepare(
      `INSERT INTO balance_observation_revisions(
         revision_id, observation_id, source_record_id, capture_id, commit_id,
         revision_number, balance_coefficient, balance_scale, currency,
         effective_at, effective_time_basis, effective_time_rule_version,
         effective_time_evidence_source_record_key,
         effective_time_evidence_source_field,
         effective_time_evidence_value,
         effective_time_evidence_contract_version,
         effective_time_evidence_endpoint,
         effective_time_evidence_response_status,
         effective_time_evidence_cache_policy, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomBytes(16),
      observationId,
      sourceRecordId,
      sourceCaptureId,
      commitId,
      Number(prior.revision_number ?? 0) + 1,
      observation.balance.coefficient,
      observation.balance.scale,
      currency,
      effectiveAt,
      observation.time.effectiveTimeBasis,
      observation.time.effectiveTimeRuleVersion,
      observation.sourceRecordKey,
      observation.time.sourceField,
      observation.time.sourceValue,
      observation.time.contractVersion,
      capture.providerResponse.endpoint,
      capture.providerResponse.status,
      capture.providerResponse.cacheControl ?? "provider-contract",
      capture.observedAt,
    );
    revisionCount += 1;
  }
  return { revisionCount, deduplicatedRevisionCount };
}

function idText(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

export async function commitCurrentDepositBalanceCapture(
  store: CurrentDepositBalanceWriterStore,
  capture: CurrentDepositBalanceValidatedCapture,
): Promise<CurrentDepositBalanceCommitResult> {
  assertValidatedCanonicalDatabase(store.db);
  requireValidatedCapture(capture);
  const contract = validateCapture(capture, { allowExistingIdentityKeys: true });
  return withCanonicalSourceCaptureAdmissionTransaction(store, async (capability) => {
    const account = findExistingAccount(store.db, capture.identity);
    const overviewUsesCanonicalCurrency =
      capture.authorityRoute === HNCB_CURRENT_DEPOSIT_OVERVIEW_ROUTE &&
      capture.records.some(
        (record) => record.compact.currencyResolution === "canonical-account",
      );
    if (
      overviewUsesCanonicalCurrency &&
      (account.currency === null ||
        account.currency.trim() === "" ||
        capture.observations.some(
          (observation) =>
            observation.currency.toUpperCase() !== account.currency!.toUpperCase(),
        ))
    )
      fail(
        "HNCB current deposit overview canonical currency requires an exact existing account currency.",
      );
    if (
      account.currency !== null &&
      capture.identity.stream === "domestic-deposit" &&
      capture.observations.some((observation) => observation.currency !== account.currency)
    )
      fail("Current deposit currency does not match the existing account.");
    const sourceContext = capability.admit(
      sourceEvidenceFromCapture(capture),
      [],
      { allowExistingIdentityKeys: true },
    );
    capability.linkFinancialAccount({
      accountId: account.accountId,
      scopeId: sourceContext.scopeId,
      sourceRecordIds: sourceContext.sourceRecordIds,
    });
    const revisions = persistObservations(
      store.db,
      capture,
      account.accountId,
      sourceContext.captureId,
      sourceContext.commitId,
      sourceContext.sourceRecordIds,
    );
    createCanonicalProjectionRuntime(store.db).applyCommit({
      commitId: sourceContext.commitId,
      kind: "source_capture",
    });
    return {
      status: "canonical-live",
      captureId: capture.captureId,
      accountId: idText(account.accountId),
      commitSequence: sourceContext.receipt.knowledgePoint,
      observationCount: capture.observations.length,
      revisionCount: revisions.revisionCount,
      deduplicatedRevisionCount: revisions.deduplicatedRevisionCount,
    };
  });
}

export function currentDepositSourceRecord(
  input: Readonly<{
    sourceRecordKey: string;
    providerKey: string;
    contentHash: string;
    sourceField: string;
    balanceKind: CurrentDepositBalanceKind;
    currency: string;
    value: CurrentDepositExactAmount;
    time?: CurrentDepositTimeEvidence;
    compact?: Record<string, unknown>;
  }>,
): CurrentDepositSourceRecordInput {
  const timeEvidence = input.time
    ? {
      effectiveAt: canonicalInstant(
        requireRfc3339(input.time.effectiveAt, "Current deposit effective time"),
      ),
      effectiveTimeSourceField: input.time.sourceField,
      effectiveTimeSourceValue: input.time.sourceValue,
    }
    : {};
  return {
    sourceRecordKey: input.sourceRecordKey,
    providerKey: input.providerKey,
    contentHash: input.contentHash,
    compact: {
      ...(input.compact ?? {}),
      sourceField: input.sourceField,
      balanceKind: input.balanceKind,
      currency: input.currency,
      value: input.value,
      ...timeEvidence,
    },
  };
}

export function currentDepositSourceRecordContentHash(
  value: Record<string, unknown>,
): string {
  return `sha256:${createHash("sha256")
    .update(stableCanonicalSourceJson(value))
    .digest("base64url")}`;
}

export type { CanonicalSourcePage };
