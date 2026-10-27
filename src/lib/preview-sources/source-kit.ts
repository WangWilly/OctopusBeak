import type { PreviewTransaction } from "../../ledger/pglite/preview-financial-data.ts";
import { FailureCodeError } from "../automation/workflow-failures.ts";
import type { TypedWorkflowErrorCode } from "../automation/workflow-failures.ts";
import type { PreviewLocalDate } from "../../ledger/pglite/preview-financial-data.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const FAILURE_CODES = {
  "sign-in-rejected": "authentication-failed",
  "session-conflict": "authentication-failed",
  "verification-rejected": "verification-failed",
  "verification-exhausted": "verification-failed",
  "verification-unsupported": "verification-configuration-failed",
  "device-registration-required": "device-registration-required",
  "unexpected-response": "source-validation-failed",
  "missing-currency": "source-validation-failed",
  "malformed-amount": "source-validation-failed",
  "incomplete-data": "source-collection-failed",
} as const satisfies Record<string, TypedWorkflowErrorCode>;

export type PreviewFailureReason = keyof typeof FAILURE_CODES;

export class PreviewSourceFailure extends FailureCodeError {
  readonly reason: PreviewFailureReason;

  constructor(reason: PreviewFailureReason, detail: string) {
    super(FAILURE_CODES[reason]);
    this.name = "PreviewSourceFailure";
    this.reason = reason;
    this.message = `Preview source stopped (${reason}): ${detail}`;
  }
}

export function fail(reason: PreviewFailureReason, detail: string): never {
  throw new PreviewSourceFailure(reason, detail);
}

/** Keep one row per source row key; the same key with different content is a malformed response. */
export function uniqueTransactions(
  rows: readonly (PreviewTransaction | null)[],
  keyName: string,
): PreviewTransaction[] {
  const byKey = new Map<string, PreviewTransaction>();
  for (const row of rows) {
    if (!row) continue;
    const previous = byKey.get(row.sourceRowKey);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) return fail("unexpected-response", `a ${keyName} repeats with different content`);
    byKey.set(row.sourceRowKey, row);
  }
  return [...byKey.values()];
}

export type PreviewCaptchaChallenge =
  | Readonly<{ image: Buffer; charset: "digits" | "alphanumeric"; expectedLength?: number }>
  | Readonly<{ audio: readonly Buffer[]; expectedLength?: number }>;

export type PreviewCaptchaSolver = (context: PreviewWorkflowContext, challenge: PreviewCaptchaChallenge) => Promise<string | null>;

export const MAX_CHALLENGES_PER_ROUND = 5;

export async function solveChallengeRound(
  context: PreviewWorkflowContext,
  solve: PreviewCaptchaSolver,
  nextChallenge: () => Promise<PreviewCaptchaChallenge>,
  maxChallenges: number,
): Promise<string> {
  for (let index = 0; index < maxChallenges; index += 1) {
    const answer = await solve(context, await nextChallenge());
    if (answer !== null) return answer;
  }
  await context.signalEvent("verification-solver-exhausted");
  return fail("verification-exhausted", `no answer accepted in ${maxChallenges} CAPTCHA challenge(s)`);
}

/** ADR 0039: a challenge without a calibrated solver route ends the run. */
export async function refuseUnsupportedVerification(context: PreviewWorkflowContext, challenge: string): Promise<never> {
  await context.signalEvent("solver-challenge-unsupported");
  return fail("verification-unsupported", challenge);
}

export async function requireDeviceRegistration(context: PreviewWorkflowContext, detail: string): Promise<never> {
  await context.event("authentication", "advanced", "device-registration-required");
  return fail("device-registration-required", detail);
}

/** JSON.parse that keeps every number as its source lexeme, so no amount passes through a float. */
export function parseSourceJson(text: string, endpoint: string): unknown {
  try {
    return JSON.parse(text, (_key, value, context?: { source?: string }) =>
      typeof value === "number" ? context?.source ?? fail("unexpected-response", `${endpoint} number without source`) : value);
  } catch (error) {
    if (error instanceof PreviewSourceFailure) throw error;
    return fail("unexpected-response", `${endpoint} is not JSON`);
  }
}

export type SourceRecord = Readonly<Record<string, unknown>>;

export function record(value: unknown, field: string): SourceRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("unexpected-response", `${field} is not an object`);
  return value as SourceRecord;
}

export function records(value: unknown, field: string): readonly SourceRecord[] {
  if (!Array.isArray(value)) return fail("unexpected-response", `${field} is not a list`);
  return value.map((item, index) => record(item, `${field}[${index}]`));
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") return fail("unexpected-response", `${field} is missing`);
  return value.trim();
}

