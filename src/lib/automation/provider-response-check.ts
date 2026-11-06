/**
 * The checks a source's provider response passes before a parser reads it
 * (ADR 0109, ADR 0110). A failed check names itself with one of these, so a
 * failure diagnostic can say which check rejected the source without
 * carrying its message.
 */
export const PROVIDER_RESPONSE_CHECKS = [
  "response-endpoint",
  "response-method",
  "response-status",
  "response-content-type",
  "response-cache-control",
  "response-date",
  "response-charset",
  "response-disposition",
  "response-size",
  "evidence-json",
  "row-parse",
] as const;

export type ProviderResponseCheck = (typeof PROVIDER_RESPONSE_CHECKS)[number];

const providerResponseChecks: ReadonlySet<string> = new Set(PROVIDER_RESPONSE_CHECKS);

export function isProviderResponseCheck(value: unknown): value is ProviderResponseCheck {
  return typeof value === "string" && providerResponseChecks.has(value);
}

/**
 * A provider response check that rejected its source. It keeps the name
 * `Error`: the check names the failure, and the message reads as before.
 */
export class ProviderResponseCheckError extends Error {
  readonly check: ProviderResponseCheck;

  constructor(check: ProviderResponseCheck, message: string, options?: ErrorOptions) {
    super(message, options);
    this.check = check;
  }
}
