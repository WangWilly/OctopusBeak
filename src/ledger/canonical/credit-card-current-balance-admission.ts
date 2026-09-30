import { createHash } from "node:crypto";
import {
  stableCanonicalSourceJson,
  type CanonicalSourcePage,
} from "./canonical-source-evidence.ts";

export type CreditCardEstimateKind = "estimate";
export type CreditCardEstimateBasis =
  | "provider-used-credit"
  | "credit-limit-minus-available";

export type CreditCardExactAmount = Readonly<{
  coefficient: string;
  scale: number;
}>;

export type CreditCardCurrentBalanceIdentity = Readonly<{
  integrationNamespace: "yuanta" | "esun" | "fubon";
  sourceConnectionKey: string;
  identityEpochKey: string;
  stream: "credit-card";
  /** Existing issuer-aggregate account key. Never a PAN or card mask. */
  sourceAccountKey: string;
}>;

export type CreditCardCurrentBalanceTimeEvidence = Readonly<{
  effectiveAt: string;
  effectiveTimeBasis: "provider-http-date" | "provider-query-time";
  effectiveTimeRuleVersion: string;
  sourceField: "HTTP Date" | "查詢時間" | "resultTime";
  sourceValue: string;
  contractVersion: string;
}>;

export type CreditCardCurrentBalanceEstimate = Readonly<{
  kind: CreditCardEstimateKind;
  basis: CreditCardEstimateBasis;
  formula: string;
  limit?: CreditCardExactAmount;
  available?: CreditCardExactAmount;
}>;

export type CreditCardCurrentBalanceObservationInput = Readonly<{
  observationKey: string;
  balanceKind: "credit_used";
  balance: CreditCardExactAmount;
  currency: string;
  time: CreditCardCurrentBalanceTimeEvidence;
  sourceRecordKey: string;
  sourceField: string;
  estimate: CreditCardCurrentBalanceEstimate;
}>;

export type CreditCardCurrentBalanceSourceRecordInput = Readonly<{
  sourceRecordKey: string;
  providerKey: string;
  contentHash: string;
  compact: Record<string, unknown>;
  description?: string | null;
}>;

export type CreditCardCurrentBalanceCaptureInput = Readonly<{
  captureId: string;
  authorityRoute: string;
  contractVersion: string;
  subjectDigest: string;
  identity: CreditCardCurrentBalanceIdentity;
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
    httpDate?: string;
  }>;
  pages: readonly CanonicalSourcePage[];
  records: readonly CreditCardCurrentBalanceSourceRecordInput[];
  observations: readonly CreditCardCurrentBalanceObservationInput[];
}>;

export type CreditCardCurrentBalanceValidatedCapture =
  CreditCardCurrentBalanceCaptureInput & {
    readonly __runtimeValidatedCreditCardCurrentBalance: true;
  };

export type CreditCardCurrentBalanceCommitResult = Readonly<{
  status: "canonical-live";
  captureId: string;
  accountId: string;
  commitSequence: number;
  observationCount: number;
  revisionCount: number;
  deduplicatedRevisionCount: number;
}>;

export class CanonicalCreditCardCurrentBalanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalCreditCardCurrentBalanceConflictError";
  }
}

type CreditCardRouteContract = Readonly<{
  integrationNamespace: CreditCardCurrentBalanceIdentity["integrationNamespace"];
  contractVersion: string;
  endpointHost: string;
  endpointPath: string;
  endpointQuery?: Readonly<Record<string, string>>;
  /** Public provider navigation parameters accepted when the normal menu may
   * omit them; every optional key/value remains explicitly allowlisted. */
  optionalEndpointQuery?: Readonly<Record<string, string>>;
  requiredCacheTokens: readonly string[];
  requiredCacheControlPattern?: RegExp;
  sourceFields: readonly string[];
  estimateBasis: CreditCardEstimateBasis;
  effectiveTimeBasis: CreditCardCurrentBalanceTimeEvidence["effectiveTimeBasis"];
  effectiveTimeSourceField: CreditCardCurrentBalanceTimeEvidence["sourceField"];
}>;

