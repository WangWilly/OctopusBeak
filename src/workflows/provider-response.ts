/**
 * Provider response verification (ADR 0110): check one response a source
 * read against what the source declared about it, then strictly decode its
 * evidence. A check that rejects the response names itself, so a failure
 * diagnostic can say which one did without carrying the message.
 */
import { ProviderResponseCheckError } from "../lib/automation/provider-response-check.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";

/** The raw evidence an acquisition hands over, before any decoding. */
export type ProviderEvidence =
  /** A response body, decoded as UTF-8 JSON. */
  | Readonly<{ kind: "json"; bytes: Uint8Array }>
  /** A response body, decoded as the endpoint's declared charset. */
  | Readonly<{ kind: "text"; bytes: Uint8Array }>
  /** DOM table text, one array of cell texts per row. */
  | Readonly<{ kind: "cells"; rows: readonly (readonly string[])[] }>
  /** Page markup already read as text, from the DOM or a decoded response body. */
  | Readonly<{ kind: "html"; html: string }>;

/** The evidence after strict decoding, narrowed to the kind the source acquires. */
export type DecodedProviderEvidence<Evidence extends ProviderEvidence = ProviderEvidence> =
  Evidence extends Readonly<{ kind: "json" }>
    ? Readonly<{
        kind: "json";
        value: unknown;
        /** The strictly decoded UTF-8 body, for parsers that must keep numeric lexemes. */
        text: string;
      }>
    : Evidence extends Readonly<{ kind: "text" }>
      ? Readonly<{ kind: "text"; text: string }>
      : Evidence extends Readonly<{ kind: "html" }>
        ? Readonly<{ kind: "html"; html: string }>
        : Readonly<{ kind: "cells"; rows: readonly (readonly string[])[] }>;

/** The transport facts of the one provider response an acquisition observed. */
export type ProviderResponse = Readonly<{
  url: string;
  status: number;
  method: string;
  headers: Readonly<Record<string, string>>;
}>;

/** What an acquisition hands over: the raw evidence and the response that carried it. */
export type ProviderAcquisition = Readonly<{ evidence: ProviderEvidence; response: ProviderResponse }>;

/** One provider endpoint whose response may carry the evidence. */
export type ProviderEndpoint = Readonly<{
  path: string;
  /** Absent for a source whose response method was never established, such as Fubon's navigated page. */
  method?: "GET" | "POST";
  /** The Content-Type the response must carry. Absent accepts any. */
  contentType?: RegExp;
  /** The query string the URL may carry, including its "?". Absent allows none. */
  search?: RegExp;
  /**
   * The charset a text body is in. Text evidence needs one; JSON is always
   * UTF-8. "declared" takes whatever the response names, in its Content-Type
   * or else an HTML `<meta charset>`, for a source whose pages differ.
   */
  charset?: ProviderCharset | "declared";
  /** Whether the response must name itself an attachment in Content-Disposition. */
  attachment?: true;
}>;

/**
 * The charset a body decodes as, and the Content-Type labels that may name it
 * besides its own WHATWG labels, such as "cp950" for Big5.
 */
export type ProviderCharset = Readonly<{ decode: string; labels?: readonly string[] }>;

/** Whether the response must carry an HTTP Date, or the body may carry the provider time instead. */
export type ProviderDateRule = "required" | "optional";

/** What a source declares about the response that carries its evidence. */
export type ProviderResponseDeclaration<DateRule extends ProviderDateRule = ProviderDateRule> = Readonly<{
  /** Leads every rejection message, such as "SinoPac current deposit". */
  label: string;
  host: string;
  endpoints: readonly ProviderEndpoint[];
  /** Cache-Control directives the response must carry. */
  cacheControl: readonly string[];
  providerDate: DateRule;
  /** The largest body the source reads, by its declared Content-Length and its bytes. */
  maxBytes?: number;
}>;

export type ProviderDate = Readonly<{ raw: string; effectiveAt: string }>;

/**
 * A provider response whose transport facts match the source's declaration,
 * with the run's time of observing it. The provider date may establish
 * effective time; observedAt never does.
 */
