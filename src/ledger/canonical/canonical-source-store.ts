import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  withCanonicalSnapshot,
  withCanonicalWriterQueue,
  type CanonicalRuntimeOptions,
} from "./canonical-runtime.ts";
import { isValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";
import {
  CANONICAL_SOURCE_ADMISSION,
  CANONICAL_SOURCE_STAGE,
  requireCanonicalSourceText,
  requireCanonicalSourceToken,
  type CanonicalSourceRecord,
} from "./canonical-source-evidence.ts";
import {
  createCanonicalProjectionRuntime,
} from "./canonical-projection-runtime.ts";
import {
  withCanonicalSourceCaptureAdmissionExistingTransaction,
} from "./canonical-source-capture-admission.ts";
import {
  CATHAY_INTEGRATION_NAMESPACE,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
  CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
  CATHAY_DERIVED_ORIGIN,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2,
  FUBON_CREDIT_CARD_QUERY_ROUTES,
  ESUN_CREDIT_CARD_QUERY_ROUTES,
  YUANTA_CREDIT_CARD_QUERY_ROUTES,
  CANONICAL_SCHEMA_VERSION,
  canonicalSqlitePath,
  uuidV7,
  idToString,
  idFromString,
  blob,
  validateV8SourceEvidenceSchema,
  validateCanonicalCompatibilityViews,
  projectionRelevantCommitCount,
  validateCanonicalLoanExtensionSchema,
  validateCanonicalInvestmentExtensionSchema,
  validateCanonicalLoanRepaymentRelationSchema,
  validateCanonicalRelationResolutionCommitSchema,
  type CanonicalId,
} from "./canonical-schema-implementation.ts";
import type {
  CanonicalProjectionKnowledgePoint,
  CanonicalProjectionRebuildFailureInjection,
  CanonicalProjectionRebuildOptions,
  CanonicalProjectionRebuildResult,
} from "./canonical-projection-contract.ts";
import {
  validateRequiredCanonicalContractPurges,
} from "./canonical-contract-purge.ts";
import {
  openCanonicalDatabase,
  openCanonicalDatabasePath,
} from "./canonical-database.ts";
import {
  addSelectedFields,
  type SelectedHistoricalField,
} from "./canonical-projection-implementation.ts";

async function withCanonicalWriter<T>(
  ledgerDir: string,
  operation: () => T,
  runtime?: CanonicalRuntimeOptions,
): Promise<T> {
  return withCanonicalWriterQueue(
    canonicalSqlitePath(ledgerDir),
    operation,
    runtime,
  );
}

export {
  CATHAY_INTEGRATION_NAMESPACE,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
  CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
  CATHAY_DERIVED_ORIGIN,
  CANONICAL_SQLITE_FILE,
  CANONICAL_SCHEMA_VERSION,
  SCHEMA_V15_INVESTMENTS,
  SCHEMA_V16_INVESTMENT_FUNDING_RELATIONS,
  canonicalSqlitePath,
  createCanonicalSchemaLifecyclePlan,
  isKnownRetiredFubonV18Fingerprint,
  isRetiredFubonV18RecoveryEligible,
  validateCanonicalInvestmentExtensionSchema,
  validateCanonicalInvestmentFundingRelationSchema,
  validateCanonicalLoanExtensionSchema,
  validateCanonicalLoanRepaymentRelationSchema,
} from "./canonical-schema-implementation.ts";
export type {
  CanonicalDatabaseOptions,
  CanonicalMigrationFailureInjection,
} from "./canonical-schema-implementation.ts";
export { openCanonicalDatabase } from "./canonical-database.ts";
export {
  canonicalProjectionRuntimeRebuildInternal,
  canonicalProjectionRuntimeSyncInternal,
} from "./canonical-projection-implementation.ts";
export type {
  CanonicalProjectionKnowledgePoint,
  CanonicalProjectionRebuildFailureInjection,
  CanonicalProjectionRebuildOptions,
  CanonicalProjectionRebuildResult,
} from "./canonical-projection-contract.ts";
export const CATHAY_POSTING_MAPPING = {
  contractVersion: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  postingStatus: "posted",
  origin: "provider_booked_history",
  basis: "query-status-success-with-accounting-date",
  ruleVersion: "cathay/domestic-deposit/v1",
} as const;
export const CATHAY_COMPLETENESS_PROOF = {
  kind: "complete-range",
  basis: "success-status-scope-count-details",
  ruleVersion: "cathay/domestic-deposit/v1",
} as const;

export const CATHAY_DOMESTIC_DEPOSIT_PROVENANCE = {
  validatedAt: "2026-08-17",
  source: "Cathay domestic deposit",
  values: "synthetic",
  liveResponseRetained: false,
  note: "Human-assisted validation covered response shape only; no live values are retained.",
} as const;

export const CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE = `{"success":true,"returnCode":"0000","content":{"datas":[{"queryStatus":"Success","accountNumber":"SYNTHETIC-ACCOUNT-001","count":3,"startDate":"2025-08-17","endDate":"2026-08-17","details":[{"sequenceNumber":1,"txnDateTime":"2026-07-01T09:00:00","accountDate":"2026-07-01","description":"Synthetic Cathay deposit description","expendAmt":null,"incomeAmt":12500,"balance":12500},{"sequenceNumber":2,"txnDateTime":"2026-07-02T10:15:30","accountDate":"2026-07-02","description":"Synthetic Cathay transfer description","expendAmt":300,"incomeAmt":null,"balance":12200},{"sequenceNumber":3,"txnDateTime":"2026-07-03T11:45:00","accountDate":"2026-07-03","description":"Synthetic Cathay credit description","expendAmt":null,"incomeAmt":800,"balance":13000}]}]}}`;

export type CathayDomesticDepositCaptureInput = {
  rawResponse: string;
  sourceConnectionId: string;
  identityEpoch: string;
  accountNo: string;
  currency: string;
  authorityRoute: string;
  stream: string;
  scope: { startDate: string; endDate: string; complete?: boolean };
  syncState: { cursor?: string | null };
  observedAt: string;
  absenceAuthority?: CathayAbsenceAuthority;
};

export type CathayAbsenceAuthority = "comparable-complete-range";
export type CathayTransportCheckpoint = {
  kind: "transport-progress";
  ordinal: number;
  token: string | null;
};
export type CathayStagedCapturePage = {
  accountNo: string;
  currency: "TWD";
  scope: { startDate: string; endDate: string };
  pageOrdinal: number;
  requestPageToken: string | null;
  nextPageToken: string | null;
  rawResponse: string;
  contractFingerprint: string;
  preflightFingerprint: string;
  absenceAuthority?: CathayAbsenceAuthority;
  transportCheckpoint?: CathayTransportCheckpoint;
};
export type CathayDomesticDepositSyncInput = {
  sourceConnectionId: string;
  identityEpoch: string;
  authorityRoute: string;
  stream: string;
  syncState: { cursor?: string | null };
  observedAt: string;
  pages: CathayStagedCapturePage[];
};

/** The first derived import contract is deliberately transaction-scoped.  A
 * complete run supplies one coordinate for every transaction/field pair it
 * claims to own.  Unsupported is an explicit output state, not a missing
 * array element, so a partial producer can never withdraw an old claim. */
export type CathayDerivedField = "display_name" | "note";
export type CathayDerivedOrigin = typeof CATHAY_DERIVED_ORIGIN;
export type CathayDerivedOutputState = "supported" | "unsupported";
export type CathayDerivedImportCoordinate = {
  transactionId: string;
  field: CathayDerivedField;
  state: CathayDerivedOutputState;
  value?: string | null;
};
export type CathayDerivedImportRunInput = {
  sourceConnectionId: string;
  identityEpoch: string;
  authorityRoute: string;
  stream: string;
  producerId: string;
  ruleLineage: string;
  origin?: CathayDerivedOrigin;
  observedAt?: string;
  /** The closed-run marker; only a complete successful run may mutate canonical data. */
  complete: boolean;
  status: "complete" | "partial" | "failed";
  /** Complete, non-empty subject/field/producer/rule-lineage coordinate matrix. */
  subjectIds: string[];
  fields: CathayDerivedField[];
  scope: CathayDerivedImportCoordinate[];
};
export type CathayDerivedImportDiagnostic = {
  kind: "derived-import-diagnostic";
  stage: "preflight" | "scope" | "commit";
  reason: string;
  producerId?: string;
  ruleLineage?: string;
};
export type CathayDerivedImportResult =
  | {
      status: "committed";
      runId: string;
      commitSequence: number;
      assertionIds: string[];
    }
  | { status: "diagnostic"; diagnostic: CathayDerivedImportDiagnostic };
export type CathayDerivedImportOptions = CathayCanonicalCommitOptions & {
  onDiagnostic?: (diagnostic: CathayDerivedImportDiagnostic) => void;
};

export type CathayUserAssertionField = "display_name" | "note";
export type CathayUserAssertionTargetField =
  CathayUserAssertionField | "displayName" | "displayLabel";
export type CathayUserAssertionInput = {
  transactionId?: string;
  subject?: { kind: "transaction"; id: string };
  field?: CathayUserAssertionField | string;
  target?: {
    kind: "transaction";
    field?: CathayUserAssertionTargetField;
    id: string;
  };
  value?: string | null;
  userId?: string;
  observedAt?: string;
};
export type CathayUserAssertionResult = {
  status: "committed";
  assertionId: string;
  commitSequence: number;
  field: CathayUserAssertionField;
  withdrawn: boolean;
};

export const CATHAY_DOMESTIC_DEPOSIT_FIXTURE: CathayDomesticDepositCaptureInput =
  {
    rawResponse: CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE,
    sourceConnectionId: "synthetic-cathay-connection",
    identityEpoch: "cathay-domestic-deposit-v1",
    accountNo: "SYNTHETIC-ACCOUNT-001",
    currency: "TWD",
    authorityRoute: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
    stream: CATHAY_DOMESTIC_DEPOSIT_STREAM,
    scope: { startDate: "2025-08-17", endDate: "2026-08-17" },
    syncState: { cursor: null },
    observedAt: "2026-08-17T12:00:00+08:00",
  };

export type ExactDecimal = { coefficient: bigint; scale: number };

/** The physical representation is deliberately stricter than SQLite's TEXT /
 * INTEGER affinities.  In particular, SQLite's `GLOB '[0-9]*'` means "a
 * digit followed by anything", so it accepts values such as `12abc`. */
const MAX_CANONICAL_SCALE = 9007199254740991n;
function canonicalStoredInteger(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value))
    return value.toString();
  return null;
}

function isCanonicalStoredExactAmount(
  coefficientValue: unknown,
  scaleValue: unknown,
): boolean {
  const coefficient = canonicalStoredInteger(coefficientValue);
  const scale = canonicalStoredInteger(scaleValue);
  if (
    coefficient === null ||
    scale === null ||
    !/^-?(?:0|[1-9]\d*)$/.test(coefficient) ||
    !/^(?:0|[1-9]\d*)$/.test(scale)
  )
    return false;
  try {
    BigInt(coefficient);
    return BigInt(scale) <= MAX_CANONICAL_SCALE;
  } catch {
    return false;
  }
}

export function parseExactDecimalLexeme(lexeme: string): ExactDecimal {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(lexeme)) {
    throw new Error(`Invalid exact decimal lexeme: ${lexeme}`);
  }
  const negative = lexeme.startsWith("-");
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const [whole, fraction = ""] = unsigned.split(".");
  return {
    coefficient: BigInt(`${negative ? "-" : ""}${whole}${fraction}`),
    scale: fraction.length,
  };
}

type LosslessJsonNumber = { kind: "number"; lexeme: string };
type LosslessJsonValue =
  | null
  | boolean
  | string
  | LosslessJsonNumber
  | LosslessJsonValue[]
  | { [key: string]: LosslessJsonValue };

class LosslessJsonParser {
  private position = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): LosslessJsonValue {
    const value = this.value();
    this.whitespace();
    if (this.position !== this.source.length)
      throw new Error("Invalid JSON trailing data.");
    return value;
  }

  private value(): LosslessJsonValue {
    this.whitespace();
    const char = this.source[this.position];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    if (this.source.startsWith("true", this.position)) {
      this.position += 4;
      return true;
    }
    if (this.source.startsWith("false", this.position)) {
      this.position += 5;
      return false;
    }
    if (this.source.startsWith("null", this.position)) {
      this.position += 4;
      return null;
    }
    return { kind: "number", lexeme: this.number() };
  }

  private object(): { [key: string]: LosslessJsonValue } {
    this.position += 1;
    const output: { [key: string]: LosslessJsonValue } = {};
    this.whitespace();
    if (this.source[this.position] === "}") {
      this.position += 1;
      return output;
    }
    while (true) {
      this.whitespace();
      if (this.source[this.position] !== '"')
        throw new Error("Invalid JSON object key.");
      const key = this.string();
      this.whitespace();
      if (this.source[this.position] !== ":")
        throw new Error("Invalid JSON object separator.");
      this.position += 1;
      if (key in output) throw new Error(`Duplicate JSON object key: ${key}`);
      output[key] = this.value();
      this.whitespace();
      if (this.source[this.position] === "}") {
        this.position += 1;
        return output;
      }
      if (this.source[this.position] !== ",")
        throw new Error("Invalid JSON object delimiter.");
      this.position += 1;
    }
  }

  private array(): LosslessJsonValue[] {
    this.position += 1;
    const output: LosslessJsonValue[] = [];
    this.whitespace();
    if (this.source[this.position] === "]") {
      this.position += 1;
      return output;
    }
    while (true) {
      output.push(this.value());
      this.whitespace();
      if (this.source[this.position] === "]") {
        this.position += 1;
        return output;
      }
      if (this.source[this.position] !== ",")
        throw new Error("Invalid JSON array delimiter.");
      this.position += 1;
    }
  }

  private string(): string {
    const start = this.position;
    this.position += 1;
    while (this.position < this.source.length) {
      const char = this.source[this.position];
      if (char === "\\") {
        this.position += 2;
        continue;
      }
      if (char === '"') {
        this.position += 1;
        return JSON.parse(this.source.slice(start, this.position)) as string;
      }
      this.position += 1;
    }
    throw new Error("Unterminated JSON string.");
  }

  private number(): string {
    const match = this.source
      .slice(this.position)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match)
      throw new Error(`Invalid JSON value at position ${this.position}.`);
    this.position += match[0].length;
    return match[0];
  }

  private whitespace() {
    while (/\s/.test(this.source[this.position] ?? "")) this.position += 1;
  }
}

function asObject(
  value: LosslessJsonValue,
  label: string,
): { [key: string]: LosslessJsonValue } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    "kind" in value
  )
    throw new Error(`${label} must be an object.`);
  return value as { [key: string]: LosslessJsonValue };
}
function asArray(
  value: LosslessJsonValue | undefined,
  label: string,
): LosslessJsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}
function requiredString(
  object: { [key: string]: LosslessJsonValue },
  key: string,
): string {
  const value = object[key];
  if (typeof value !== "string" || !value)
    throw new Error(`Missing required string ${key}.`);
  return value;
}
function isLosslessJsonNumber(
  value: LosslessJsonValue | undefined,
): value is LosslessJsonNumber {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.kind === "number",
  );
}
function requiredNumber(
  object: { [key: string]: LosslessJsonValue },
  key: string,
): string {
  const value = object[key];
  if (!isLosslessJsonNumber(value))
    throw new Error(`Missing required JSON number ${key}.`);
  return value.lexeme;
}
function nullableNumber(
  object: { [key: string]: LosslessJsonValue },
  key: string,
): string | null {
  const value = object[key];
  if (value === null) return null;
  if (!isLosslessJsonNumber(value))
    throw new Error(`${key} must be a JSON number or null.`);
  return value.lexeme;
}
function requireDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error(`${label} must be a valid calendar date.`);
  return value;
}