/** Reviewed endpoints and fields for current issuer credit snapshots. */
export const CREDIT_CARD_CURRENT_BALANCE_ROUTE_CONTRACTS: Readonly<
  Record<string, CreditCardRouteContract>
> = Object.freeze({
  "yuanta/credit-card/current-used-credit-v1": {
    integrationNamespace: "yuanta",
    contractVersion: "yuanta/credit-card/current-used-credit-v1",
    endpointHost: "ebank.yuantabank.com.tw",
    endpointPath: "/nib/tx/creditcardsummary",
    requiredCacheTokens: ["no-store"],
    sourceFields: ["已使用額度"],
    estimateBasis: "provider-used-credit",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
  },
  "esun/credit-card/current-used-credit-v1": {
    integrationNamespace: "esun",
    contractVersion: "esun/credit-card/current-used-credit-v1",
    endpointHost: "ebank.esunbank.com.tw",
    endpointPath: "/l1/l2/dispatcher",
    endpointQuery: {
      clean: "true",
      taskId: "FCM01006",
      appId: "FCM",
      menuId: "MFCM0204",
    },
    requiredCacheTokens: ["no-cache"],
    requiredCacheControlPattern: /^no-cache\s*=\s*"set-cookie\s*,\s*set-cookie2"\s*$/iu,
    sourceFields: ["已用額度"],
    estimateBasis: "provider-used-credit",
    effectiveTimeBasis: "provider-query-time",
    effectiveTimeSourceField: "查詢時間",
  },
  "esun/credit-card/current-used-credit-v2": {
    integrationNamespace: "esun",
    contractVersion: "esun/credit-card/current-used-credit-v2",
    endpointHost: "ebank.esunbank.com.tw",
    endpointPath: "/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary",
    requiredCacheTokens: [],
    sourceFields: ["usedCreditLimit"],
    estimateBasis: "provider-used-credit",
    effectiveTimeBasis: "provider-query-time",
    effectiveTimeSourceField: "resultTime",
  },
  "fubon/credit-card/current-used-credit-v1": {
    integrationNamespace: "fubon",
    contractVersion: "fubon/credit-card/current-used-credit-v1",
    endpointHost: "ebank.taipeifubon.com.tw",
    endpointPath: "/B2C/cccqu/cccqu002/CCCQU002_Home.faces",
    endpointQuery: { menuId: "CCC0201" },
    optionalEndpointQuery: { showLogin: "false" },
    requiredCacheTokens: ["no-store", "no-cache"],
    sourceFields: [
      "正卡人信用額度",
      "正卡人可用額度",
      "正卡人信用額度-正卡人可用額度",
    ],
    estimateBasis: "credit-limit-minus-available",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
  },
});

/**
 * Map a workflow identity to the canonical account epoch used by the
 * existing credit-card financial spine.  This is domain separation only; no
 * PAN, credential, or browser value is accepted here.
 */
export function canonicalCreditCardCurrentBalanceIdentity(input: Readonly<{
  integrationNamespace: CreditCardCurrentBalanceIdentity["integrationNamespace"];
  sourceConnectionKey: string;
  identityEpochKey: string;
  sourceAccountKey: string;
}>): CreditCardCurrentBalanceIdentity {
  const digest = (label: string, value: unknown): string =>
    `sha256:${createHash("sha256").update(JSON.stringify([label, value])).digest("base64url")}`;
  return {
    integrationNamespace: input.integrationNamespace,
    sourceConnectionKey:
      input.integrationNamespace === "esun"
        ? digest("esun-credit-connection-v1", input.sourceConnectionKey)
        : input.sourceConnectionKey,
    identityEpochKey:
      input.integrationNamespace === "yuanta"
        ? digest("yuanta-credit-epoch-v2", input.identityEpochKey)
        : input.integrationNamespace === "esun"
          ? digest("esun-credit-epoch-v1", input.identityEpochKey)
          : digest("fubon-credit-epoch-v2", input.identityEpochKey),
    stream: "credit-card",
    sourceAccountKey: input.sourceAccountKey,
  };
}

const VALIDATED_CAPTURES = new WeakSet<object>();
const OPAQUE = /^sha256:[A-Za-z0-9_-]+$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u;
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
const PROVIDER_QUERY_TIME =
  /^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/u;