export type VerifiedProviderResponse<DateRule extends ProviderDateRule = ProviderDateRule> = Readonly<{
  url: URL;
  endpoint: ProviderEndpoint;
  contentType: string;
  cacheControl: string;
  providerDate: DateRule extends "required" ? ProviderDate : ProviderDate | null;
  /** RFC3339 in Taipei's offset, to the second, from the run clock. */
  observedAt: string;
}>;

/** A response that passed every declared check, with its strictly decoded evidence. */
export type AcceptedProviderResponse<
  Acquired extends ProviderAcquisition,
  DateRule extends ProviderDateRule,
> = Readonly<{
  response: VerifiedProviderResponse<DateRule>;
  evidence: DecodedProviderEvidence<Acquired["evidence"]>;
}>;

/**
 * Verify one acquired response against the source's declaration, then
 * strictly decode its evidence. The only way a source's parser receives
 * decoded evidence: a check that fails throws before any decoding.
 */
export function acceptProviderResponse<Acquired extends ProviderAcquisition, DateRule extends ProviderDateRule>(
  declaration: ProviderResponseDeclaration<DateRule>,
  acquired: Acquired,
  input: Readonly<{ observedAt: string; text: SourceTextPort }>,
): AcceptedProviderResponse<Acquired, DateRule> {
  const response = verifyProviderResponse(declaration, acquired.response, input.observedAt);
  // Decoding keeps the evidence kind, which the conditional type cannot see.
  const evidence = decodeEvidence(declaration, response, acquired.evidence, input.text) as
    DecodedProviderEvidence<Acquired["evidence"]>;
  return { response, evidence };
}

const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

function declaredEndpoint(declaration: ProviderResponseDeclaration, url: URL): ProviderEndpoint | undefined {
  if (
    url.protocol !== "https:" ||
    url.hostname !== declaration.host ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  )
    return undefined;
  return declaration.endpoints.find((endpoint) =>
    endpoint.path === url.pathname && (endpoint.search ?? /^$/u).test(url.search));
}

/** Whether an observed response is one the declaration names, for an acquisition waiting on it. */
export function isDeclaredProviderResponse(
  declaration: ProviderResponseDeclaration,
  url: string,
  method: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const endpoint = declaredEndpoint(declaration, parsed);
  return !!endpoint && (!endpoint.method || endpoint.method === method.toUpperCase());
}

function header(headers: Readonly<Record<string, string>>, name: string): string {
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name) return value.trim();
  return "";
}

function providerDate(label: string, headers: Readonly<Record<string, string>>): ProviderDate | null {
  const raw = header(headers, "date");
  if (raw === "") return null;
  const time = Date.parse(raw);
  if (!HTTP_DATE.test(raw) || !Number.isFinite(time) || new Date(time).toUTCString() !== raw)
    throw new ProviderResponseCheckError("response-date", `${label} response HTTP Date is invalid.`);
  return { raw, effectiveAt: new Date(time).toISOString() };
}

/** Check one response's transport facts against the source's declaration. */
export function verifyProviderResponse<DateRule extends ProviderDateRule>(
  declaration: ProviderResponseDeclaration<DateRule>,
  response: ProviderResponse,
  observedAt: string,
): VerifiedProviderResponse<DateRule> {
  const { label } = declaration;
  let url: URL;
  try {
    url = new URL(response.url);
  } catch {
    throw new ProviderResponseCheckError("response-endpoint", `${label} response URL is invalid.`);
  }
  const endpoint = declaredEndpoint(declaration, url);
  if (!endpoint)
    throw new ProviderResponseCheckError("response-endpoint", `${label} response endpoint is unexpected: ${url.host}${url.pathname}`);
  if (endpoint.method && response.method.toUpperCase() !== endpoint.method)
    throw new ProviderResponseCheckError("response-method", `${label} response method is not ${endpoint.method}.`);
  if (response.status !== 200)
    throw new ProviderResponseCheckError("response-status", `${label} response status is ${response.status}, expected 200.`);
  const contentType = header(response.headers, "content-type");
  if (endpoint.contentType && !endpoint.contentType.test(contentType))
    throw new ProviderResponseCheckError("response-content-type", `${label} response content type is unexpected: ${contentType}`);
  const cacheControl = header(response.headers, "cache-control");
  const directives = new Set(cacheControl.toLowerCase().split(",").map((directive) => directive.trim()));
  if (!declaration.cacheControl.every((directive) => directives.has(directive)))
    throw new ProviderResponseCheckError(
      "response-cache-control",
      `${label} response must carry Cache-Control: ${declaration.cacheControl.join(", ")}.`,
    );
  if (endpoint.attachment && !/\battachment\b/iu.test(header(response.headers, "content-disposition")))
    throw new ProviderResponseCheckError("response-disposition", `${label} response is not an attachment.`);
  const declaredLength = Number(header(response.headers, "content-length") || Number.NaN);
  if (declaration.maxBytes !== undefined && Number.isFinite(declaredLength) && declaredLength > declaration.maxBytes)
    throw new ProviderResponseCheckError("response-size", `${label} response exceeds ${declaration.maxBytes} bytes.`);
  const date = providerDate(label, response.headers);
  if (!date && declaration.providerDate === "required")
    throw new ProviderResponseCheckError("response-date", `${label} response is missing HTTP Date.`);
  // The declared rule narrows whether the date may be null, which TypeScript cannot follow.
  return { url, endpoint, contentType, cacheControl, providerDate: date, observedAt } as VerifiedProviderResponse<DateRule>;
}