function normalizeCathayAccountDate(value: string, label: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return requireDate(value, label);
  }
  const localSecond = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}$/.exec(value);
  if (!localSecond) {
    throw new Error(`${label} must be YYYY-MM-DD.`);
  }
  requireDateTime(value, `${label} date-time`);
  return localSecond[1]!;
}

function normalizeCathayResponseDate(value: string, expected: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}$/.exec(value)?.[1];
  if (!date) {
    throw new Error(
      "Cathay response date scope does not match the requested scope.",
    );
  }
  try {
    if (date === value) requireDate(date, "Cathay response date");
    else requireDateTime(value, "Cathay response date-time");
  } catch {
    throw new Error(
      "Cathay response date scope does not match the requested scope.",
    );
  }
  if (date !== expected) {
    throw new Error(
      "Cathay response date scope does not match the requested scope.",
    );
  }
  return date;
}

function requireDateTime(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value))
    throw new Error(`${label} must be YYYY-MM-DDTHH:mm:ss.`);
  const calendarShape = new Date(`${value}Z`);
  if (
    Number.isNaN(calendarShape.getTime()) ||
    calendarShape.toISOString().slice(0, 19) !== value
  )
    throw new Error(`${label} must be a valid local date-time.`);
  return value;
}
function parseRfc3339UtcMicros(value: string, label: string): number {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match)
    throw new Error(
      `${label} must be RFC3339 with an explicit UTC designator or numeric offset.`,
    );
  const civil = `${match[1]}T${match[2]}`;
  if ((match[3]?.length ?? 0) > 6)
    throw new Error(`${label} exceeds integer microsecond precision.`);
  const calendarShape = new Date(`${civil}Z`);
  if (
    Number.isNaN(calendarShape.getTime()) ||
    calendarShape.toISOString().slice(0, 19) !== civil
  )
    throw new Error(`${label} must be a valid RFC3339 timestamp.`);
  if (match[4] !== "Z") {
    const [hours, minutes] = match[4].slice(1).split(":").map(Number);
    if (hours > 23 || minutes > 59)
      throw new Error(`${label} has an invalid numeric offset.`);
  }
  const epochMilliseconds = Date.parse(`${civil}${match[4]}`);
  if (!Number.isSafeInteger(epochMilliseconds))
    throw new Error(`${label} is outside the supported instant range.`);
  const fractionMicros = BigInt((match[3] ?? "").slice(0, 6).padEnd(6, "0"));
  const micros = BigInt(epochMilliseconds) * 1000n + fractionMicros;
  if (
    micros > BigInt(Number.MAX_SAFE_INTEGER) ||
    micros < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new Error(
      `${label} microseconds exceed the safe SQLite binding range.`,
    );
  return Number(micros);
}
function localDateTimeToUtcMicros(value: string): number {
  return parseRfc3339UtcMicros(`${value}+08:00`, "Cathay local date-time");
}
function localDateToUtcMicros(value: string): number {
  return localDateTimeToUtcMicros(`${value}T00:00:00`);
}

type ValidatedCathayRow = {
  sequence: string;
  accountDate: string;
  transactionDateTime: string;
  description: string | null;
  accountingUtcInstantUtcUs: number;
  utcInstantUtcUs: number;
  amount: ExactDecimal;
  direction: "inflow" | "outflow";
  balance: ExactDecimal;
  payload: string;
};
type ValidatedCathayCapture = {
  accountNo: string;
  startDate: string;
  endDate: string;
  posting: typeof CATHAY_POSTING_MAPPING;
  completeness: typeof CATHAY_COMPLETENESS_PROOF;
  rows: ValidatedCathayRow[];
};
type ValidatedCathayScope = {
  accountNo: string;
  currency: "TWD";
  startDate: string;
  endDate: string;
  absenceAuthority?: CathayAbsenceAuthority;
  contractFingerprint: string;
  preflightFingerprint: string;
  pages: Array<{
    pageOrdinal: number;
    terminal: boolean;
    rowCount: number;
    responseDigest: string;
    rows: ValidatedCathayRow[];
  }>;
  rows: ValidatedCathayRow[];
};
type ValidatedCathaySync = {
  sourceConnectionId: string;
  identityEpoch: string;
  authorityRoute: string;
  stream: string;
  syncState: { cursor?: string | null };
  observedAt: string;
  scopes: ValidatedCathayScope[];
};

function cathayPostingMapping(
  statement: { [key: string]: LosslessJsonValue },
  details: LosslessJsonValue[],
): typeof CATHAY_POSTING_MAPPING {
  if (requiredString(statement, "queryStatus") !== "Success")
    throw new Error(
      "Cathay queryStatus was not Success; posting status is not mappable.",
    );
  for (const detailValue of details) {
    const detail = asObject(detailValue, "Cathay transfer detail");
    if (
      "status" in detail ||
      "pending" in detail ||
      "postingStatus" in detail
    ) {
      throw new Error(
        "Cathay posting mapping requires the booked-history response without pending status fields.",
      );
    }
  }
  return CATHAY_POSTING_MAPPING;
}

function validateCapture(
  input: CathayDomesticDepositCaptureInput,
): ValidatedCathayCapture {
  if (!input.sourceConnectionId.trim() || !input.identityEpoch.trim())
    throw new Error("Source Connection and Identity Epoch are required.");
  if (input.currency !== "TWD")
    throw new Error("Cathay domestic deposit currency must be TWD.");
  if (input.authorityRoute !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY)
    throw new Error("Invalid authority route.");
  if (input.stream !== CATHAY_DOMESTIC_DEPOSIT_STREAM)
    throw new Error("Invalid Cathay product stream.");
  const startDate = requireDate(input.scope.startDate, "scope.startDate");
  const endDate = requireDate(input.scope.endDate, "scope.endDate");
  if (startDate > endDate)
    throw new Error("Cathay scope startDate must not be after endDate.");
  parseRfc3339UtcMicros(input.observedAt, "Capture observedAt");

  const root = asObject(
    new LosslessJsonParser(input.rawResponse).parse(),
    "Cathay response",
  );
  if (root.success !== true)
    throw new Error("Cathay response was not successful.");
  if (root.returnCode !== "0000")
    throw new Error("Cathay response returnCode was not 0000.");
  const content = asObject(root.content, "Cathay response content");
  const datas = asArray(content.datas, "Cathay response datas");
  if (datas.length !== 1)
    throw new Error(
      "Cathay response must contain exactly one transfer result.",
    );
  const statement = asObject(datas[0]!, "Cathay transfer result");
  const accountNo = requiredString(statement, "accountNumber");
  if (accountNo !== input.accountNo)
    throw new Error("Cathay account scope does not match the response.");
  normalizeCathayResponseDate(
    requiredString(statement, "startDate"),
    startDate,
  );
  normalizeCathayResponseDate(requiredString(statement, "endDate"), endDate);
  const count = parseExactDecimalLexeme(requiredNumber(statement, "count"));
  if (count.scale !== 0 || count.coefficient < 0n)
    throw new Error("Cathay count must be a non-negative integer.");
  const details = asArray(statement.details, "Cathay transfer details");
  if (count.coefficient !== BigInt(details.length))
    throw new Error("Cathay response count does not match details.");
  const posting = cathayPostingMapping(statement, details);

  const sequences = new Set<string>();
  const rows = details.map((detailValue, index) => {
    const detail = asObject(detailValue, `Cathay detail ${index}`);
    const sequenceLexeme = requiredNumber(detail, "sequenceNumber");
    const sequence = parseExactDecimalLexeme(sequenceLexeme);
    if (
      sequence.scale !== 0 ||
      sequence.coefficient < 0n ||
      sequences.has(sequenceLexeme)
    )
      throw new Error("Cathay sequenceNumber must be a unique exact integer.");
    sequences.add(sequenceLexeme);
    const expendLexeme = nullableNumber(detail, "expendAmt");
    const incomeLexeme = nullableNumber(detail, "incomeAmt");
    if ((expendLexeme === null) === (incomeLexeme === null))
      throw new Error("Cathay detail must have exactly one direction amount.");
    const amountLexeme = incomeLexeme ?? expendLexeme!;
    const amount = parseExactDecimalLexeme(amountLexeme);
    if (amount.coefficient < 0n)
      throw new Error("Cathay amount must be non-negative.");
    const balanceLexeme = requiredNumber(detail, "balance");
    const balance = parseExactDecimalLexeme(balanceLexeme);
    const accountDateValue = requiredString(detail, "accountDate");
    const accountDate = normalizeCathayAccountDate(
      accountDateValue,
      "accountDate",
    );
    const transactionDateTime = requireDateTime(
      requiredString(detail, "txnDateTime"),
      "txnDateTime",
    );
    const descriptionValue = detail.description;
    if (
      descriptionValue !== undefined &&
      descriptionValue !== null &&
      typeof descriptionValue !== "string"
    ) {
      throw new Error("Cathay description must be a string or absent.");
    }
    if (typeof descriptionValue === "string" && descriptionValue.length > 512)
      throw new Error(
        "Cathay description exceeds the supported compact length.",
      );
    const description =
      typeof descriptionValue === "string" && descriptionValue.length > 0
        ? descriptionValue
        : null;
    const direction = incomeLexeme === null ? "outflow" : "inflow";
    const payload: Record<string, string> = {
      sequenceNumber: sequenceLexeme,
      accountDate: accountDateValue,
      txnDateTime: transactionDateTime,
      amount: amountLexeme,
      amountDirection: direction,
      balance: balanceLexeme,
    };
    if (description !== null) payload.description = description;
    return {
      sequence: sequenceLexeme,
      accountDate,
      transactionDateTime,
      description,
      accountingUtcInstantUtcUs: localDateToUtcMicros(accountDate),
      utcInstantUtcUs: localDateTimeToUtcMicros(transactionDateTime),
      amount,
      direction,
      balance,
      payload: JSON.stringify(payload),
    } satisfies ValidatedCathayRow;
  });
  return {
    accountNo,
    startDate,
    endDate,
    posting,
    completeness: CATHAY_COMPLETENESS_PROOF,
    rows,
  };
}

function responseDigest(rawResponse: string): string {
  return createHash("sha256").update(rawResponse, "utf8").digest("hex");
}

function validateSyncInput(
  input: CathayDomesticDepositSyncInput,
): ValidatedCathaySync {
  if (!input.sourceConnectionId.trim() || !input.identityEpoch.trim())
    throw new Error("Source Connection and Identity Epoch are required.");
  if (
    input.authorityRoute !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY ||
    input.stream !== CATHAY_DOMESTIC_DEPOSIT_STREAM
  )
    throw new Error("Invalid Cathay sync authority route or stream.");
  if (input.syncState.cursor !== undefined && input.syncState.cursor !== null)
    throw new Error("Cathay domestic deposit has no continuation cursor.");
  parseRfc3339UtcMicros(input.observedAt, "Capture observedAt");
  if (input.pages.length === 0)
    throw new Error("Cathay sync requires at least one staged page.");

  const grouped = new Map<string, CathayStagedCapturePage[]>();
  for (const page of input.pages) {
    if (!page.accountNo.trim() || page.currency !== "TWD")
      throw new Error(
        "Cathay staged page has an invalid account identity or currency.",
      );
    if (!Number.isInteger(page.pageOrdinal) || page.pageOrdinal < 0)
      throw new Error("Cathay page ordinal must be a non-negative integer.");
    if (!page.contractFingerprint.trim() || !page.preflightFingerprint.trim())
      throw new Error(
        "Cathay page contract and preflight fingerprints are required.",
      );
    if (page.contractFingerprint !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY)
      throw new Error("Cathay page contract fingerprint is unsupported.");
    const pages = grouped.get(page.accountNo) ?? [];
    pages.push(page);
    grouped.set(page.accountNo, pages);
  }
  const scopes: ValidatedCathayScope[] = [];
  let contractFingerprint: string | undefined;
  let preflightFingerprint: string | undefined;
  for (const [accountNo, pagesForAccount] of grouped) {
    const pages = [...pagesForAccount].sort(
      (left, right) => left.pageOrdinal - right.pageOrdinal,
    );
    if (new Set(pages.map((page) => page.pageOrdinal)).size !== pages.length)
      throw new Error("Cathay staged pages contain duplicate ordinals.");
    const first = pages[0]!;
    const startDate = requireDate(
      first.scope.startDate,
      "Cathay scope.startDate",
    );
    const endDate = requireDate(first.scope.endDate, "Cathay scope.endDate");
    if (startDate > endDate)
      throw new Error("Cathay scope startDate must not be after endDate.");
    const pageRows: ValidatedCathayScope["pages"] = [];
    const rows: ValidatedCathayRow[] = [];
    const sequences = new Set<string>();
    let expectedRequestToken: string | null = null;
    let absenceAuthority = first.absenceAuthority;
    if ((first.absenceAuthority as string | undefined) === "tombstone")
      throw new Error(
        "Cathay tombstone authority is unsupported without a source-validated tombstone record.",
      );
    for (const [index, page] of pages.entries()) {
      if ((page.absenceAuthority as string | undefined) === "tombstone")
        throw new Error(
          "Cathay tombstone authority is unsupported without a source-validated tombstone record.",
        );
      if (page.pageOrdinal !== index)
        throw new Error(
          "Cathay staged pages must have contiguous ordinals starting at zero.",
        );
      if (page.scope.startDate !== startDate || page.scope.endDate !== endDate)
        throw new Error("Cathay page scope drifted within one account.");
      if (
        page.contractFingerprint !== first.contractFingerprint ||
        page.preflightFingerprint !== first.preflightFingerprint
      )
        throw new Error(
          "Cathay page contract or preflight fingerprint drifted.",
        );
      if (page.absenceAuthority !== absenceAuthority)
        throw new Error("Cathay page absence authority drifted.");
      const requestPageToken = page.requestPageToken ?? null;
      if (requestPageToken !== expectedRequestToken)
        throw new Error("Cathay page continuation token is not contiguous.");
      const validated = validateCapture({
        rawResponse: page.rawResponse,
        sourceConnectionId: input.sourceConnectionId,
        identityEpoch: input.identityEpoch,
        accountNo,
        currency: page.currency,
        authorityRoute: input.authorityRoute,
        stream: input.stream,
        scope: { startDate, endDate },
        syncState: { cursor: null },
        observedAt: input.observedAt,
      });
      const nextPageToken = page.nextPageToken ?? null;
      const terminal = nextPageToken === null;
      if (!terminal && index === pages.length - 1)
        throw new Error("Cathay staged pages end before the terminal page.");
      if (terminal && index !== pages.length - 1)
        throw new Error(
          "Cathay staged pages contain a missing continuation page.",
        );
      for (const row of validated.rows) {
        if (sequences.has(row.sequence))
          throw new Error(
            "Cathay source sequence was duplicated across pages.",
          );
        sequences.add(row.sequence);
        rows.push(row);
      }
      pageRows.push({
        pageOrdinal: page.pageOrdinal,
        terminal,
        rowCount: validated.rows.length,
        responseDigest: responseDigest(page.rawResponse),
        rows: validated.rows,
      });
      expectedRequestToken = nextPageToken;
      contractFingerprint ??= page.contractFingerprint;
      preflightFingerprint ??= page.preflightFingerprint;
      if (
        contractFingerprint !== page.contractFingerprint ||
        preflightFingerprint !== page.preflightFingerprint
      )
        throw new Error(
          "Cathay sync contract or preflight fingerprint drifted across scopes.",
        );
    }
    scopes.push({
      accountNo,
      currency: "TWD",
      startDate,
      endDate,
      absenceAuthority,
      contractFingerprint: first.contractFingerprint,
      preflightFingerprint: first.preflightFingerprint,
      pages: pageRows,
      rows,
    });
  }
  return {
    sourceConnectionId: input.sourceConnectionId,
    identityEpoch: input.identityEpoch,
    authorityRoute: input.authorityRoute,
    stream: input.stream,
    syncState: { cursor: null },
    observedAt: input.observedAt,
    scopes,
  };
}