function fail(message: string): never {
  throw new CanonicalCreditCardCurrentBalanceConflictError(message);
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
  if (
    !ISO_DATE.test(text) ||
    new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text
  )
    fail(`${label} must be a valid YYYY-MM-DD date.`);
  return text;
}

function requireRfc3339(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!RFC3339.test(text) || !Number.isFinite(Date.parse(text)))
    fail(`${label} must be RFC3339.`);
  return text;
}

export function canonicalInstant(value: string): string {
  if (HTTP_DATE.test(value)) {
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toUTCString() !== value)
      fail("Credit-card provider HTTP Date is invalid.");
    return `${new Date(milliseconds).toISOString().slice(0, 19)}.000000000Z`;
  }
  const instant = requireRfc3339(value, "Credit-card effective time");
  const milliseconds = Date.parse(instant);
  const seconds = Math.floor(milliseconds / 1000);
  const fraction = /\.(\d+)/u.exec(instant)?.[1] ?? "";
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${fraction.padEnd(9, "0").slice(0, 9)}Z`;
}

function canonicalProviderQueryTime(value: string): string {
  const match = PROVIDER_QUERY_TIME.exec(value.trim());
  if (!match) fail("Credit-card provider query time is invalid.");
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
    !Number.isFinite(civil.getTime()) ||
    civil.getUTCFullYear() !== Number(year) ||
    civil.getUTCMonth() !== Number(month) - 1 ||
    civil.getUTCDate() !== Number(day) ||
    civil.getUTCHours() !== Number(hour) ||
    civil.getUTCMinutes() !== Number(minute) ||
    civil.getUTCSeconds() !== Number(second)
  )
    fail("Credit-card provider query time is invalid.");
  const instant = new Date(civil.getTime() - 8 * 60 * 60 * 1000);
  if (
    !Number.isFinite(instant.getTime())
  )
    fail("Credit-card provider query time is invalid.");
  return `${instant.toISOString().slice(0, 19)}.000000000Z`;
}

function providerTimeInstant(
  value: string,
  basis: CreditCardCurrentBalanceTimeEvidence["effectiveTimeBasis"],
): string {
  if (basis === "provider-http-date") {
    if (!HTTP_DATE.test(value)) fail("Credit-card provider HTTP Date is invalid.");
    return canonicalInstant(value);
  }
  return canonicalProviderQueryTime(value);
}

export function requireAmount(value: unknown, label: string): CreditCardExactAmount {
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

function normalizedAmount(value: CreditCardExactAmount): CreditCardExactAmount {
  let coefficient = BigInt(value.coefficient);
  let scale = value.scale;
  if (coefficient === 0n) return { coefficient: "0", scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient: coefficient.toString(), scale };
}

export function amountsEqual(left: CreditCardExactAmount, right: CreditCardExactAmount): boolean {
  const a = normalizedAmount(left);
  const b = normalizedAmount(right);
  return a.coefficient === b.coefficient && a.scale === b.scale;
}

function subtractExact(
  limit: CreditCardExactAmount,
  available: CreditCardExactAmount,
): CreditCardExactAmount {
  const scale = Math.max(limit.scale, available.scale);
  const left = BigInt(limit.coefficient) * 10n ** BigInt(scale - limit.scale);
  const right = BigInt(available.coefficient) * 10n ** BigInt(scale - available.scale);
  return normalizedAmount({ coefficient: (left - right).toString(), scale });
}

function parseEndpoint(endpoint: string, contract: CreditCardRouteContract): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail("Credit-card provider endpoint is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== contract.endpointHost ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== contract.endpointPath
  )
    fail("Credit-card provider endpoint is not contract-approved.");
  const expected = new Map<string, number>();
  for (const [key, value] of Object.entries(contract.endpointQuery ?? {}))
    expected.set(`${key}\u0000${value}`, (expected.get(`${key}\u0000${value}`) ?? 0) + 1);
  const optional = new Map<string, number>();
  for (const [key, value] of Object.entries(contract.optionalEndpointQuery ?? {}))
    optional.set(`${key}\u0000${value}`, (optional.get(`${key}\u0000${value}`) ?? 0) + 1);
  const actual = [...parsed.searchParams.entries()];
  const requiredCount = [...expected.values()].reduce((sum, count) => sum + count, 0);
  const optionalCount = [...optional.values()].reduce((sum, count) => sum + count, 0);
  if (actual.length < requiredCount || actual.length > requiredCount + optionalCount)
    fail("Credit-card provider endpoint query is not contract-approved.");
  for (const [key, value] of actual) {
    const identity = `${key}\u0000${value}`;
    const count = expected.get(identity) ?? 0;
    if (count > 0) {
      if (count === 1) expected.delete(identity);
      else expected.set(identity, count - 1);
      continue;
    }
    const optionalCountForKey = optional.get(identity) ?? 0;
    if (optionalCountForKey === 0)
      fail(`Credit-card provider endpoint query ${key} is not contract-approved.`);
    if (optionalCountForKey === 1) optional.delete(identity);
    else optional.set(identity, optionalCountForKey - 1);
  }
  if (expected.size > 0) fail("Credit-card provider endpoint query is not contract-approved.");
}

export function validateCreditCardCurrentBalanceCapture(input: CreditCardCurrentBalanceCaptureInput): CreditCardRouteContract {
  const contract = CREDIT_CARD_CURRENT_BALANCE_ROUTE_CONTRACTS[input.authorityRoute];
  if (!contract) fail("Credit-card current-balance authority route is not contract-approved.");
  if (input.contractVersion !== contract.contractVersion)
    fail("Credit-card capture contract version does not match its route.");
  if (input.identity.integrationNamespace !== contract.integrationNamespace)
    fail("Credit-card integration namespace does not match its route.");
  if (input.identity.stream !== "credit-card") fail("Credit-card stream is invalid.");
  requireText(input.captureId, "Credit-card capture ID");
  requireOpaque(input.subjectDigest, "Credit-card subject digest");
  requireOpaque(input.identity.sourceConnectionKey, "Credit-card source connection key");
  requireOpaque(input.identity.identityEpochKey, "Credit-card identity epoch key");
  requireOpaque(input.identity.sourceAccountKey, "Credit-card source account key");
  requireRfc3339(input.observedAt, "Credit-card observedAt");
  const start = requireIsoDate(input.scope.startDate, "Credit-card scope start");
  const end = requireIsoDate(input.scope.endDate, "Credit-card scope end");
  if (start !== end) fail("Credit-card current-balance scope must be point-in-time.");
  if (input.providerResponse.status !== 200) fail("Credit-card response must be HTTP 200.");
  parseEndpoint(input.providerResponse.endpoint, contract);
  const cache = (input.providerResponse.cacheControl ?? "").trim();
  if (input.authorityRoute === "esun/credit-card/current-used-credit-v2") {
    const httpDate = input.providerResponse.httpDate ?? "";
    if (!HTTP_DATE.test(httpDate)) fail("E.SUN current-credit response requires HTTP Date.");
  }
  for (const token of contract.requiredCacheTokens)
    if (!new RegExp(`\\b${token}\\b`, "iu").test(cache))
      fail(`Credit-card response must carry Cache-Control: ${token}.`);
  if (contract.requiredCacheControlPattern && !contract.requiredCacheControlPattern.test(cache))
    fail("Credit-card response Cache-Control does not match the reviewed provider contract.");
  if (input.pages.length === 0) fail("Credit-card capture requires a source page.");
  const records = new Map<string, CreditCardCurrentBalanceSourceRecordInput>();
  for (const [index, record] of input.records.entries()) {
    requireOpaque(record.sourceRecordKey, `Credit-card record ${index} key`);
    requireOpaque(record.providerKey, `Credit-card record ${index} provider key`);
    requireOpaque(record.contentHash, `Credit-card record ${index} content hash`);
    if (records.has(record.sourceRecordKey)) fail("Credit-card records contain a duplicate source key.");
    if (!record.compact || typeof record.compact !== "object" || Array.isArray(record.compact))
      fail(`Credit-card record ${index} compact evidence is invalid.`);
    if (creditCardCurrentBalanceSourceRecordContentHash(record.compact) !== record.contentHash)
      fail(`Credit-card record ${index} content hash does not match compact evidence.`);
    records.set(record.sourceRecordKey, record);
  }
  if (input.observations.length === 0) fail("Credit-card capture requires a balance observation.");
  const identities = new Set<string>();
  for (const [index, observation] of input.observations.entries()) {
    const key = requireText(observation.observationKey, `Credit-card observation ${index} key`);
    if (observation.balanceKind !== "credit_used") fail("Credit-card balance kind is unsupported.");
    const currency = requireText(observation.currency, "Credit-card observation currency").toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) fail("Credit-card observation currency is invalid.");
    requireAmount(observation.balance, `Credit-card observation ${index} balance`);
    const identity = `${key}\u0000${currency}`;
    if (identities.has(identity)) fail("Credit-card observations contain a duplicate identity.");
    identities.add(identity);
    if (!contract.sourceFields.includes(observation.sourceField))
      fail("Credit-card source field is not contract-approved.");
    const time = observation.time;
    if (
      time.effectiveTimeBasis !== contract.effectiveTimeBasis ||
      time.sourceField !== contract.effectiveTimeSourceField
    )
      fail("Credit-card effective-time evidence is not approved for the provider route.");
    if (time.contractVersion !== contract.contractVersion || time.effectiveTimeRuleVersion !== contract.contractVersion)
      fail("Credit-card effective-time contract version does not match the route.");
    const sourceInstant = providerTimeInstant(time.sourceValue, time.effectiveTimeBasis);
    if (sourceInstant !== canonicalInstant(time.effectiveAt))
      fail("Credit-card effective time does not match provider time evidence.");
    if (input.authorityRoute === "esun/credit-card/current-used-credit-v2" &&
      Math.abs(Date.parse(input.providerResponse.httpDate!) - Date.parse(time.effectiveAt)) > 5_000)
      fail("E.SUN resultTime and HTTP Date differ by more than five seconds.");
    if (observation.estimate.kind !== "estimate" || observation.estimate.basis !== contract.estimateBasis)
      fail("Credit-card estimate kind or basis does not match the route.");
    requireText(observation.estimate.formula, "Credit-card estimate formula");
    const record = records.get(observation.sourceRecordKey);
    if (!record) fail("Credit-card observation has no matching source record.");
    const compact = record.compact;
    if (compact.sourceField !== observation.sourceField || compact.balanceKind !== "credit_used")
      fail("Credit-card source record does not preserve the provider field mapping.");
    if (String(compact.currency ?? "").toUpperCase() !== currency)
      fail("Credit-card source record currency does not match the observation.");
    const value = requireAmount(compact.value, "Credit-card source record value");
    if (!amountsEqual(value, observation.balance)) fail("Credit-card source record amount does not match the observation.");
    if (compact.effectiveAt !== observation.time.effectiveAt || compact.effectiveTimeSourceValue !== observation.time.sourceValue)
      fail("Credit-card source record does not preserve time evidence.");
    if (compact.estimateKind !== observation.estimate.kind || compact.estimateBasis !== observation.estimate.basis || compact.formula !== observation.estimate.formula)
      fail("Credit-card source record does not preserve estimate evidence.");
    if (contract.estimateBasis === "credit-limit-minus-available") {
      const limit = requireAmount(observation.estimate.limit, "Credit-card limit component");
      const available = requireAmount(observation.estimate.available, "Credit-card available component");
      if (!amountsEqual(subtractExact(limit, available), observation.balance))
        fail("Credit-card derived estimate does not equal limit minus available.");
      const compactLimit = requireAmount(compact.limit, "Credit-card source limit component");
      const compactAvailable = requireAmount(compact.available, "Credit-card source available component");
      if (!amountsEqual(compactLimit, limit) || !amountsEqual(compactAvailable, available))
        fail("Credit-card source record does not preserve formula components.");
    } else if (observation.estimate.limit !== undefined || observation.estimate.available !== undefined) {
      fail("Provider used-credit estimate must not carry formula components.");
    }
  }
  if (input.pages.reduce((sum, page) => sum + page.rowCount, 0) !== input.records.length)
    fail("Credit-card page row counts do not match source records.");
  return contract;
}

export function admitCreditCardCurrentBalanceCapture(
  input: CreditCardCurrentBalanceCaptureInput,
): CreditCardCurrentBalanceValidatedCapture {
  validateCreditCardCurrentBalanceCapture(input);
  Object.defineProperty(input, "__runtimeValidatedCreditCardCurrentBalance", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
  VALIDATED_CAPTURES.add(input);
  return input as CreditCardCurrentBalanceValidatedCapture;
}

export function isAdmittedCreditCardCurrentBalanceCapture(
  value: unknown,
): value is CreditCardCurrentBalanceValidatedCapture {
  return value !== null && typeof value === "object" && VALIDATED_CAPTURES.has(value);
}

export function sourceEvidenceFromCreditCardCurrentBalanceCapture(capture: CreditCardCurrentBalanceValidatedCapture) {
  return {
    captureId: capture.captureId,
    integrationNamespace: capture.identity.integrationNamespace,
    sourceConnectionKey: capture.identity.sourceConnectionKey,
    identityEpoch: capture.identity.identityEpochKey,
    stream: capture.identity.stream,
    recordKind: "credit-card-current-used-credit",
    routeKey: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    subjectDigest: capture.subjectDigest,
    observedAt: capture.observedAt,
    scope: {
      startDate: capture.scope.startDate,
      endDate: capture.scope.endDate,
      dateFormat: "YYYY-MM-DD" as const,
      kind: "point-in-time" as const,
      completeness: "single-page" as const,
      ruleVersion: capture.contractVersion,
      completenessBasis: "provider-credit-current-used-credit-snapshot",
      ...(capture.scope.contractFingerprint ? { contractFingerprint: capture.scope.contractFingerprint } : {}),
      ...(capture.scope.preflightFingerprint ? { preflightFingerprint: capture.scope.preflightFingerprint } : {}),
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
export function creditCardCurrentBalanceSourceRecord(input: Readonly<{
  sourceRecordKey: string;
  providerKey: string;
  sourceField: string;
  balanceKind: "credit_used";
  currency: string;
  value: CreditCardExactAmount;
  time: CreditCardCurrentBalanceTimeEvidence;
  estimate: CreditCardCurrentBalanceEstimate;
  compact?: Record<string, unknown>;
}>): CreditCardCurrentBalanceSourceRecordInput {
  return {
    sourceRecordKey: input.sourceRecordKey,
    providerKey: input.providerKey,
    contentHash: creditCardCurrentBalanceSourceRecordContentHash({
      ...(input.compact ?? {}),
      sourceField: input.sourceField,
      balanceKind: input.balanceKind,
      currency: input.currency.toUpperCase(),
      value: input.value,
      effectiveAt: input.time.effectiveAt,
      effectiveTimeSourceField: input.time.sourceField,
      effectiveTimeSourceValue: input.time.sourceValue,
      estimateKind: input.estimate.kind,
      estimateBasis: input.estimate.basis,
      formula: input.estimate.formula,
      ...(input.estimate.limit ? { limit: input.estimate.limit } : {}),
      ...(input.estimate.available ? { available: input.estimate.available } : {}),
    }),
    compact: {
      ...(input.compact ?? {}),
      sourceField: input.sourceField,
      balanceKind: input.balanceKind,
      currency: input.currency.toUpperCase(),
      value: input.value,
      effectiveAt: input.time.effectiveAt,
      effectiveTimeSourceField: input.time.sourceField,
      effectiveTimeSourceValue: input.time.sourceValue,
      estimateKind: input.estimate.kind,
      estimateBasis: input.estimate.basis,
      formula: input.estimate.formula,
      ...(input.estimate.limit ? { limit: input.estimate.limit } : {}),
      ...(input.estimate.available ? { available: input.estimate.available } : {}),
    },
  };
}

export function creditCardCurrentBalanceSourceRecordContentHash(value: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(stableCanonicalSourceJson(value)).digest("base64url")}`;
}

export function creditCardCurrentUsedAmountFromLimitAndAvailable(
  limit: CreditCardExactAmount,
  available: CreditCardExactAmount,
): CreditCardExactAmount {
  requireAmount(limit, "Credit-card limit");
  requireAmount(available, "Credit-card available");
  return subtractExact(limit, available);
}

export type { CanonicalSourcePage };