export function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const PLAIN_DECIMAL = /^[+-]?\d+(?:\.\d+)?$/u;
const GROUPED_DECIMAL = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u;

/** Keeps the source lexeme: drops thousands separators and a leading plus, never rounds. */
export function exactDecimal(value: unknown, field: string): string {
  if (typeof value !== "string") return fail("malformed-amount", `${field} is not a decimal lexeme`);
  const lexeme = value.trim();
  if (!PLAIN_DECIMAL.test(lexeme) && !GROUPED_DECIMAL.test(lexeme)) return fail("malformed-amount", `${field} is not a decimal`);
  return lexeme.replaceAll(",", "").replace(/^\+/u, "");
}

/** Exact signed sum of decimal lexemes at the widest operand scale, never rounded. */
export function decimalSum(terms: readonly (readonly [1 | -1, string])[]): string {
  const scale = Math.max(0, ...terms.map(([, value]) => value.split(".")[1]?.length ?? 0));
  const total = terms.reduce((sum, [sign, value]) => {
    const [whole = "", fraction = ""] = value.replace(/^[+-]/u, "").split(".");
    const units = BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
    return sum + BigInt(sign) * (value.startsWith("-") ? -units : units);
  }, 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return total < 0n ? `-${body}` : body;
}

export function isZeroDecimal(amount: string): boolean {
  return /^[+-]?0+(?:\.0+)?$/u.test(amount);
}

export function unsignedDecimal(amount: string): string {
  return amount.replace(/^-/u, "");
}

/**
 * An ISO 4217 code read from the source. `aliases` maps a source's own
 * spelling (such as "NTD") to its ISO code; it is never a default.
 */
export function currencyCode(
  value: unknown,
  field: string,
  aliases: Readonly<Record<string, string>> = {},
): string {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  const code = aliases[raw] ?? raw;
  if (!/^[A-Z]{3}$/u.test(code)) return fail("missing-currency", `${field} has no ISO 4217 currency`);
  return code;
}

/** A source timestamp such as an HTTP Date header, or the collection time when none is reported. */
export function observedAt(reported: string | null | undefined, collectedAt: string) {
  if (reported) {
    const at = Date.parse(reported);
    if (!Number.isNaN(at)) return { at: new Date(at).toISOString(), source: "reported" as const };
  }
  return { at: collectedAt, source: "collection-time" as const };
}

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** The calendar date in Asia/Taipei for an instant, as YYYY-MM-DD. */
export function taipeiDate(instant: string | number | Date): string {
  return new Date(new Date(instant).getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

/** Taipei calendar dates from `months - 1` whole months before `now` through `now`. */
export function taipeiMonthWindow(now: string, months: number): Readonly<{ start: string; end: string }> {
  const end = taipeiDate(now);
  const [year, month] = end.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(year, month - months, 1)).toISOString().slice(0, 10);
  return { start, end };
}

const SOURCE_DATE_TIME =
  /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})(?:[T ](\d{2}):?(\d{2})(?::?(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/u;

/**
 * A source date or date-time as a Taipei local date with the precision the
 * source gave. Accepts YYYY-MM-DD, YYYY/MM/DD, or YYYYMMDD, an optional time,
 * an optional zone (converted to Taipei), or epoch milliseconds.
 */
export function localDate(value: unknown, field: string): PreviewLocalDate {
  const raw = typeof value === "string" ? value.trim() : "";
  if (/^\d{12,13}$/u.test(raw)) {
    return { precision: "second", value: new Date(Number(raw) + TAIPEI_OFFSET_MS).toISOString().slice(0, 19) };
  }
  const match = SOURCE_DATE_TIME.exec(raw);
  if (!match) return fail("unexpected-response", `${field} is not a date`);
  const [, year, month, day, hour, minute, second, zone] = match;
  const date = `${year}-${month}-${day}`;
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    return fail("unexpected-response", `${field} is not a calendar date`);
  if (hour === undefined) return { precision: "day", value: date };
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) return fail("unexpected-response", `${field} is not a time`);
  const precision = second === undefined ? "minute" : "second";
  const local = `${date}T${hour}:${minute}:${second ?? "00"}`;
  if (zone === undefined) return { precision, value: local.slice(0, precision === "second" ? 19 : 16) };
  const offset = zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const taipei = new Date(Date.parse(`${local}${offset}`) + TAIPEI_OFFSET_MS).toISOString();
  return { precision, value: taipei.slice(0, precision === "second" ? 19 : 16) };
}