export type CanonicalAmount = { coefficient: string; scale: number };
export type CanonicalAssertionSupportState = "supported" | "withdrawn";
export type CanonicalEconomicStatus =
  "normal" | "canceled" | "refund" | "reversal";
export type CanonicalAdministrativeState = "active" | "deleted" | "purged";
export type CanonicalTransaction = {
  id: string;
  accountId: string;
  accountNo: string;
  sourceSequence: string;
  amount: CanonicalAmount;
  currency: "TWD";
  direction: "inflow" | "outflow";
  postingStatus: "posted";
  postingOrigin:
    "provider_booked_history" | "human_attested_history" | "human-attested";
  postingBasis: string;
  postingRuleVersion: string;
  assertionSupportState: CanonicalAssertionSupportState;
  economicStatus: CanonicalEconomicStatus;
  administrativeState: CanonicalAdministrativeState;
  semanticRuleVersion: string;
  displayLabel: string | null;
  displayLabelOrigin: "source" | "derived" | "user";
  displayLabelCommitSequence: number | null;
  note: string | null;
  noteOrigin: "derived" | "user" | null;
  noteCommitSequence: number | null;
  effectiveOn: string;
  effectiveTimeBasis: "accounting" | "transaction-time" | "source-reported";
  effectiveTimeRuleVersion: string;
  transactionDateTimeLocal: string;
  timeZone: typeof CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE;
  timePrecision: "date" | "minute" | "second";
  timeOrigin: "source_reported" | "defaulted_local_midnight";
  utcInstantUtcUs: number;
  revisionId: string;
  commitSequence: number;
};
export type CathayCanonicalCurrentQueryRequest = { kind: "current" };
export type CathayCanonicalCurrentQueryResult = {
  status: "ok";
  kind: "current";
  accounts: Array<{
    id: string;
    accountNo: string;
    currency: string;
    accountType: "depository" | "credit" | "loan" | "investment" | "other";
  }>;
  transactions: CanonicalTransaction[];
  commitSequence: number;
};
export type CathayCanonicalHistoricalQueryRequest = {
  kind: "historical";
  cutoff: { kind: "both"; financialAt: string; knowledgeAt: string };
};
export type CathayCanonicalHistoricalQueryResult = {
  status: "ok";
  kind: "historical";
  cutoff: CathayCanonicalHistoricalQueryRequest["cutoff"];
  transactions: CanonicalTransaction[];
};
export type CathayCanonicalLineageQueryRequest = {
  kind: "lineage";
  subject: { kind: "transaction"; id: string };
};
export type CathayCanonicalLifecycleEvent = {
  id: string;
  kind: "observed" | "superseded" | "withdrawn" | "restored";
  commitSequence: number;
  scopeProof: {
    id: string;
    completeness: "complete-range";
    absenceAuthority: CathayAbsenceAuthority | null;
    contractFingerprint: string;
    pageCount: number;
  } | null;
};
export type CathayCanonicalLineageEntry = {
  transaction: { id: string; accountId: string; sourceSequence: string };
  revision: CanonicalTransactionRevision;
  assertion: { id: string; revisionId: string; commitSequence: number };
  sourceRecord: {
    id: string;
    captureId: string;
    sequence: string;
    description: string | null;
    payload: string;
    scopeProof: {
      id: string;
      accountId: string;
      accountNo: string;
      stream: string;
      scopeStart: string;
      scopeEnd: string;
      completeness: "complete-range";
      contractFingerprint: string;
      preflightFingerprint: string;
    };
  };
  capture: {
    id: string;
    observedAt: string;
    scopeStart: string;
    scopeEnd: string;
    authorityRoute: string;
  };
  provenance: Array<{ sourceRecordId: string; captureId: string }>;
  lifecycleEvents: CathayCanonicalLifecycleEvent[];
  derivedAssertions: Array<{
    id: string;
    field: CathayDerivedField;
    producerId: string;
    origin: string;
    ruleLineage: string;
    value: string;
    state: "supported" | "withdrawn";
    commitSequence: number;
    runId: string;
    provenance: Array<{ runId: string; coordinateId: string }>;
  }>;
  userAssertions: Array<{
    id: string;
    field: CathayUserAssertionField;
    userId: string;
    value: string;
    state: "supported" | "withdrawn";
    commitSequence: number;
    provenance: Array<{ commitSequence: number }>;
  }>;
};
export type CathayCanonicalLineageQueryResult = {
  status: "ok";
  kind: "lineage";
  subject: CathayCanonicalLineageQueryRequest["subject"];
  entries: CathayCanonicalLineageEntry[];
};
export type CanonicalTransactionRevision = CanonicalTransaction & {
  transactionId: string;
};
export interface CathayCanonicalFinancialQuery {
  current(
    request: CathayCanonicalCurrentQueryRequest,
  ): Promise<CathayCanonicalCurrentQueryResult>;
  historical(
    request: CathayCanonicalHistoricalQueryRequest,
  ): Promise<CathayCanonicalHistoricalQueryResult>;
  lineage(
    request: CathayCanonicalLineageQueryRequest,
  ): Promise<CathayCanonicalLineageQueryResult>;
}
/** Provider-scoped reader over the shared canonical financial projection. */
export type CanonicalFinancialQuery = CathayCanonicalFinancialQuery;
export type CanonicalFinancialQueryProfile = {
  integrationNamespace: string;
  postingRuleVersion: string;
};
export type CathayCommitTransactionResult = {
  transactionId: string;
  revisionId: string;
  sourceSequence: string;
  direction: "inflow" | "outflow";
  amount: CanonicalAmount;
  revisionCreated: boolean;
};
export type CathayCanonicalCommitScopeResult = {
  scopeId: string;
  accountId: string;
  accountNo: string;
  transactions: CathayCommitTransactionResult[];
};
export type CathayCanonicalCommitResult = {
  captureId: string;
  commitSequence: number;
  accountIds: string[];
  transactions: CathayCommitTransactionResult[];
  scopes: CathayCanonicalCommitScopeResult[];
};

function dbRow<T extends Record<string, unknown>>(value: unknown): T {
  return value as T;
}
function sameRevision(
  row: Record<string, unknown>,
  detail: ValidatedCathayRow,
): boolean {
  return (
    row.amount_coefficient === detail.amount.coefficient.toString() &&
    row.amount_scale === detail.amount.scale &&
    row.direction === detail.direction &&
    row.posting_status === CATHAY_POSTING_MAPPING.postingStatus &&
    row.posting_origin === CATHAY_POSTING_MAPPING.origin &&
    row.posting_basis === CATHAY_POSTING_MAPPING.basis &&
    row.posting_rule_version === CATHAY_POSTING_MAPPING.ruleVersion &&
    row.description === detail.description &&
    row.effective_on === detail.accountDate &&
    row.transaction_date_time_local === detail.transactionDateTime &&
    row.time_zone === CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE &&
    row.time_precision === "second" &&
    row.time_origin === "source_reported" &&
    row.effective_time_basis === "accounting" &&
    row.effective_time_rule_version === CATHAY_POSTING_MAPPING.ruleVersion &&
    Number(row.utc_instant_utc_us) === detail.utcInstantUtcUs
  );
}
function recordedAtUtcUs(value: string): number {
  return parseRfc3339UtcMicros(value, "Canonical admission clock");
}

function currentUtcMicros(): number {
  return parseRfc3339UtcMicros(
    new Date().toISOString(),
    "Canonical migration clock",
  );
}

export type CanonicalAdmissionClock = () => string;
export type CathayCanonicalCommitOptions = {
  clock?: CanonicalAdmissionClock;
  runtime?: CanonicalRuntimeOptions;
};

type LifecycleEventKind = CathayCanonicalLifecycleEvent["kind"];
function insertLifecycleEvent(
  db: DatabaseSync,
  values: {
    assertionId: CanonicalId;
    transactionId: CanonicalId;
    revisionId: CanonicalId;
    captureId: CanonicalId;
    scopeId: CanonicalId | null;
    commitId: CanonicalId;
    kind: LifecycleEventKind;
  },
): void {
  const eventId = uuidV7();
  db.prepare(
    "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind) VALUES (?, ?, ?, 'transaction_revision', ?, ?, NULL, NULL, NULL, ?, ?)",
  ).run(
    eventId,
    values.assertionId,
    values.transactionId,
    values.captureId,
    values.scopeId,
    values.commitId,
    values.kind,
  );
}
function latestLifecycleEvent(
  db: DatabaseSync,
  assertionId: CanonicalId,
): LifecycleEventKind | null {
  const row = db
    .prepare(
      `SELECT e.event_kind FROM assertion_transitions e JOIN canonical_commits c ON c.commit_id = e.commit_id
    WHERE e.assertion_id = ? ORDER BY c.commit_sequence DESC, e.event_id DESC LIMIT 1`,
    )
    .get(assertionId) as { event_kind?: string } | undefined;
  return row?.event_kind as LifecycleEventKind | null;
}