const UTF_8: ProviderCharset = { decode: "utf-8" };

function encodingOf(label: string): string | undefined {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
}

/** The charset a body decodes as, after its Content-Type label, if any, names that charset. */
function bodyCharset(label: string, response: VerifiedProviderResponse, charset: ProviderCharset): string {
  const encoding = encodingOf(charset.decode);
  if (!encoding) throw new Error(`${label} declares an unknown charset: ${charset.decode}`);
  const named = NAMED_CHARSET.exec(response.contentType)?.[1]?.toLowerCase();
  if (named && !charset.labels?.includes(named) && encodingOf(named) !== encoding)
    throw new ProviderResponseCheckError("response-charset", `${label} response charset is not ${charset.decode}.`);
  return charset.decode;
}

const NAMED_CHARSET = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu;

/**
 * The charset a response names for itself: its Content-Type label, or else a
 * `<meta charset>` in the first 4 KiB. Charset declarations are ASCII, so
 * reading that prefix as Latin-1 decodes none of the payload.
 */
function declaredCharset(label: string, response: VerifiedProviderResponse, bytes: Uint8Array): string {
  const named = NAMED_CHARSET.exec(response.contentType)?.[1]
    ?? /<meta\b[^>]*\bcharset\s*=\s*["']?([^\s;"'/>]+)/iu.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 4096)))?.[1];
  if (!named || !encodingOf(named))
    throw new ProviderResponseCheckError("response-charset", `${label} response declares no known charset.`);
  return named;
}

function decodeEvidence(
  declaration: ProviderResponseDeclaration,
  response: VerifiedProviderResponse,
  evidence: ProviderEvidence,
  text: SourceTextPort,
): DecodedProviderEvidence {
  if (evidence.kind === "cells") {
    for (const row of evidence.rows) for (const cell of row) text.assertIntact(cell);
    return evidence;
  }
  if (evidence.kind === "html") {
    text.assertIntact(evidence.html);
    return evidence;
  }
  const { label, maxBytes } = declaration;
  if (maxBytes !== undefined && evidence.bytes.byteLength > maxBytes)
    throw new ProviderResponseCheckError("response-size", `${label} response exceeds ${maxBytes} bytes.`);
  if (evidence.kind === "text") {
    const charset = response.endpoint.charset;
    if (!charset) throw new Error(`${label} declares no charset for its text response.`);
    const decodeAs = charset === "declared"
      ? declaredCharset(label, response, evidence.bytes)
      : bodyCharset(label, response, charset);
    return { kind: "text", text: text.decode(evidence.bytes, decodeAs) };
  }
  const decoded = text.decode(evidence.bytes, bodyCharset(label, response, UTF_8));
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new ProviderResponseCheckError("evidence-json", "Provider response is not valid JSON.");
  }
  // JSON may encode U+FFFD as an escape, so check the parsed fields too.
  text.assertIntact(JSON.stringify(value));
  return { kind: "json", value, text: decoded };
}