function commitCathayDomesticDepositSyncOnce(
  ledgerDir: string,
  input: ValidatedCathaySync,
  admissionClock: CanonicalAdmissionClock,
  runtime?: CanonicalRuntimeOptions,
): CathayCanonicalCommitResult {
  const db = openCanonicalDatabase(ledgerDir, { runtime });
  let inTransaction = false;
  try {
    const priorCurrentTransactions = new Set(
      createCanonicalProjectionRuntime(db)
        .read({
          kind: "current",
          families: ["transactions"],
          scope: { sourceConnectionKey: input.sourceConnectionId },
        })
        .families.transactions.map(
          (row) => `${row.transactionId}:${row.revisionId}`,
        ),
    );
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    return withCanonicalSourceCaptureAdmissionExistingTransaction(
      {
        db,
        databasePath: canonicalSqlitePath(ledgerDir),
        commitClock: () => recordedAtUtcUs(admissionClock()),
      } as CanonicalSourceStore,
      (sourceAdmissionCapability) => {
    const commitId = uuidV7();
    const maxSequence = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(commit_sequence), 0) AS max_sequence FROM canonical_commits",
          )
          .get() as { max_sequence?: number }
      ).max_sequence ?? 0,
    );
    const commitSequence = maxSequence + 1;
    db.prepare(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, ?)",
    ).run(
      commitId,
      commitSequence,
      recordedAtUtcUs(admissionClock()),
      input.authorityRoute,
      "source_capture",
    );
    sourceAdmissionCapability.persistLegacyAuthorityRoute({
      authorityRoute: input.authorityRoute,
      integrationNamespace: CATHAY_INTEGRATION_NAMESPACE,
      stream: input.stream,
      contractVersion: CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
      commitId,
    });
    const sourceConnectionId =
      sourceAdmissionCapability.ensureLegacySourceConnection({
        integrationNamespace: CATHAY_INTEGRATION_NAMESPACE,
        sourceConnectionKey: input.sourceConnectionId,
        commitId,
      });
    const identityEpochId = sourceAdmissionCapability.ensureLegacyIdentityEpoch({
      sourceConnectionId,
      epochKey: input.identityEpoch,
      commitId,
    });
    const accountIds = new Map<string, CanonicalId>();
    for (const scope of input.scopes) {
      const existing = db
        .prepare(
          "SELECT account_id, currency, account_type FROM financial_accounts WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ? AND account_no = ?",
        )
        .get(
          sourceConnectionId,
          identityEpochId,
          input.stream,
          scope.accountNo,
        );
      const accountId = existing
        ? blob(dbRow<{ account_id: unknown }>(existing).account_id)
        : uuidV7();
      if (existing) {
        const row = dbRow<{ currency: string; account_type: string }>(existing);
        if (
          row.currency !== scope.currency ||
          row.account_type !== "depository"
        )
          throw new Error(
            "Cathay account identity has conflicting required classification.",
          );
      } else
        db.prepare(
          "INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, account_no, account_type, currency, created_commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          accountId,
          sourceConnectionId,
          identityEpochId,
          input.stream,
          scope.accountNo,
          "depository",
          scope.currency,
          commitId,
        );
      accountIds.set(scope.accountNo, accountId);
    }
    const captureId = uuidV7();
    const captureStart = [...input.scopes]
      .map((scope) => scope.startDate)
      .sort()[0]!;
    const captureEnd = [...input.scopes]
      .map((scope) => scope.endDate)
      .sort()
      .at(-1)!;
    sourceAdmissionCapability.persistLegacyCapture({
      captureId,
      sourceConnectionId,
      identityEpochId,
      authorityRoute: input.authorityRoute,
      stream: input.stream,
      accountNo: input.scopes.length === 1 ? input.scopes[0]!.accountNo : null,
      observedAt: input.observedAt,
      scopeStart: captureStart,
      scopeEnd: captureEnd,
      completeness: CATHAY_COMPLETENESS_PROOF.kind,
      completenessBasis: CATHAY_COMPLETENESS_PROOF.basis,
      completenessRuleVersion: CATHAY_COMPLETENESS_PROOF.ruleVersion,
      commitId,
    });
    const allTransactions: CathayCommitTransactionResult[] = [];
    const scopeResults: CathayCanonicalCommitScopeResult[] = [];
    for (const scope of input.scopes) {
      const accountId = accountIds.get(scope.accountNo)!;
      const scopeId = uuidV7();
      sourceAdmissionCapability.persistLegacyScope({
        scopeId,
        captureId,
        sourceConnectionId,
        identityEpochId,
        accountId,
        accountNo: scope.accountNo,
        stream: input.stream,
        scopeStart: scope.startDate,
        scopeEnd: scope.endDate,
        scopeKind: "bounded-range",
        completeness: CATHAY_COMPLETENESS_PROOF.kind,
        completenessBasis: CATHAY_COMPLETENESS_PROOF.basis,
        completenessRuleVersion: CATHAY_COMPLETENESS_PROOF.ruleVersion,
        absenceAuthority: scope.absenceAuthority ?? null,
        contractFingerprint: scope.contractFingerprint,
        preflightFingerprint: scope.preflightFingerprint,
        pageCount: scope.pages.length,
        commitId,
      });
      for (const page of scope.pages)
        sourceAdmissionCapability.persistLegacyPage({
          scopePageId: uuidV7(),
          scopeId,
          pageOrdinal: page.pageOrdinal,
          terminal: page.terminal,
          rowCount: page.rowCount,
          responseDigest: page.responseDigest,
          proofKind: CATHAY_COMPLETENESS_PROOF.basis,
          contractFingerprint: scope.contractFingerprint,
          preflightFingerprint: scope.preflightFingerprint,
          commitId,
        });
      const seenSequences = new Set(scope.rows.map((row) => row.sequence));
      const scopeTransactions: CathayCommitTransactionResult[] = [];
      for (const detail of scope.rows) {
        const sourceRecordId = uuidV7();
        sourceAdmissionCapability.persistLegacyRecord({
          sourceRecordId,
          captureId,
          commitId,
          sequenceLexeme: detail.sequence,
          description: detail.description,
          payloadJson: detail.payload,
        });
        sourceAdmissionCapability.persistLegacyRecordScope({
          sourceRecordId,
          scopeId,
          captureId,
          accountId,
          sequenceLexeme: detail.sequence,
          commitId,
        });
        const existingTransaction = db
          .prepare(
            "SELECT transaction_id FROM financial_transactions WHERE account_id = ? AND source_sequence = ?",
          )
          .get(accountId, detail.sequence);
        const transactionId = existingTransaction
          ? blob(
              dbRow<{ transaction_id: unknown }>(existingTransaction)
                .transaction_id,
            )
          : uuidV7();
        if (!existingTransaction)
          db.prepare(
            "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES (?, ?, ?, ?)",
          ).run(transactionId, accountId, detail.sequence, commitId);
        const latest = db
          .prepare(
            "SELECT * FROM transaction_revisions WHERE transaction_id = ? ORDER BY revision_number DESC LIMIT 1",
          )
          .get(transactionId);
        const latestRow = latest
          ? dbRow<Record<string, unknown>>(latest)
          : undefined;
        const revisionCreated = !latestRow || !sameRevision(latestRow, detail);
        let revisionId = latestRow ? blob(latestRow.revision_id) : uuidV7();
        let assertionId: CanonicalId;
        if (revisionCreated) {
          if (latestRow) {
            const oldAssertion = db
              .prepare(
                "SELECT assertion_id FROM assertions WHERE origin = 'source' AND revision_id = ?",
              )
              .get(blob(latestRow.revision_id));
            if (oldAssertion)
              insertLifecycleEvent(db, {
                assertionId: blob(
                  dbRow<{ assertion_id: unknown }>(oldAssertion).assertion_id,
                ),
                transactionId,
                revisionId: blob(latestRow.revision_id),
                captureId,
                scopeId,
                commitId,
                kind: "superseded",
              });
          }
          revisionId = uuidV7();
          const revisionNumber = latestRow
            ? Number(latestRow.revision_number) + 1
            : 1;
          db.prepare(
            `INSERT INTO transaction_revisions(
          revision_id, transaction_id, source_record_id, capture_id, commit_id, revision_number, amount_coefficient, amount_scale, currency,
            direction, posting_status, posting_origin, posting_basis, posting_rule_version, description, economic_status, administrative_state, semantic_rule_version, effective_on, transaction_date_time_local,
            time_zone, time_precision, time_origin, effective_time_basis, effective_time_rule_version, utc_instant_utc_us
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            revisionId,
            transactionId,
            sourceRecordId,
            captureId,
            commitId,
            revisionNumber,
            detail.amount.coefficient.toString(),
            detail.amount.scale,
            scope.currency,
            detail.direction,
            CATHAY_POSTING_MAPPING.postingStatus,
            CATHAY_POSTING_MAPPING.origin,
            CATHAY_POSTING_MAPPING.basis,
            CATHAY_POSTING_MAPPING.ruleVersion,
            detail.description,
            "normal",
            "active",
            CATHAY_POSTING_MAPPING.ruleVersion,
            detail.accountDate,
            detail.transactionDateTime,
            CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
            "second",
            "source_reported",
            "accounting",
            CATHAY_POSTING_MAPPING.ruleVersion,
            detail.utcInstantUtcUs,
          );
          const observation = db.prepare(
            "INSERT INTO transaction_time_observations(observation_id, transaction_id, revision_id, source_record_id, commit_id, role, local_value, time_zone, time_precision, time_origin, utc_instant_utc_us) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          );
          observation.run(
            uuidV7(),
            transactionId,
            revisionId,
            sourceRecordId,
            commitId,
            "accounting",
            detail.accountDate,
            CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
            "date",
            "source_reported",
            detail.accountingUtcInstantUtcUs,
          );
          observation.run(
            uuidV7(),
            transactionId,
            revisionId,
            sourceRecordId,
            commitId,
            "occurred",
            detail.transactionDateTime,
            CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
            "second",
            "source_reported",
            detail.utcInstantUtcUs,
          );
          assertionId = uuidV7();
          db.prepare(
            "INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id) VALUES (?, ?, 'transaction_revision', 'transaction', 'source', ?, ?, ?, NULL, ?)",
          ).run(
            assertionId,
            transactionId,
            input.authorityRoute,
            input.authorityRoute,
            revisionId,
            commitId,
          );
          insertLifecycleEvent(db, {
            assertionId,
            transactionId,
            revisionId,
            captureId,
            scopeId,
            commitId,
            kind: "observed",
          });
        } else {
          const assertion = db
            .prepare(
              "SELECT assertion_id FROM assertions WHERE origin = 'source' AND transaction_id = ? AND revision_id = ?",
            )
            .get(transactionId, revisionId);
          if (!assertion)
            throw new Error("Canonical assertion was not created.");
          assertionId = blob(
            dbRow<{ assertion_id: unknown }>(assertion).assertion_id,
          );
          const wasWithdrawn =
            latestLifecycleEvent(db, assertionId) === "withdrawn";
          if (wasWithdrawn)
            insertLifecycleEvent(db, {
              assertionId,
              transactionId,
              revisionId,
              captureId,
              scopeId,
              commitId,
              kind: "restored",
            });
        }
        db.prepare(
          "INSERT INTO assertion_provenance(assertion_id, source_record_id, commit_id) VALUES (?, ?, ?)",
        ).run(assertionId, sourceRecordId, commitId);
        const result = {
          transactionId: idToString(transactionId),
          revisionId: idToString(revisionId),
          sourceSequence: detail.sequence,
          direction: detail.direction,
          amount: {
            coefficient: detail.amount.coefficient.toString(),
            scale: detail.amount.scale,
          },
          revisionCreated,
        } satisfies CathayCommitTransactionResult;
        scopeTransactions.push(result);
        allTransactions.push(result);
      }
      if (scope.absenceAuthority) {
        const prior = db
          .prepare(
            `SELECT sa.assertion_id, sa.transaction_id, sa.revision_id, t.source_sequence FROM assertions sa
          JOIN financial_transactions t ON t.transaction_id = sa.transaction_id JOIN transaction_revisions r ON r.revision_id = sa.revision_id
          JOIN assertion_provenance provenance ON provenance.assertion_id = sa.assertion_id
          JOIN source_records prior_record ON prior_record.source_record_id = provenance.source_record_id
          JOIN source_record_scopes prior_record_scope ON prior_record_scope.source_record_id = prior_record.source_record_id
          JOIN capture_scopes prior_scope ON prior_scope.scope_id = prior_record_scope.scope_id
          JOIN source_captures prior_capture ON prior_capture.capture_id = prior_scope.capture_id
          WHERE sa.origin = 'source' AND t.account_id = ? AND r.effective_on BETWEEN ? AND ?
            AND prior_scope.source_connection_id = ? AND prior_scope.identity_epoch_id = ? AND prior_scope.account_id = ?
            AND prior_scope.stream = ? AND prior_scope.scope_kind = 'bounded-range'
            AND prior_scope.completeness = 'complete-range' AND prior_scope.completeness_rule_version = ?
            AND prior_scope.contract_fingerprint = ? AND prior_scope.preflight_fingerprint = ?
            AND prior_capture.authority_route = ? AND prior_capture.stream = ?`,
          )
          .all(
            accountId,
            scope.startDate,
            scope.endDate,
            sourceConnectionId,
            identityEpochId,
            accountId,
            input.stream,
            CATHAY_COMPLETENESS_PROOF.ruleVersion,
            scope.contractFingerprint,
            scope.preflightFingerprint,
            input.authorityRoute,
            input.stream,
          ) as Array<Record<string, unknown>>;
        for (const row of prior) {
          if (
            !priorCurrentTransactions.has(
              `${blob(row.transaction_id).toString("hex")}:${blob(row.revision_id).toString("hex")}`,
            )
          )
            continue;
          if (seenSequences.has(String(row.source_sequence))) continue;
          const assertionId = blob(row.assertion_id);
          if (latestLifecycleEvent(db, assertionId) === "withdrawn") continue;
          insertLifecycleEvent(db, {
            assertionId,
            transactionId: blob(row.transaction_id),
            revisionId: blob(row.revision_id),
            captureId,
            scopeId,
            commitId,
            kind: "withdrawn",
          });
        }
      }
      db.prepare(
        `INSERT INTO source_sync_states(source_connection_id, account_id, stream, scope_start, scope_end, cursor, last_capture_id, commit_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_connection_id, account_id, stream) DO UPDATE SET scope_start = excluded.scope_start,
        scope_end = excluded.scope_end, cursor = excluded.cursor, last_capture_id = excluded.last_capture_id, commit_id = excluded.commit_id`,
      ).run(
        sourceConnectionId,
        accountId,
        input.stream,
        scope.startDate,
        scope.endDate,
        input.syncState.cursor ?? null,
        captureId,
        commitId,
      );
      scopeResults.push({
        scopeId: idToString(scopeId),
        accountId: idToString(accountId),
        accountNo: scope.accountNo,
        transactions: scopeTransactions,
      });
    }
    createCanonicalProjectionRuntime(db).applyCommit({
      commitId,
      kind: "source_capture",
    });
    db.exec("COMMIT");
    inTransaction = false;
    return {
      captureId: idToString(captureId),
      commitSequence,
      accountIds: [...accountIds.values()].map(idToString),
      transactions: allTransactions,
      scopes: scopeResults,
    };
      },
    );
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function commitCathayDomesticDeposit(
  ledgerDir: string,
  input: CathayDomesticDepositCaptureInput,
  options: CathayCanonicalCommitOptions = {},
): Promise<CathayCanonicalCommitResult> {
  const validated = validateCapture(input);
  const admissionClock = options.clock ?? (() => new Date().toISOString());
  const sync = validateSyncInput({
    sourceConnectionId: input.sourceConnectionId,
    identityEpoch: input.identityEpoch,
    authorityRoute: input.authorityRoute,
    stream: input.stream,
    syncState: input.syncState,
    observedAt: input.observedAt,
    pages: [
      {
        accountNo: validated.accountNo,
        currency: input.currency as "TWD",
        scope: { startDate: validated.startDate, endDate: validated.endDate },
        pageOrdinal: 0,
        requestPageToken: null,
        nextPageToken: null,
        rawResponse: input.rawResponse,
        contractFingerprint: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
        preflightFingerprint: "cathay/domestic-deposit/v1",
        absenceAuthority: input.absenceAuthority,
      },
    ],
  });
  return withCanonicalWriter(
    ledgerDir,
    () =>
      commitCathayDomesticDepositSyncOnce(
        ledgerDir,
        sync,
        admissionClock,
        options.runtime,
      ),
    options.runtime,
  );
}

export function commitCathayDomesticDepositSync(
  ledgerDir: string,
  input: CathayDomesticDepositSyncInput,
  options: CathayCanonicalCommitOptions = {},
): Promise<CathayCanonicalCommitResult> {
  const validated = validateSyncInput(input);
  const admissionClock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriter(
    ledgerDir,
    () =>
      commitCathayDomesticDepositSyncOnce(
        ledgerDir,
        validated,
        admissionClock,
        options.runtime,
      ),
    options.runtime,
  );
}

function importCoordinates(
  input: CathayDerivedImportRunInput,
): CathayDerivedImportCoordinate[] {
  if (!Array.isArray(input.subjectIds) || input.subjectIds.length === 0)
    throw new Error("A complete derived import requires non-empty subjectIds.");
  if (!Array.isArray(input.fields) || input.fields.length === 0)
    throw new Error("A complete derived import requires non-empty fields.");
  if (!Array.isArray(input.scope) || input.scope.length === 0)
    throw new Error(
      "A complete derived import requires a non-empty coordinate matrix.",
    );
  const subjectIds = input.subjectIds.map((subjectId) => {
    if (
      typeof subjectId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        subjectId,
      )
    )
      throw new Error(
        "Derived import subjectIds contains an invalid transaction subject.",
      );
    return subjectId;
  });
  if (
    new Set(subjectIds.map((subjectId) => subjectId.toLowerCase())).size !==
    subjectIds.length
  )
    throw new Error(
      "Derived import subjectIds contains a duplicate transaction subject.",
    );
  const fields = input.fields.map((field) => {
    if (field !== "display_name" && field !== "note")
      throw new Error("Derived import fields contains an unsupported field.");
    return field;
  });
  if (new Set(fields).size !== fields.length)
    throw new Error("Derived import fields contains a duplicate field.");
  const normalized = normalizeDerivedCoordinates(input.scope);
  const expected = new Set(
    subjectIds.flatMap((subjectId) =>
      fields.map((field) => `${subjectId.toLowerCase()}:${field}`),
    ),
  );
  for (const coordinate of normalized) {
    const key = `${coordinate.transactionId.toLowerCase()}:${coordinate.field}`;
    if (!expected.has(key))
      throw new Error(
        "Derived import scope contains a coordinate outside the declared subject/field matrix.",
      );
    expected.delete(key);
  }
  if (expected.size > 0)
    throw new Error(
      "Derived import scope is missing a declared subject/field coordinate.",
    );
  return normalized;
}

function normalizeDerivedCoordinates(
  first: CathayDerivedImportCoordinate[],
): CathayDerivedImportCoordinate[] {
  const normalized = first.map((coordinate) => {
    if (!coordinate || typeof coordinate !== "object")
      throw new Error("Derived import coordinate must be an object.");
    if (
      !coordinate.transactionId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        coordinate.transactionId,
      )
    )
      throw new Error(
        "Derived import coordinate has an invalid transaction subject.",
      );
    const normalizedField = coordinate.field;
    if (normalizedField !== "display_name" && normalizedField !== "note")
      throw new Error("Derived import field is not supported.");
    if (coordinate.state !== "supported" && coordinate.state !== "unsupported")
      throw new Error("Derived import coordinate has an invalid output state.");
    if (
      coordinate.state === "supported" &&
      typeof coordinate.value !== "string"
    )
      throw new Error(
        "Supported derived output must provide a typed string value.",
      );
    if (
      coordinate.state === "unsupported" &&
      coordinate.value !== undefined &&
      coordinate.value !== null
    )
      throw new Error("Unsupported derived output cannot carry a value.");
    return {
      transactionId: coordinate.transactionId,
      field: normalizedField,
      state: coordinate.state,
      value: coordinate.state === "supported" ? coordinate.value! : null,
    };
  });
  const seen = new Set<string>();
  for (const coordinate of normalized) {
    const key = `${coordinate.transactionId}:${coordinate.field}`;
    if (seen.has(key))
      throw new Error(
        "Derived import coordinate matrix contains a duplicate subject/field.",
      );
    seen.add(key);
  }
  if (normalized.length === 0)
    throw new Error(
      "A complete derived import requires a non-empty subject/field coordinate matrix.",
    );
  return normalized;
}

function validateDerivedImportInput(
  input: CathayDerivedImportRunInput,
): CathayDerivedImportCoordinate[] {
  if (!input.sourceConnectionId.trim() || !input.identityEpoch.trim())
    throw new Error(
      "Derived import Source Connection and Identity Epoch are required.",
    );
  if (
    input.authorityRoute !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY ||
    input.stream !== CATHAY_DOMESTIC_DEPOSIT_STREAM
  )
    throw new Error(
      "Derived import authority route or stream is not supported.",
    );
  if (!input.producerId.trim() || !input.ruleLineage.trim())
    throw new Error("Derived import producer and rule lineage are required.");
  if (input.origin !== undefined && input.origin !== CATHAY_DERIVED_ORIGIN)
    throw new Error(
      "Derived import origin is not a registered Derived origin.",
    );
  if (input.complete !== true || input.status !== "complete")
    throw new Error(
      "Only a complete successful derived import may mutate canonical data.",
    );
  if (input.observedAt !== undefined)
    parseRfc3339UtcMicros(input.observedAt, "Derived import observedAt");
  return importCoordinates(input);
}

function validateDerivedImportSubjects(
  ledgerDir: string,
  input: CathayDerivedImportRunInput,
  coordinates: CathayDerivedImportCoordinate[],
): void {
  const db = openCanonicalDatabase(ledgerDir, { readOnly: true });
  try {
    const connection = db
      .prepare(
        "SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?",
      )
      .get(CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId);
    if (!connection)
      throw new Error(
        "Derived import source connection is unknown; source lineage must already exist.",
      );
    const sourceConnectionId = blob(
      dbRow<{ source_connection_id: unknown }>(connection).source_connection_id,
    );
    const epoch = db
      .prepare(
        "SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?",
      )
      .get(sourceConnectionId, input.identityEpoch);
    if (!epoch)
      throw new Error(
        "Derived import identity epoch is unknown; source lineage must already exist.",
      );
    const identityEpochId = blob(
      dbRow<{ identity_epoch_id: unknown }>(epoch).identity_epoch_id,
    );
    for (const coordinate of coordinates) {
      const transactionId = idFromString(coordinate.transactionId);
      const transaction = db
        .prepare(
          `SELECT a.source_connection_id, a.identity_epoch_id, a.stream
        FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id
        WHERE t.transaction_id = ?`,
        )
        .get(transactionId) as Record<string, unknown> | undefined;
      if (!transaction)
        throw new Error(
          "Derived import targets an unknown transaction subject.",
        );
      if (
        Buffer.compare(
          blob(transaction.source_connection_id),
          sourceConnectionId,
        ) !== 0 ||
        Buffer.compare(blob(transaction.identity_epoch_id), identityEpochId) !==
          0 ||
        transaction.stream !== input.stream
      )
        throw new Error(
          "Derived import crossed a source identity or stream boundary.",
        );
    }
  } finally {
    db.close();
  }
}

function derivedDiagnostic(
  error: unknown,
  input: CathayDerivedImportRunInput,
  stage: CathayDerivedImportDiagnostic["stage"],
): CathayDerivedImportDiagnostic {
  return {
    kind: "derived-import-diagnostic",
    stage,
    reason: error instanceof Error ? error.message : String(error),
    producerId: input.producerId,
    ruleLineage: input.ruleLineage,
  };
}

function insertDerivedLifecycleEvent(
  db: DatabaseSync,
  values: {
    assertionId: CanonicalId;
    transactionId: CanonicalId;
    field: CathayDerivedField;
    runId: CanonicalId;
    coordinateId: CanonicalId | null;
    commitId: CanonicalId;
    kind: "observed" | "superseded" | "withdrawn" | "restored";
  },
): void {
  db.prepare(
    "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)",
  ).run(
    uuidV7(),
    values.assertionId,
    values.transactionId,
    values.field,
    values.runId,
    values.coordinateId,
    values.commitId,
    values.kind,
  );
}

function latestAssertionLifecycle(
  db: DatabaseSync,
  assertionId: CanonicalId,
): string | null {
  const row = db
    .prepare(
      `SELECT event_kind FROM assertion_transitions e JOIN canonical_commits c ON c.commit_id = e.commit_id
    WHERE assertion_id = ? ORDER BY c.commit_sequence DESC, e.rowid DESC LIMIT 1`,
    )
    .get(assertionId) as { event_kind?: string } | undefined;
  return row?.event_kind ?? null;
}

function commitCathayDerivedImportRunOnce(
  ledgerDir: string,
  input: CathayDerivedImportRunInput,
  coordinates: CathayDerivedImportCoordinate[],
  clock: CanonicalAdmissionClock,
  runtime?: CanonicalRuntimeOptions,
): { runId: string; commitSequence: number; assertionIds: string[] } {
  const db = openCanonicalDatabase(ledgerDir, { runtime });
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const connection = db
      .prepare(
        "SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?",
      )
      .get(CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId);
    if (!connection)
      throw new Error(
        "Derived import source connection is unknown; source lineage must already exist.",
      );
    const sourceConnectionId = blob(
      dbRow<{ source_connection_id: unknown }>(connection).source_connection_id,
    );
    const epoch = db
      .prepare(
        "SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?",
      )
      .get(sourceConnectionId, input.identityEpoch);
    if (!epoch)
      throw new Error(
        "Derived import identity epoch is unknown; source lineage must already exist.",
      );
    const identityEpochId = blob(
      dbRow<{ identity_epoch_id: unknown }>(epoch).identity_epoch_id,
    );
    const commitId = uuidV7();
    const commitSequence =
      Number(
        (
          db
            .prepare(
              "SELECT COALESCE(MAX(commit_sequence), 0) AS max_sequence FROM canonical_commits",
            )
            .get() as { max_sequence?: number }
        ).max_sequence ?? 0,
      ) + 1;
    db.prepare(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'derived_import')",
    ).run(
      commitId,
      commitSequence,
      recordedAtUtcUs(clock()),
      input.authorityRoute,
    );
    const runId = uuidV7();
    const origin = CATHAY_DERIVED_ORIGIN;
    db.prepare(
      "INSERT INTO derived_import_runs(run_id, source_connection_id, identity_epoch_id, authority_route, stream, producer_id, origin, rule_lineage, observed_at, commit_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete')",
    ).run(
      runId,
      sourceConnectionId,
      identityEpochId,
      input.authorityRoute,
      input.stream,
      input.producerId,
      origin,
      input.ruleLineage,
      input.observedAt ?? clock(),
      commitId,
    );
    const assertionIds: string[] = [];
    for (const coordinate of coordinates) {
      const transactionId = idFromString(coordinate.transactionId);
      const transaction = db
        .prepare(
          `SELECT t.account_id, a.source_connection_id, a.identity_epoch_id, a.stream FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id WHERE t.transaction_id = ?`,
        )
        .get(transactionId) as Record<string, unknown> | undefined;
      if (!transaction)
        throw new Error(
          "Derived import targets an unknown transaction subject.",
        );
      if (
        Buffer.compare(
          blob(transaction.source_connection_id),
          sourceConnectionId,
        ) !== 0 ||
        Buffer.compare(blob(transaction.identity_epoch_id), identityEpochId) !==
          0 ||
        transaction.stream !== input.stream
      )
        throw new Error(
          "Derived import crossed a source identity or stream boundary.",
        );
      const coordinateId = uuidV7();
      db.prepare(
        "INSERT INTO derived_scope_coordinates(coordinate_id, run_id, transaction_id, field_name, producer_id, origin, rule_lineage, output_state, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        coordinateId,
        runId,
        transactionId,
        coordinate.field,
        input.producerId,
        origin,
        input.ruleLineage,
        coordinate.state,
        commitId,
      );
      const conflicting = db
        .prepare(
          `SELECT assertion.assertion_id, assertion.producer_id, assertion.origin, assertion.rule_lineage FROM assertions assertion
        WHERE assertion.origin = 'derived' AND assertion.transaction_id = ? AND assertion.field_name = ?
          AND (assertion.producer_id <> ? OR assertion.origin <> 'derived' OR assertion.rule_lineage <> ?)
        LIMIT 1`,
        )
        .get(
          transactionId,
          coordinate.field,
          input.producerId,
          input.ruleLineage,
        ) as Record<string, unknown> | undefined;
      if (conflicting)
        throw new Error(
          "A different derived producer or origin cannot supersede the current lineage.",
        );
      const latest = db
        .prepare(
          `SELECT assertion.* FROM assertions assertion JOIN canonical_commits c ON c.commit_id = assertion.created_commit_id
        WHERE assertion.origin = 'derived' AND assertion.transaction_id = ? AND assertion.field_name = ?
          AND assertion.producer_id = ? AND assertion.rule_lineage = ?
        ORDER BY c.commit_sequence DESC, assertion.assertion_id DESC LIMIT 1`,
        )
        .get(
          transactionId,
          coordinate.field,
          input.producerId,
          input.ruleLineage,
        ) as Record<string, unknown> | undefined;
      if (coordinate.state === "unsupported") {
        if (latest) {
          const withdrawnAssertion = blob(latest.assertion_id);
          db.prepare(
            "INSERT OR IGNORE INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id) VALUES (?, NULL, ?, ?, ?)",
          ).run(withdrawnAssertion, runId, coordinateId, commitId);
          if (
            latestAssertionLifecycle(db, withdrawnAssertion) !== "withdrawn"
          ) {
            insertDerivedLifecycleEvent(db, {
              assertionId: withdrawnAssertion,
              transactionId,
              field: coordinate.field,
              runId,
              coordinateId,
              commitId,
              kind: "withdrawn",
            });
          }
        }
        continue;
      }
      const value = coordinate.value!;
      let assertionId: CanonicalId;
      let eventKind: "observed" | "superseded" | "restored" | null = "observed";
      if (latest && String(latest.value_text) === value) {
        assertionId = blob(latest.assertion_id);
        eventKind =
          latestAssertionLifecycle(db, assertionId) === "withdrawn"
            ? "restored"
            : null;
      } else {
        assertionId = uuidV7();
        if (latest)
          insertDerivedLifecycleEvent(db, {
            assertionId: blob(latest.assertion_id),
            transactionId,
            field: coordinate.field,
            runId,
            coordinateId,
            commitId,
            kind: "superseded",
          });
        db.prepare(
          "INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id) VALUES (?, ?, ?, 'transaction', 'derived', ?, ?, NULL, ?, ?)",
        ).run(
          assertionId,
          transactionId,
          coordinate.field,
          input.producerId,
          input.ruleLineage,
          value,
          commitId,
        );
      }
      db.prepare(
        "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id) VALUES (?, NULL, ?, ?, ?)",
      ).run(assertionId, runId, coordinateId, commitId);
      if (eventKind)
        insertDerivedLifecycleEvent(db, {
          assertionId,
          transactionId,
          field: coordinate.field,
          runId,
          coordinateId,
          commitId,
          kind: eventKind,
        });
      assertionIds.push(idToString(assertionId));
    }
    createCanonicalProjectionRuntime(db).applyCommit({
      commitId,
      kind: "derived_import",
    });
    db.exec("COMMIT");
    inTransaction = false;
    return { runId: idToString(runId), commitSequence, assertionIds };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function commitCathayDerivedImportRun(
  ledgerDir: string,
  input: CathayDerivedImportRunInput,
  options: CathayDerivedImportOptions = {},
): Promise<CathayDerivedImportResult & { status: "committed" }> {
  const coordinates = validateDerivedImportInput(input);
  validateDerivedImportSubjects(ledgerDir, input, coordinates);
  const clock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriter(
    ledgerDir,
    () => ({
      status: "committed",
      ...commitCathayDerivedImportRunOnce(
        ledgerDir,
        input,
        coordinates,
        clock,
        options.runtime,
      ),
    }),
    options.runtime,
  );
}

export async function runCathayDerivedImportRun(
  ledgerDir: string,
  input: CathayDerivedImportRunInput,
  options: CathayDerivedImportOptions = {},
): Promise<CathayDerivedImportResult> {
  let coordinates: CathayDerivedImportCoordinate[];
  try {
    coordinates = validateDerivedImportInput(input);
  } catch (error) {
    const diagnostic = derivedDiagnostic(error, input, "preflight");
    options.onDiagnostic?.(diagnostic);
    return { status: "diagnostic", diagnostic };
  }
  try {
    validateDerivedImportSubjects(ledgerDir, input, coordinates);
    return {
      status: "committed",
      ...(await withCanonicalWriter(
        ledgerDir,
        () =>
          commitCathayDerivedImportRunOnce(
            ledgerDir,
            input,
            coordinates,
            options.clock ?? (() => new Date().toISOString()),
            options.runtime,
          ),
        options.runtime,
      )),
    };
  } catch (error) {
    const diagnostic = derivedDiagnostic(error, input, "commit");
    options.onDiagnostic?.(diagnostic);
    return { status: "diagnostic", diagnostic };
  }
}

export async function commitCathayUserAssertion(
  ledgerDir: string,
  input: CathayUserAssertionInput,
  options: CathayCanonicalCommitOptions = {},
): Promise<CathayUserAssertionResult> {
  const hasTarget = Object.prototype.hasOwnProperty.call(input, "target");
  type RuntimeTransactionTarget = {
    kind?: unknown;
    field?: unknown;
    id?: unknown;
  };
  const targetObject =
    typeof input.target === "object" &&
    input.target !== null &&
    !Array.isArray(input.target)
      ? (input.target as RuntimeTransactionTarget)
      : undefined;
  if (hasTarget) {
    if (
      !targetObject ||
      targetObject.kind !== "transaction" ||
      typeof targetObject.id !== "string"
    )
      throw new Error(
        "User Assertions require a valid transaction target object.",
      );
    const targetId = idFromString(targetObject.id);
    if (
      input.transactionId !== undefined &&
      Buffer.compare(targetId, idFromString(input.transactionId)) !== 0
    )
      throw new Error("User Assertion target and transactionId conflict.");
    if (
      input.subject !== undefined &&
      (input.subject.kind !== "transaction" ||
        Buffer.compare(targetId, idFromString(input.subject.id)) !== 0)
    )
      throw new Error("User Assertion target and subject conflict.");
    if (
      targetObject.field !== undefined &&
      typeof targetObject.field !== "string"
    )
      throw new Error("User Assertion target field must be a string.");
  }
  const targetField = targetObject?.field;
  const normalizeField = (value: unknown) =>
    value === "displayName" || value === "displayLabel"
      ? "display_name"
      : value;
  if (
    targetField !== undefined &&
    input.field !== undefined &&
    normalizeField(targetField) !== normalizeField(input.field)
  )
    throw new Error("User Assertion target and field conflict.");
  const rawField =
    typeof input.field === "string"
      ? input.field
      : typeof targetField === "string"
        ? targetField
        : undefined;
  const field =
    rawField === "displayName" || rawField === "displayLabel"
      ? "display_name"
      : rawField;
  if (field !== "display_name" && field !== "note")
    throw new Error("User Assertions may target only display_name or note.");
  const transactionIdText =
    input.transactionId ??
    input.subject?.id ??
    (typeof targetObject?.id === "string" ? targetObject.id : undefined);
  if (!transactionIdText)
    throw new Error("User Assertion requires a transaction subject.");
  if (input.subject && input.subject.kind !== "transaction")
    throw new Error("User Assertions support transaction subjects only.");
  const transactionId = idFromString(transactionIdText);
  if (
    input.value !== undefined &&
    input.value !== null &&
    typeof input.value !== "string"
  )
    throw new Error("User Assertion value must be a string or null.");
  const userId = input.userId?.trim() || "local-user";
  if (!userId) throw new Error("User Assertion user identity is required.");
  if (input.observedAt)
    parseRfc3339UtcMicros(input.observedAt, "User Assertion observedAt");
  const clock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriter(
    ledgerDir,
    () => {
      const db = openCanonicalDatabase(ledgerDir, { runtime: options.runtime });
      let inTransaction = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        inTransaction = true;
        if (
          !db
            .prepare(
              "SELECT 1 FROM financial_transactions WHERE transaction_id = ?",
            )
            .get(transactionId)
        )
          throw new Error("User Assertion targets an unknown transaction.");
        const commitId = uuidV7();
        const commitSequence =
          Number(
            (
              db
                .prepare(
                  "SELECT COALESCE(MAX(commit_sequence), 0) AS max_sequence FROM canonical_commits",
                )
                .get() as { max_sequence?: number }
            ).max_sequence ?? 0,
          ) + 1;
        db.prepare(
          "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'user_assertion')",
        ).run(commitId, commitSequence, recordedAtUtcUs(clock()), "user/local");
        const prior = db
          .prepare(
            `SELECT assertion.assertion_id, assertion.transaction_id, assertion.field_name,
          assertion.producer_id AS user_id, assertion.value_text, assertion.created_commit_id AS commit_id
        FROM assertions assertion JOIN canonical_commits c ON c.commit_id = assertion.created_commit_id
        WHERE assertion.origin = 'user' AND assertion.transaction_id = ? AND assertion.field_name = ? AND assertion.producer_id = ?
        ORDER BY c.commit_sequence DESC, assertion.assertion_id DESC LIMIT 1`,
          )
          .get(transactionId, field, userId) as
          Record<string, unknown> | undefined;
        let assertionId: CanonicalId;
        const withdrawn = input.value === null;
        if (withdrawn) {
          if (!prior)
            throw new Error(
              "Cannot withdraw a user assertion that does not exist.",
            );
          assertionId = blob(prior.assertion_id);
          db.prepare(
            "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 'withdrawn')",
          ).run(uuidV7(), assertionId, transactionId, field, userId, commitId);
        } else {
          const value = input.value ?? "";
          if (
            prior &&
            String(prior.value_text) === value &&
            latestAssertionLifecycle(db, blob(prior.assertion_id)) !==
              "withdrawn"
          ) {
            assertionId = blob(prior.assertion_id);
          } else {
            assertionId = uuidV7();
            if (prior) {
              db.prepare(
                "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 'superseded')",
              ).run(
                uuidV7(),
                blob(prior.assertion_id),
                transactionId,
                field,
                userId,
                commitId,
              );
            }
            db.prepare(
              "INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id) VALUES (?, ?, ?, 'transaction', 'user', ?, 'user/local', NULL, ?, ?)",
            ).run(assertionId, transactionId, field, userId, value, commitId);
            db.prepare(
              "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 'observed')",
            ).run(
              uuidV7(),
              assertionId,
              transactionId,
              field,
              userId,
              commitId,
            );
          }
        }
        db.prepare(
          "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id) VALUES (?, NULL, NULL, NULL, ?)",
        ).run(assertionId, commitId);
        createCanonicalProjectionRuntime(db).applyCommit({
          commitId,
          kind: "user_assertion",
        });
        db.exec("COMMIT");
        inTransaction = false;
        return {
          status: "committed",
          assertionId: idToString(assertionId),
          commitSequence,
          field,
          withdrawn,
        };
      } catch (error) {
        if (inTransaction) db.exec("ROLLBACK");
        throw error;
      } finally {
        db.close();
      }
    },
    options.runtime,
  );
}

function amountFromRow(
  row: Record<string, unknown>,
  prefix = "",
): CanonicalAmount {
  return {
    coefficient: String(row[`${prefix}amount_coefficient`]),
    scale: Number(row[`${prefix}amount_scale`]),
  };
}
function effectiveTimeBasisFromRow(
  value: unknown,
): CanonicalTransaction["effectiveTimeBasis"] {
  if (
    value === "accounting" ||
    value === "transaction-time" ||
    value === "source-reported"
  )
    return value;
  throw new Error("Canonical transaction effective time basis is invalid.");
}

function transactionFromRow(
  row: Record<string, unknown>,
): CanonicalTransaction {
  const selectedDisplay =
    typeof row.selected_display_label === "string"
      ? row.selected_display_label
      : typeof row.description === "string"
        ? row.description
        : null;
  const selectedDisplayOrigin =
    row.selected_display_origin === "user" ||
    row.selected_display_origin === "derived"
      ? row.selected_display_origin
      : "source";
  const selectedDisplayCommitSequence =
    typeof row.selected_display_commit_sequence === "number"
      ? row.selected_display_commit_sequence
      : row.selected_display_commit_sequence !== undefined &&
          row.selected_display_commit_sequence !== null
        ? Number(row.selected_display_commit_sequence)
        : null;
  const selectedNote =
    typeof row.selected_note === "string" ? row.selected_note : null;
  const selectedNoteOrigin =
    row.selected_note_origin === "user" ||
    row.selected_note_origin === "derived"
      ? row.selected_note_origin
      : null;
  const selectedNoteCommitSequence =
    typeof row.selected_note_commit_sequence === "number"
      ? row.selected_note_commit_sequence
      : row.selected_note_commit_sequence !== undefined &&
          row.selected_note_commit_sequence !== null
        ? Number(row.selected_note_commit_sequence)
        : null;
  return {
    id: idToString(row.transaction_id),
    accountId: idToString(row.account_id),
    accountNo: String(row.account_no),
    sourceSequence: String(row.source_sequence),
    amount: amountFromRow(row),
    currency: "TWD",
    direction: row.direction as "inflow" | "outflow",
    postingStatus: row.posting_status as "posted",
    postingOrigin: row.posting_origin as CanonicalTransaction["postingOrigin"],
    postingBasis: String(row.posting_basis),
    postingRuleVersion: String(row.posting_rule_version),
    assertionSupportState:
      row.assertion_support_state === "withdrawn" ? "withdrawn" : "supported",
    economicStatus: row.economic_status as CanonicalEconomicStatus,
    administrativeState:
      row.administrative_state as CanonicalAdministrativeState,
    semanticRuleVersion: String(row.semantic_rule_version),
    displayLabel: selectedDisplay,
    displayLabelOrigin: selectedDisplayOrigin,
    displayLabelCommitSequence: selectedDisplayCommitSequence,
    note: selectedNote,
    noteOrigin: selectedNoteOrigin,
    noteCommitSequence: selectedNoteCommitSequence,
    effectiveOn: String(row.effective_on),
    effectiveTimeBasis: effectiveTimeBasisFromRow(row.effective_time_basis),
    effectiveTimeRuleVersion: String(row.effective_time_rule_version),
    transactionDateTimeLocal: String(row.transaction_date_time_local),
    timeZone: String(row.time_zone) as typeof CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
    timePrecision: row.time_precision as CanonicalTransaction["timePrecision"],
    timeOrigin: row.time_origin as CanonicalTransaction["timeOrigin"],
    utcInstantUtcUs: Number(row.utc_instant_utc_us),
    revisionId: idToString(row.revision_id),
    commitSequence: Number(row.commit_sequence),
  };
}
function transactionRevisionFromRow(
  row: Record<string, unknown>,
): CanonicalTransactionRevision {
  const transaction = transactionFromRow(row);
  return {
    ...transaction,
    id: idToString(row.revision_id),
    transactionId: transaction.id,
  };
}

/**
 * A Yuanta v2 capture is allowed to supersede v1 in a current view only when
 * the durable source proof is complete.  The source connection is the stable
 * lineage key here: it identifies the provider login/portfolio without
 * comparing account numbers, card numbers, transaction facts, or any other
 * sensitive payload.  Historical reads intentionally do not use this
 * predicate, so immutable v1 rows remain queryable for audit.
 *
 * Keep the predicate SQL-only and conservative.  In particular, a malformed
 * or partially traversed v2 scope cannot hide a valid v1 projection.
 */
function yuantaV2CompleteCaptureForConnectionSql(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM source_captures yuanta_v2_capture
    JOIN capture_scopes yuanta_v2_scope
      ON yuanta_v2_scope.capture_id = yuanta_v2_capture.capture_id
     AND yuanta_v2_scope.source_connection_id = yuanta_v2_capture.source_connection_id
     AND yuanta_v2_scope.identity_epoch_id = yuanta_v2_capture.identity_epoch_id
    WHERE yuanta_v2_capture.source_connection_id = ${alias}.source_connection_id
      AND yuanta_v2_capture.authority_route = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_capture.stream = 'credit-card'
      AND yuanta_v2_capture.record_kind = 'yuanta-credit-card-transaction'
      AND yuanta_v2_capture.completeness = 'complete-range'
      AND yuanta_v2_capture.completeness_rule_version = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_scope.stream = 'credit-card'
      AND yuanta_v2_scope.completeness = 'complete-range'
      AND yuanta_v2_scope.completeness_rule_version = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_scope.terminal = 1
      AND (
        SELECT COUNT(*)
        FROM capture_scope_pages yuanta_v2_page_count
        WHERE yuanta_v2_page_count.scope_id = yuanta_v2_scope.scope_id
      ) = yuanta_v2_scope.page_count
      AND NOT EXISTS (
        SELECT 1
        FROM capture_scope_pages yuanta_v2_page
        WHERE yuanta_v2_page.scope_id = yuanta_v2_scope.scope_id
          AND (
            yuanta_v2_page.response_code <> '200'
            OR yuanta_v2_page.terminal <> 1
            OR yuanta_v2_page.page_ordinal >= yuanta_v2_scope.page_count
          )
      )
      AND EXISTS (
        SELECT 1
        FROM transaction_revisions yuanta_v2_revision
        JOIN financial_transactions yuanta_v2_transaction
          ON yuanta_v2_transaction.transaction_id = yuanta_v2_revision.transaction_id
        WHERE yuanta_v2_revision.capture_id = yuanta_v2_capture.capture_id
          AND yuanta_v2_transaction.account_id = yuanta_v2_scope.account_id
          AND yuanta_v2_revision.posting_rule_version = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      )
  )`;
}

function yuantaV2CompleteCaptureForRevisionSql(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM source_captures yuanta_v2_capture
    JOIN capture_scopes yuanta_v2_scope
      ON yuanta_v2_scope.capture_id = yuanta_v2_capture.capture_id
     AND yuanta_v2_scope.source_connection_id = yuanta_v2_capture.source_connection_id
     AND yuanta_v2_scope.identity_epoch_id = yuanta_v2_capture.identity_epoch_id
    WHERE yuanta_v2_capture.capture_id = ${alias}.capture_id
      AND yuanta_v2_capture.authority_route = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_capture.stream = 'credit-card'
      AND yuanta_v2_capture.record_kind = 'yuanta-credit-card-transaction'
      AND yuanta_v2_capture.completeness = 'complete-range'
      AND yuanta_v2_capture.completeness_rule_version = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_scope.stream = 'credit-card'
      AND yuanta_v2_scope.completeness = 'complete-range'
      AND yuanta_v2_scope.completeness_rule_version = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_scope.terminal = 1
      AND (
        SELECT COUNT(*)
        FROM capture_scope_pages yuanta_v2_page_count
        WHERE yuanta_v2_page_count.scope_id = yuanta_v2_scope.scope_id
      ) = yuanta_v2_scope.page_count
      AND NOT EXISTS (
        SELECT 1
        FROM capture_scope_pages yuanta_v2_page
        WHERE yuanta_v2_page.scope_id = yuanta_v2_scope.scope_id
          AND (
            yuanta_v2_page.response_code <> '200'
            OR yuanta_v2_page.terminal <> 1
            OR yuanta_v2_page.page_ordinal >= yuanta_v2_scope.page_count
          )
      )
  )`;
}

class CathayCanonicalFinancialQueryAdapter implements CathayCanonicalFinancialQuery {
  private readonly ledgerDir: string;
  private readonly profile: CanonicalFinancialQueryProfile;

  constructor(ledgerDir: string, profile: CanonicalFinancialQueryProfile) {
    const creditCardQueryRoutes =
      profile.integrationNamespace === "fubon"
        ? FUBON_CREDIT_CARD_QUERY_ROUTES
        : profile.integrationNamespace === "esun"
          ? ESUN_CREDIT_CARD_QUERY_ROUTES
          : profile.integrationNamespace === "yuanta"
            ? YUANTA_CREDIT_CARD_QUERY_ROUTES
            : undefined;
    if (
      profile.postingRuleVersion.includes("/credit-card/") &&
      (!creditCardQueryRoutes?.has(profile.postingRuleVersion) ||
        !["fubon", "esun", "yuanta"].includes(profile.integrationNamespace))
    )
      throw new Error(
        "Credit-card financial query profile is unknown or mixed.",
      );
    this.ledgerDir = ledgerDir;
    this.profile = {
      integrationNamespace: requireCanonicalSourceText(
        profile.integrationNamespace,
        "Canonical financial integration namespace",
      ),
      postingRuleVersion: requireCanonicalSourceText(
        profile.postingRuleVersion,
        "Canonical financial posting rule version",
      ),
    };
  }
  async current(
    _request: CathayCanonicalCurrentQueryRequest,
  ): Promise<CathayCanonicalCurrentQueryResult> {
    // The v1 Fubon contract remains queryable only through an explicit
    // historical cutoff.  Keep the profile constructible for migration and
    // audit callers, but make a current read an empty result so superseded
    // observed-order identity rows cannot enter a current product view.
    const currentRoute =
      this.profile.integrationNamespace === "fubon" &&
      this.profile.postingRuleVersion === FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1
        ? "fubon/credit-card/human-attested-v1-current-disabled"
        : this.profile.postingRuleVersion;
    const yuantaV1CurrentSupersession =
      this.profile.integrationNamespace === "yuanta" &&
      this.profile.postingRuleVersion === YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1;
    const yuantaV2CurrentRead =
      this.profile.integrationNamespace === "yuanta" &&
      this.profile.postingRuleVersion === YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2;
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      return withCanonicalSnapshot(db, () => {
        const accountEligibility = yuantaV1CurrentSupersession
          ? `AND NOT (${yuantaV2CompleteCaptureForConnectionSql("account")})`
          : yuantaV2CurrentRead
            ? `AND ${yuantaV2CompleteCaptureForConnectionSql("account")}`
            : "";
        const accounts = (
          db
            .prepare(
              `SELECT account.account_id AS id, account.account_no AS accountNo,
                account.currency, account.account_type AS accountType
               FROM financial_accounts account
               JOIN source_connections connection
                 ON connection.source_connection_id = account.source_connection_id
               WHERE connection.integration_namespace = ?
                 AND EXISTS (
                   SELECT 1 FROM capture_scopes scoped
                   JOIN source_captures capture
                     ON capture.capture_id = scoped.capture_id
                   WHERE scoped.account_id = account.account_id
                     AND capture.authority_route = ?
                     AND capture.stream = account.stream
                 )
                 ${accountEligibility}
               ORDER BY account.account_no`,
            )
            .all(this.profile.integrationNamespace, currentRoute) as Record<
            string,
            unknown
          >[]
        ).map((row) => ({
          id: idToString(row.id),
          accountNo: String(row.accountNo),
          currency: String(row.currency),
          accountType:
            row.accountType as CathayCanonicalCurrentQueryResult["accounts"][number]["accountType"],
        }));
        if (projectionRelevantCommitCount(db) === 0) {
          return {
            status: "ok",
            kind: "current",
            accounts: [],
            transactions: [],
            commitSequence: 0,
          } satisfies CathayCanonicalCurrentQueryResult;
        }
        const projectionSnapshot = createCanonicalProjectionRuntime(db).read({
          kind: "current",
          families: ["transactions", "transaction-fields"],
          scope:
            accounts.length > 0
              ? { accountIds: accounts.map((account) => account.id) }
              : { accountIds: [] },
        });
        const projectionCommitSequence = projectionSnapshot.knowledgePoint;
        const currentTransactions = new Set(
          projectionSnapshot.families.transactions!.map(
            (row) => `${row.transactionId}:${row.revisionId}`,
          ),
        );
        const currentFields = new Map(
          projectionSnapshot.families["transaction-fields"].map((field) => [
            `${field.transactionId}:${field.fieldName}`,
            {
              value: field.value,
              origin: field.origin as SelectedHistoricalField["origin"],
              commitSequence: field.projectionCommitSequence,
            },
          ]),
        );
        const rows = db
          .prepare(
            `SELECT t.transaction_id, t.account_id, a.account_no, t.source_sequence, r.amount_coefficient, r.amount_scale, r.currency,
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.economic_status, r.administrative_state, r.semantic_rule_version, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, ? AS commit_sequence FROM financial_transactions t
        JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.transaction_id = t.transaction_id
        WHERE r.posting_rule_version = ?
          ${
            yuantaV1CurrentSupersession
              ? `AND NOT (${yuantaV2CompleteCaptureForConnectionSql("a")})`
              : yuantaV2CurrentRead
                ? `AND ${yuantaV2CompleteCaptureForRevisionSql("r")}`
                : ""
          }
        ORDER BY a.account_no, t.source_sequence`,
          )
          .all(projectionCommitSequence, currentRoute) as Record<string, unknown>[];
        const currentRows = rows.filter((row) =>
          currentTransactions.has(
            `${Buffer.from(row.transaction_id as Uint8Array).toString("hex")}:${Buffer.from(row.revision_id as Uint8Array).toString("hex")}`,
          ),
        );
        const result = {
          status: "ok",
          kind: "current",
          accounts,
          transactions: currentRows.map((row) =>
            transactionFromRow(addSelectedFields(db, row, undefined, currentFields)),
          ),
          commitSequence: projectionCommitSequence,
        } satisfies CathayCanonicalCurrentQueryResult;
        return result;
      });
    } finally {
      db.close();
    }
  }
  async historical(
    request: CathayCanonicalHistoricalQueryRequest,
  ): Promise<CathayCanonicalHistoricalQueryResult> {
    if (
      request.cutoff.kind !== "both" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(request.cutoff.financialAt) ||
      !/^\d+$/.test(request.cutoff.knowledgeAt)
    )
      throw new Error(
        "Canonical historical queries require financial-time and knowledge-time cutoffs.",
      );
    requireDate(request.cutoff.financialAt, "historical financialAt");
    const knowledgeAt = Number(request.cutoff.knowledgeAt);
    if (!Number.isSafeInteger(knowledgeAt))
      throw new Error(
        "Canonical historical knowledgeAt is outside the supported sequence range.",
      );
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      return withCanonicalSnapshot(db, () => {
        const rows = db
          .prepare(
            `SELECT t.transaction_id, t.account_id, a.account_no, t.source_sequence, r.amount_coefficient, r.amount_scale, r.currency,
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.economic_status, r.administrative_state, r.semantic_rule_version, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, c.commit_sequence,
        COALESCE((SELECT CASE WHEN lifecycle.event_kind = 'withdrawn' THEN 'withdrawn' ELSE 'supported' END FROM assertion_transitions lifecycle
          JOIN canonical_commits lifecycle_commit ON lifecycle_commit.commit_id = lifecycle.commit_id
          WHERE lifecycle.assertion_id = sa.assertion_id AND lifecycle_commit.commit_sequence <= ?
          ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC LIMIT 1), 'supported') AS assertion_support_state
        FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.transaction_id = t.transaction_id JOIN canonical_commits c ON c.commit_id = r.commit_id
        JOIN assertions sa ON sa.revision_id = r.revision_id AND sa.origin = 'source'
        WHERE r.posting_rule_version = ?
          AND r.effective_on <= ? AND c.commit_sequence <= ? AND NOT EXISTS (
          SELECT 1 FROM transaction_revisions newer JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
          WHERE newer.transaction_id = r.transaction_id AND newer.effective_on <= ? AND newer_commit.commit_sequence <= ? AND newer_commit.commit_sequence > c.commit_sequence
        ) ORDER BY a.account_no, t.source_sequence`,
          )
          .all(
            knowledgeAt,
            this.profile.postingRuleVersion,
            request.cutoff.financialAt,
            knowledgeAt,
            request.cutoff.financialAt,
            knowledgeAt,
          ) as Record<string, unknown>[];
        const result = {
          status: "ok",
          kind: "historical",
          cutoff: request.cutoff,
          transactions: rows.map((row) =>
            transactionFromRow(addSelectedFields(db, row, knowledgeAt)),
          ),
        } satisfies CathayCanonicalHistoricalQueryResult;
        return result;
      });
    } finally {
      db.close();
    }
  }
  async lineage(
    request: CathayCanonicalLineageQueryRequest,
  ): Promise<CathayCanonicalLineageQueryResult> {
    if (request.subject.kind !== "transaction" || !request.subject.id)
      throw new Error("Cathay lineage queries require a transaction subject.");
    const transactionId = idFromString(request.subject.id);
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      return withCanonicalSnapshot(db, () => {
        const revisionRows = db
          .prepare(
            `SELECT t.transaction_id, t.account_id, t.source_sequence, a.account_no, r.amount_coefficient, r.amount_scale, r.currency,
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.economic_status, r.administrative_state, r.semantic_rule_version, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, c.commit_sequence, r.source_record_id, r.capture_id, sr.sequence_lexeme, sr.description, sr.payload_json,
        source_scope.scope_id, source_scope.account_id AS scope_account_id, source_scope.account_no AS scope_account_no, source_scope.stream AS scope_stream,
        source_scope.scope_start AS scope_scope_start, source_scope.scope_end AS scope_scope_end, source_scope.contract_fingerprint AS scope_contract_fingerprint, source_scope.preflight_fingerprint AS scope_preflight_fingerprint,
        sc.observed_at, sc.scope_start, sc.scope_end, sc.authority_route, sa.assertion_id FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.transaction_id = t.transaction_id JOIN canonical_commits c ON c.commit_id = r.commit_id
        JOIN source_records sr ON sr.source_record_id = r.source_record_id JOIN source_record_scopes record_scope ON record_scope.source_record_id = sr.source_record_id
        JOIN capture_scopes source_scope ON source_scope.scope_id = record_scope.scope_id JOIN source_captures sc ON sc.capture_id = r.capture_id
        JOIN assertions sa ON sa.revision_id = r.revision_id AND sa.origin = 'source' WHERE t.transaction_id = ? ORDER BY r.revision_number`,
          )
          .all(transactionId) as Record<string, unknown>[];
        const entries = revisionRows.map((row) => {
          const assertionId = blob(row.assertion_id);
          const provenance = db
            .prepare(
              `SELECT p.source_record_id AS sourceRecordId, sr.capture_id AS captureId FROM assertion_provenance p
          JOIN source_records sr ON sr.source_record_id = p.source_record_id WHERE p.assertion_id = ? ORDER BY p.source_record_id`,
            )
            .all(assertionId) as Record<string, unknown>[];
          const lifecycleEvents = db
            .prepare(
              `SELECT e.event_id, e.event_kind, c.commit_sequence, cs.scope_id, cs.completeness, cs.absence_authority, cs.contract_fingerprint, cs.page_count
          FROM assertion_transitions e JOIN canonical_commits c ON c.commit_id = e.commit_id
          LEFT JOIN capture_scopes cs ON cs.scope_id = e.scope_id WHERE e.assertion_id = ? ORDER BY c.commit_sequence, e.event_id`,
            )
            .all(assertionId) as Record<string, unknown>[];
          const derivedRows = db
            .prepare(
              `SELECT assertion.assertion_id, assertion.field_name, assertion.producer_id, assertion.origin,
            assertion.rule_lineage, assertion.value_text, run.run_id, c.commit_sequence
          FROM assertions assertion JOIN derived_import_runs run ON run.commit_id = assertion.created_commit_id
            AND run.producer_id = assertion.producer_id AND run.rule_lineage = assertion.rule_lineage
          JOIN canonical_commits c ON c.commit_id = assertion.created_commit_id
          WHERE assertion.transaction_id = ? AND assertion.origin = 'derived'
          ORDER BY c.commit_sequence, assertion.assertion_id`,
            )
            .all(transactionId) as Record<string, unknown>[];
          const userRows = db
            .prepare(
              `SELECT assertion.assertion_id, assertion.field_name, assertion.producer_id AS user_id,
            assertion.value_text, c.commit_sequence
          FROM assertions assertion JOIN canonical_commits c ON c.commit_id = assertion.created_commit_id
          WHERE assertion.transaction_id = ? AND assertion.origin = 'user'
          ORDER BY c.commit_sequence, assertion.assertion_id`,
            )
            .all(transactionId) as Record<string, unknown>[];
          const revision = transactionRevisionFromRow(
            addSelectedFields(db, row, Number(row.commit_sequence)),
          );
          return {
            transaction: {
              id: idToString(row.transaction_id),
              accountId: idToString(row.account_id),
              sourceSequence: String(row.source_sequence),
            },
            revision,
            assertion: {
              id: idToString(row.assertion_id),
              revisionId: idToString(row.revision_id),
              commitSequence: Number(row.commit_sequence),
            },
            sourceRecord: {
              id: idToString(row.source_record_id),
              captureId: idToString(row.capture_id),
              sequence: String(row.sequence_lexeme),
              description:
                typeof row.description === "string" ? row.description : null,
              payload: String(row.payload_json),
              scopeProof: {
                id: idToString(row.scope_id),
                accountId: idToString(row.scope_account_id),
                accountNo: String(row.scope_account_no),
                stream: String(row.scope_stream),
                scopeStart: String(row.scope_scope_start),
                scopeEnd: String(row.scope_scope_end),
                completeness: "complete-range" as const,
                contractFingerprint: String(row.scope_contract_fingerprint),
                preflightFingerprint: String(row.scope_preflight_fingerprint),
              },
            },
            capture: {
              id: idToString(row.capture_id),
              observedAt: String(row.observed_at),
              scopeStart: String(row.scope_start),
              scopeEnd: String(row.scope_end),
              authorityRoute: String(row.authority_route),
            },
            provenance: provenance.map((item) => ({
              sourceRecordId: idToString(item.sourceRecordId),
              captureId: idToString(item.captureId),
            })),
            lifecycleEvents: lifecycleEvents.map((event) => ({
              id: idToString(event.event_id),
              kind: event.event_kind as CathayCanonicalLifecycleEvent["kind"],
              commitSequence: Number(event.commit_sequence),
              scopeProof: event.scope_id
                ? {
                    id: idToString(event.scope_id),
                    completeness: "complete-range" as const,
                    absenceAuthority:
                      (event.absence_authority as CathayAbsenceAuthority | null) ??
                      null,
                    contractFingerprint: String(event.contract_fingerprint),
                    pageCount: Number(event.page_count),
                  }
                : null,
            })),
            derivedAssertions: derivedRows.map((derived) => {
              const derivedAssertionId = blob(derived.assertion_id);
              const provenanceRows = db
                .prepare(
                  "SELECT run_id, coordinate_id FROM assertion_provenance WHERE assertion_id = ? AND run_id IS NOT NULL ORDER BY run_id, coordinate_id",
                )
                .all(derivedAssertionId) as Record<string, unknown>[];
              return {
                id: idToString(derivedAssertionId),
                field: derived.field_name as CathayDerivedField,
                producerId: String(derived.producer_id),
                origin: String(derived.origin),
                ruleLineage: String(derived.rule_lineage),
                value: String(derived.value_text),
                state:
                  latestAssertionLifecycle(db, derivedAssertionId) ===
                  "withdrawn"
                    ? ("withdrawn" as const)
                    : ("supported" as const),
                commitSequence: Number(derived.commit_sequence),
                runId: idToString(derived.run_id),
                provenance: provenanceRows.map((provenanceRow) => ({
                  runId: idToString(provenanceRow.run_id),
                  coordinateId: idToString(provenanceRow.coordinate_id),
                })),
              };
            }),
            userAssertions: userRows.map((user) => {
              const userAssertionId = blob(user.assertion_id);
              const userProvenance = db
                .prepare(
                  `SELECT c.commit_sequence FROM assertion_provenance p JOIN canonical_commits c ON c.commit_id = p.commit_id WHERE p.assertion_id = ? ORDER BY c.commit_sequence`,
                )
                .all(userAssertionId) as Array<Record<string, unknown>>;
              return {
                id: idToString(userAssertionId),
                field: user.field_name as CathayUserAssertionField,
                userId: String(user.user_id),
                value: String(user.value_text),
                state:
                  latestAssertionLifecycle(db, userAssertionId) === "withdrawn"
                    ? ("withdrawn" as const)
                    : ("supported" as const),
                commitSequence: Number(user.commit_sequence),
                provenance: userProvenance.map((item) => ({
                  commitSequence: Number(item.commit_sequence),
                })),
              };
            }),
          } satisfies CathayCanonicalLineageEntry;
        });
        const result = {
          status: "ok",
          kind: "lineage",
          subject: request.subject,
          entries,
        } satisfies CathayCanonicalLineageQueryResult;
        return result;
      });
    } finally {
      db.close();
    }
  }
}

export function createCathayCanonicalFinancialQuery(
  ledgerDir: string,
): CathayCanonicalFinancialQuery {
  return createCanonicalFinancialQuery(ledgerDir, {
    integrationNamespace: CATHAY_INTEGRATION_NAMESPACE,
    postingRuleVersion: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  });
}

export function createCanonicalFinancialQuery(
  ledgerDir: string,
  profile: CanonicalFinancialQueryProfile,
): CanonicalFinancialQuery {
  return new CathayCanonicalFinancialQueryAdapter(ledgerDir, profile);
}

export const CANONICAL_SOURCE_SCHEMA_VERSION = CANONICAL_SCHEMA_VERSION;
const CANONICAL_SOURCE_STORE_BRAND = Symbol(
  "canonical-source-store-lifecycle-validated-v1",
);
const CANONICAL_SOURCE_STORE_OBJECTS = new WeakSet<object>();
export type CanonicalSourceStore = {
  readonly [CANONICAL_SOURCE_STORE_BRAND]: true;
  readonly db: DatabaseSync;
  readonly databasePath: string;
  readonly commitClock: () => number;
  close(): void;
};

function requireValidatedCanonicalSourceStore(
  value: unknown,
): asserts value is CanonicalSourceStore {
  if (
    (typeof value !== "object" || value === null) ||
    !(value as Partial<CanonicalSourceStore>)[CANONICAL_SOURCE_STORE_BRAND] ||
    !CANONICAL_SOURCE_STORE_OBJECTS.has(value) ||
    !isValidatedCanonicalDatabase((value as Partial<CanonicalSourceStore>).db)
  )
    throw new Error(
      "Canonical source store must be lifecycle-created and validated.",
    );
}

/**
 * Runtime gate shared by canonical writers that accept a source-store-shaped
 * value.  The public type alone is intentionally not sufficient: a caller
 * can manufacture an object with the same enumerable fields, but cannot add
 * the private WeakSet membership assigned by createCanonicalSourceStore.
 */
export function isValidatedCanonicalSourceStore(
  value: unknown,
): value is CanonicalSourceStore {
  try {
    requireValidatedCanonicalSourceStore(value);
    return true;
  } catch {
    return false;
  }
}

/** Assert the production source-store seam before a canonical writer starts. */
export function assertValidatedCanonicalSourceStore(
  value: unknown,
): asserts value is CanonicalSourceStore {
  requireValidatedCanonicalSourceStore(value);
}
export type CanonicalSourceIdentityFence = {
  integrationNamespace: string;
  sourceConnectionKey: string;
  identityEpoch: string;
  stream: string;
  recordKind: string;
  subjectDigest: string;
};
export type CanonicalSourceObservation = CanonicalSourceRecord & {
  recordId: number;
  captureId: string;
  commitSequence: number;
  identity: CanonicalSourceIdentityFence;
};
type CanonicalSourceQueryBase = {
  status: typeof CANONICAL_SOURCE_STAGE;
  canonicalAdmission: typeof CANONICAL_SOURCE_ADMISSION;
  records: CanonicalSourceObservation[];
  observations: CanonicalSourceObservation[];
  provenanceCount: number;
};
export type CanonicalSourceCurrentQuery = CanonicalSourceQueryBase & {
  kind: "current";
};
export type CanonicalSourceHistoricalQuery = CanonicalSourceQueryBase & {
  kind: "historical";
  knowledgeAt: number;
  financialCutoffApplied: false;
};
export type CanonicalSourceLineageQuery = CanonicalSourceQueryBase & {
  kind: "lineage";
  occurrenceKey: string;
  identity: CanonicalSourceIdentityFence;
  provenance: Array<{ captureId: string; commitSequence: number }>;
  expectedObservationCount: number;
  provenanceComplete: boolean;
};
export type CanonicalSourceLineageRequest = CanonicalSourceIdentityFence & {
  occurrenceKey: string;
};
export type CanonicalSourceCommitResult = {
  status: typeof CANONICAL_SOURCE_STAGE;
  canonicalAdmission: typeof CANONICAL_SOURCE_ADMISSION;
  captureId: string;
  commitSequence: number;
  observationCount: number;
  provenanceCount: number;
};
export type CanonicalSourceStoreOptions = { commitClock?: () => number };
export function createCanonicalSourceStore(
  databasePath: string,
  options: CanonicalSourceStoreOptions = {},
): CanonicalSourceStore {
  const path = requireCanonicalSourceText(
    databasePath,
    "Canonical SQLite path",
  );
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = openCanonicalDatabasePath(path);
  const commitClock = options.commitClock ?? currentUtcMicros;
  let closed = false;
  const store: CanonicalSourceStore = {
    [CANONICAL_SOURCE_STORE_BRAND]: true,
    db,
    databasePath: path,
    commitClock,
    close() {
      if (!closed) {
        try {
          db.close();
        } finally {
          closed = true;
          CANONICAL_SOURCE_STORE_OBJECTS.delete(store);
        }
      }
    },
  };
  Object.freeze(store);
  CANONICAL_SOURCE_STORE_OBJECTS.add(store);
  return store;
}
export function validateCanonicalSourceStore(
  store: CanonicalSourceStore,
): void {
  requireValidatedCanonicalSourceStore(store);
  const version = Number(
    (store.db.prepare("PRAGMA user_version").get() as { user_version?: number })
      .user_version ?? 0,
  );
  if (version !== CANONICAL_SCHEMA_VERSION)
    throw new Error("Canonical source schema version is invalid.");
  validateV8SourceEvidenceSchema(store.db);
  validateCanonicalCompatibilityViews(store.db);
  validateCanonicalLoanExtensionSchema(store.db);
  validateCanonicalInvestmentExtensionSchema(store.db);
  validateCanonicalLoanRepaymentRelationSchema(store.db);
  validateCanonicalRelationResolutionCommitSchema(store.db);
  validateRequiredCanonicalContractPurges(store.db);
  const integrity = String(
    (
      store.db.prepare("PRAGMA integrity_check").get() as {
        integrity_check?: unknown;
      }
    ).integrity_check ?? "",
  );
  if (
    integrity !== "ok" ||
    store.db.prepare("PRAGMA foreign_key_check").all().length > 0
  )
    throw new Error("Canonical source store integrity failed.");
}
function canonicalSourceObservationRows(
  store: CanonicalSourceStore,
  knowledgeAt?: number,
  lineage?: CanonicalSourceLineageRequest,
): CanonicalSourceObservation[] {
  const clauses = ["capture.record_kind <> 'cathay-domestic-deposit'"];
  const parameters: Array<number | string> = [];
  if (knowledgeAt !== undefined) {
    clauses.push("commit_row.commit_sequence <= ?");
    parameters.push(knowledgeAt);
  }
  if (lineage !== undefined) {
    clauses.push(
      "connection.integration_namespace = ?",
      "connection.source_connection_key = ?",
      "epoch.epoch_key = ?",
      "subject.stream = ?",
      "subject.record_kind = ?",
      "subject.subject_digest = ?",
      "record.occurrence_key = ?",
    );
    parameters.push(
      lineage.integrationNamespace,
      lineage.sourceConnectionKey,
      lineage.identityEpoch,
      lineage.stream,
      lineage.recordKind,
      lineage.subjectDigest,
      lineage.occurrenceKey,
    );
  }
  const rows = store.db
    .prepare(
      `SELECT record.rowid AS record_id, capture.capture_key, commit_row.commit_sequence,
      connection.integration_namespace, connection.source_connection_key, epoch.epoch_key,
      subject.stream, subject.record_kind AS subject_record_kind, subject.subject_digest,
      record.occurrence_key, record.collision_key, record.provider_key, record.content_hash, record.payload_json
    FROM source_records record JOIN source_captures capture ON capture.capture_id = record.capture_id
    JOIN source_record_provenance provenance
      ON provenance.source_record_id = record.source_record_id
     AND provenance.capture_id = record.capture_id
     AND provenance.commit_id = record.commit_id
    JOIN canonical_commits commit_row ON commit_row.commit_id = record.commit_id
    JOIN source_subjects subject ON subject.source_subject_id = record.source_subject_id
    JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
    JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
    WHERE ${clauses.join(" AND ")} ORDER BY commit_row.commit_sequence, record.rowid`,
    )
    .all(...parameters) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    recordId: Number(row.record_id),
    captureId: String(row.capture_key),
    commitSequence: Number(row.commit_sequence),
    identity: {
      integrationNamespace: String(row.integration_namespace),
      sourceConnectionKey: String(row.source_connection_key),
      identityEpoch: String(row.epoch_key),
      stream: String(row.stream),
      recordKind: String(row.subject_record_kind),
      subjectDigest: String(row.subject_digest),
    },
    occurrenceKey: String(row.occurrence_key),
    ...(row.collision_key === null || row.collision_key === undefined
      ? {}
      : { collisionKey: String(row.collision_key) }),
    providerKey: String(row.provider_key),
    contentHash: String(row.content_hash),
    compact: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
  }));
}
function currentCanonicalSourceRows(
  observations: CanonicalSourceObservation[],
): CanonicalSourceObservation[] {
  const latest = new Map<string, CanonicalSourceObservation>();
  for (const observation of observations) {
    const identity = observation.identity;
    latest.set(
      [
        identity.integrationNamespace,
        identity.sourceConnectionKey,
        identity.identityEpoch,
        identity.stream,
        identity.recordKind,
        identity.subjectDigest,
        observation.occurrenceKey,
      ].join("\u0000"),
      observation,
    );
  }
  return [...latest.values()].sort(
    (left, right) => left.recordId - right.recordId,
  );
}
function canonicalSourceQueryBase(
  store: CanonicalSourceStore,
  knowledgeAt?: number,
): CanonicalSourceQueryBase {
  const observations = canonicalSourceObservationRows(store, knowledgeAt);
  const provenanceCount = Number(
    (
      store.db
        .prepare(
          `SELECT COUNT(*) AS value FROM source_captures capture
    JOIN canonical_commits commit_row ON commit_row.commit_id = capture.commit_id
    WHERE capture.record_kind <> 'cathay-domestic-deposit'${knowledgeAt === undefined ? "" : " AND commit_row.commit_sequence <= ?"}`,
        )
        .get(...(knowledgeAt === undefined ? [] : [knowledgeAt])) as {
        value?: number;
      }
    ).value ?? 0,
  );
  return {
    status: CANONICAL_SOURCE_STAGE,
    canonicalAdmission: CANONICAL_SOURCE_ADMISSION,
    records: currentCanonicalSourceRows(observations),
    observations,
    provenanceCount,
  };
}
export function queryCanonicalSourceCurrent(
  store: CanonicalSourceStore,
): CanonicalSourceCurrentQuery {
  requireValidatedCanonicalSourceStore(store);
  return withCanonicalSnapshot(store.db, () => ({
    kind: "current",
    ...canonicalSourceQueryBase(store),
  }));
}
export function queryCanonicalSourceHistorical(
  store: CanonicalSourceStore,
  request: { knowledgeAt?: number; effectiveAt?: string } = {},
): CanonicalSourceHistoricalQuery {
  requireValidatedCanonicalSourceStore(store);
  if (request.effectiveAt !== undefined)
    throw new Error("Financial/effective-time source query is unsupported.");
  return withCanonicalSnapshot(store.db, () => {
    const latest = Number(
      (
        store.db
          .prepare(
            "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value ?? 0,
    );
    const knowledgeAt = request.knowledgeAt ?? latest;
    if (
      !Number.isSafeInteger(knowledgeAt) ||
      knowledgeAt < 0 ||
      knowledgeAt > latest
    )
      throw new Error("Historical knowledge cutoff is invalid.");
    return {
      kind: "historical",
      knowledgeAt,
      financialCutoffApplied: false,
      ...canonicalSourceQueryBase(store, knowledgeAt),
    };
  });
}
export function queryCanonicalSourceLineage(
  store: CanonicalSourceStore,
  request: CanonicalSourceLineageRequest,
): CanonicalSourceLineageQuery {
  requireValidatedCanonicalSourceStore(store);
  const lineage: CanonicalSourceLineageRequest = {
    integrationNamespace: requireCanonicalSourceText(
      request.integrationNamespace,
      "Integration namespace",
    ),
    sourceConnectionKey: requireCanonicalSourceToken(
      request.sourceConnectionKey,
      "Source connection key",
    ),
    identityEpoch: requireCanonicalSourceToken(
      request.identityEpoch,
      "Identity epoch",
    ),
    stream: requireCanonicalSourceText(request.stream, "Source stream"),
    recordKind: requireCanonicalSourceText(request.recordKind, "Source record kind"),
    subjectDigest: requireCanonicalSourceToken(
      request.subjectDigest,
      "Subject digest",
    ),
    occurrenceKey: requireCanonicalSourceToken(
      request.occurrenceKey,
      "Occurrence key",
    ),
  };
  return withCanonicalSnapshot(store.db, () => {
    const observations = canonicalSourceObservationRows(
      store,
      undefined,
      lineage,
    );
    const provenance = observations.map(({ captureId, commitSequence }) => ({
      captureId,
      commitSequence,
    }));
    const integrity = store.db
      .prepare(
        `SELECT COUNT(*) AS expected_count,
          COALESCE(SUM((SELECT COUNT(*) FROM source_record_provenance exact_link
            WHERE exact_link.source_record_id = record.source_record_id
              AND exact_link.capture_id = record.capture_id
              AND exact_link.commit_id = record.commit_id)), 0) AS exact_link_count,
          COALESCE(SUM((SELECT COUNT(*) FROM source_record_provenance any_link
            WHERE any_link.source_record_id = record.source_record_id)), 0) AS total_link_count,
          COALESCE(SUM((SELECT COUNT(*) FROM source_record_scopes exact_scope
            WHERE exact_scope.source_record_id = record.source_record_id
              AND exact_scope.capture_id = record.capture_id
              AND exact_scope.source_subject_id = record.source_subject_id
              AND exact_scope.occurrence_key = record.occurrence_key
              AND exact_scope.commit_id = record.commit_id)), 0) AS exact_scope_count,
          COALESCE(SUM((SELECT COUNT(*) FROM source_record_scopes any_scope
            WHERE any_scope.source_record_id = record.source_record_id)), 0) AS total_scope_count
         FROM source_records record
         JOIN source_captures capture ON capture.capture_id = record.capture_id
         JOIN source_subjects subject ON subject.source_subject_id = record.source_subject_id
         JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
         JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
         WHERE connection.integration_namespace = ?
           AND connection.source_connection_key = ?
           AND epoch.epoch_key = ?
           AND subject.stream = ?
           AND subject.record_kind = ?
           AND subject.subject_digest = ?
           AND record.occurrence_key = ?`,
      )
      .get(
        lineage.integrationNamespace,
        lineage.sourceConnectionKey,
        lineage.identityEpoch,
        lineage.stream,
        lineage.recordKind,
        lineage.subjectDigest,
        lineage.occurrenceKey,
      ) as {
      expected_count?: number;
      exact_link_count?: number;
      total_link_count?: number;
      exact_scope_count?: number;
      total_scope_count?: number;
    };
    const occurrenceScopeLinks = Number(
      (
        store.db
          .prepare(
            `SELECT COUNT(*) AS value
             FROM source_record_scopes link
             JOIN source_subjects subject ON subject.source_subject_id = link.source_subject_id
             JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
             JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
             WHERE connection.integration_namespace = ?
               AND connection.source_connection_key = ?
               AND epoch.epoch_key = ?
               AND subject.stream = ?
               AND subject.record_kind = ?
               AND subject.subject_digest = ?
               AND link.occurrence_key = ?`,
          )
          .get(
            lineage.integrationNamespace,
            lineage.sourceConnectionKey,
            lineage.identityEpoch,
            lineage.stream,
            lineage.recordKind,
            lineage.subjectDigest,
            lineage.occurrenceKey,
          ) as { value?: number }
      ).value ?? 0,
    );
    const persistedObservationCount = Number(integrity.expected_count ?? 0);
    const expectedObservationCount = Math.max(
      persistedObservationCount,
      occurrenceScopeLinks,
    );
    const exactLinkCount = Number(integrity.exact_link_count ?? 0);
    const totalLinkCount = Number(integrity.total_link_count ?? 0);
    const exactScopeCount = Number(integrity.exact_scope_count ?? 0);
    const totalScopeCount = Number(integrity.total_scope_count ?? 0);
    const provenanceComplete =
      expectedObservationCount > 0 &&
      persistedObservationCount === expectedObservationCount &&
      occurrenceScopeLinks === expectedObservationCount &&
      observations.length === expectedObservationCount &&
      provenance.length === expectedObservationCount &&
      exactLinkCount === expectedObservationCount &&
      totalLinkCount === expectedObservationCount &&
      exactScopeCount === expectedObservationCount &&
      totalScopeCount === expectedObservationCount;
    return {
      kind: "lineage",
      occurrenceKey: lineage.occurrenceKey,
      identity: {
        integrationNamespace: lineage.integrationNamespace,
        sourceConnectionKey: lineage.sourceConnectionKey,
        identityEpoch: lineage.identityEpoch,
        stream: lineage.stream,
        recordKind: lineage.recordKind,
        subjectDigest: lineage.subjectDigest,
      },
      status: CANONICAL_SOURCE_STAGE,
      canonicalAdmission: CANONICAL_SOURCE_ADMISSION,
      records: currentCanonicalSourceRows(observations),
      observations,
      provenanceCount: provenance.length,
      provenance,
      expectedObservationCount,
      provenanceComplete,
    };
  });
}
