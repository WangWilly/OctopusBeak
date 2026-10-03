import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CATHAY_GMAIL_CONNECTED_EMAIL_KEY,
  CATHAY_GMAIL_REFRESH_TOKEN_KEY,
  getAutomationCredentialCodec,
  readAutomationCredentialsFile,
  writeAutomationCredentialsFile,
} from "./config-files.ts";
import type { AutomationCredentialCodec } from "./config-files.ts";
import type { GmailOtpBrokerService } from "./gmail-otp-broker.ts";
import type { GmailOtpFallbackReason } from "../gmail-otp.ts";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GMAIL_API_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me";
export const CATHAY_GMAIL_OTP_SUBJECT = "CUBE 網路銀行登入兩步驟驗證";
export const CATHAY_GMAIL_SENDER_DOMAIN = "pxbillrc01.cathaybk.com.tw";
export const CATHAY_GMAIL_OAUTH_CONFIG_RELATIVE_PATH = "data/google-oauth/google-oauth-desktop-client.json";
export const CATHAY_GMAIL_POLL_INTERVAL_MS = 5_000;
export const CATHAY_GMAIL_POLL_TIMEOUT_MS = 120_000;
const CATHAY_GMAIL_BOUNDARY_LOOKBACK_MS = 5 * 60_000;
const CATHAY_GMAIL_BOUNDARY_TTL_MS = CATHAY_GMAIL_POLL_TIMEOUT_MS + 60_000;

const AUTH_CALLBACK_PATH = "/oauth2callback";
const AUTH_TIMEOUT_MS = 5 * 60_000;
const ACCESS_TOKEN_SKEW_MS = 30_000;
const TRUSTED_GOOGLE_AUTHSERV_IDS = new Set(["mx.google.com"]);
const ALLOWED_CATHAY_DOMAINS = new Set(["cathaybk.com.tw", CATHAY_GMAIL_SENDER_DOMAIN]);
const ICLOUD_DOMAINS = new Set(["icloud.com", "me.com"]);

type FetchLike = typeof fetch;

export type CathayGmailOtpStatus = {
  enabled: boolean;
  connectedEmail: string | null;
  needsAuthorization: boolean;
  connectionError?: CathayGmailOtpConnectionError;
};

export type CathayGmailOtpConnectionError =
  | "authorization-cancelled"
  | "authorization-failed"
  | "token-exchange-failed"
  | "gmail-profile-failed"
  | "credential-storage-failed";

export type CathayGmailOtpAccessResult =
  | { status: "ready" }
  | { status: "fallback"; reason: GmailOtpFallbackReason };

export type CathayGmailOtpResult =
  | { status: "found"; otp: string }
  | { status: "fallback"; reason: GmailOtpFallbackReason };

export type CathayGmailOtpBoundaryResult =
  | { status: "prepared"; boundaryId: string }
  | { status: "fallback"; reason: GmailOtpFallbackReason };

export type GoogleOAuthClient = {
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
};

export type OAuthCallbackResult =
  | { status: "accepted"; code: string }
  | { status: "cancelled"; reason: "access_denied" | "oauth-error" }
  | { status: "invalid" };

export type GmailRawMessage = {
  id: string;
  internalDate: string;
  raw: string;
};

type GmailApi = {
  listMessages(accessToken: string, requestedAfterMs?: number, signal?: AbortSignal): Promise<{ messages: { id: string }[]; nextPageToken?: string }>;
  getMessage(accessToken: string, id: string, signal?: AbortSignal): Promise<GmailRawMessage>;
  profile(accessToken: string, signal?: AbortSignal): Promise<{ emailAddress: string }>;
};

export type GmailOtpServiceOptions = {
  settingsPath?: string;
  credentialsPath?: string;
  appRoot?: string;
  fetch?: FetchLike;
  openExternal?: (url: string) => Promise<void> | void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  api?: Partial<GmailApi>;
  oauthAuthorize?: (signal?: AbortSignal) => Promise<{ refreshToken: string; connectedEmail: string }>;
};

type OAuthTokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  error?: unknown;
  error_description?: unknown;
};

type OAuthAuthorizationResult = {
  refreshToken: string;
  connectedEmail: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
};

type OAuthAuthorizationFlight = {
  promise: Promise<OAuthAuthorizationResult>;
  controller: AbortController;
  consumers: number;
};

let globalAuthorizationFlight: OAuthAuthorizationFlight | null = null;

function safeString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizedDomain(value: string) {
  return value.trim().toLowerCase().replace(/^.*@/, "").replace(/[>\s].*$/, "").replace(/[.,;]+$/, "");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireCredentialCodec(codec: AutomationCredentialCodec | null) {
  if (!codec) {
    throw new GmailOtpAuthorizationError("credential-storage-failed");
  }
}

function base64UrlEncode(value: Uint8Array) {
  return Buffer.from(value).toString("base64url");
}

export function createPkceVerifier(random: () => Uint8Array = () => randomBytes(32)) {
  const verifier = base64UrlEncode(random());
  if (verifier.length < 43 || verifier.length > 128)
    throw new Error("Generated PKCE verifier is outside RFC 7636 bounds.");
  return verifier;
}

export function pkceChallengeForVerifier(verifier: string) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
    throw new TypeError("PKCE verifier is invalid.");
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

export function createOAuthState(random: () => Uint8Array = () => randomBytes(24)) {
  const state = base64UrlEncode(random());
  if (state.length < 32) throw new Error("Generated OAuth state is too short.");
  return state;
}

export function buildGoogleAuthorizationUrl({
  client,
  state,
  codeChallenge,
  redirectUri,
}: {
  client: GoogleOAuthClient;
  state: string;
  codeChallenge: string;
  redirectUri: string;
}) {
  const url = new URL(client.authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_READONLY_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export function validateOAuthCallbackUrl(
  callbackUrl: string,
  expected: { state: string; redirectUri: string },
): OAuthCallbackResult {
  let actual: URL;
  let redirect: URL;
  try {
    actual = new URL(callbackUrl);
    redirect = new URL(expected.redirectUri);
  } catch {
    return { status: "invalid" };
  }
  if (
    actual.protocol !== "http:" ||
    actual.hostname !== "127.0.0.1" ||
    actual.port !== redirect.port ||
    actual.pathname !== AUTH_CALLBACK_PATH ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.pathname !== AUTH_CALLBACK_PATH ||
    actual.searchParams.get("state") !== expected.state
  ) {
    return { status: "invalid" };
  }
  const error = actual.searchParams.get("error");
  if (error) {
    return error === "access_denied"
      ? { status: "cancelled", reason: "access_denied" }
      : { status: "cancelled", reason: "oauth-error" };
  }
  const code = actual.searchParams.get("code");
  return code ? { status: "accepted", code } : { status: "invalid" };
}

export function parseGoogleOAuthClientConfig(value: unknown): GoogleOAuthClient | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!record.installed || typeof record.installed !== "object" || Array.isArray(record.installed)) return null;
  const nested = record.installed as Record<string, unknown>;
  const clientId = safeString(nested.client_id).trim();
  if (!clientId || clientId.length > 512) return null;
  const authUri = safeString(nested.auth_uri).trim() || GOOGLE_AUTH_ENDPOINT;
  const tokenUri = safeString(nested.token_uri).trim() || GOOGLE_TOKEN_ENDPOINT;
  try {
    const authUrl = new URL(authUri);
    const tokenUrl = new URL(tokenUri);
    if (authUrl.protocol !== "https:" || tokenUrl.protocol !== "https:") return null;
    return {
      clientId,
      ...(nonEmpty(nested.client_secret) ? { clientSecret: nested.client_secret.trim() } : {}),
      authorizationEndpoint: authUrl.toString(),
      tokenEndpoint: tokenUrl.toString(),
    };
  } catch {
    return null;
  }
}

function parseHeaderBlock(raw: string) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else if (line) {
      unfolded.push(line);
    }
  }
  const headers = new Map<string, string[]>();
  for (const line of unfolded) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const values = headers.get(name) ?? [];
    values.push(value);
    headers.set(name, values);
  }
  return headers;
}

function splitMimePart(raw: string) {
  const normalized = raw.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  return separator < 0
    ? { headers: new Map<string, string[]>(), body: normalized }
    : {
        headers: parseHeaderBlock(normalized.slice(0, separator)),
        body: normalized.slice(separator + 2),
      };
}

function decodeMimeHeader(value: string) {
  return value.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, charset, encoding, text) => {
    try {
      if (encoding.toLowerCase() === "b") {
        return Buffer.from(text, "base64").toString(String(charset).toLowerCase() === "utf-8" ? "utf8" : "latin1");
      }
      const bytes: number[] = [];
      const q = String(text).replace(/_/g, " ");
      for (let i = 0; i < q.length; i += 1) {
        if (q[i] === "=" && /^[0-9A-F]{2}$/i.test(q.slice(i + 1, i + 3))) {
          bytes.push(parseInt(q.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(q.charCodeAt(i));
      }
      return Buffer.from(bytes).toString(String(charset).toLowerCase() === "utf-8" ? "utf8" : "latin1");
    } catch {
      return "";
    }
  });
}

function contentType(headers: Map<string, string[]>) {
  return (headers.get("content-type")?.[0] ?? "text/plain").toLowerCase();
}

function contentTransferEncoding(headers: Map<string, string[]>) {
  return (headers.get("content-transfer-encoding")?.[0] ?? "7bit").toLowerCase();
}

function contentTypeParameter(type: string, name: string) {
  const match = new RegExp(`(?:^|;)\\s*${name}=\\s*(?:"([^"]+)"|([^;\\s]+))`, "i").exec(type);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function decodeTransferBody(body: string, encoding: string) {
  if (encoding === "base64") {
    try {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  if (encoding === "quoted-printable") {
    const softBreakRemoved = body.replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < softBreakRemoved.length; i += 1) {
      if (
        softBreakRemoved[i] === "=" &&
        /^[0-9A-F]{2}$/i.test(softBreakRemoved.slice(i + 1, i + 3))
      ) {
        bytes.push(parseInt(softBreakRemoved.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(softBreakRemoved.charCodeAt(i));
      }
    }
    return Buffer.from(bytes).toString("utf8");
  }
  return body;
}

function splitMultipart(body: string, boundary: string) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const marker = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === marker || line === `${marker}--`) {
      if (current) parts.push(current.join("\n"));
      current = line === `${marker}--` ? null : [];
      if (line === `${marker}--`) break;
      continue;
    }
    if (current) current.push(line);
  }
  return parts;
}

function decodeHtmlText(html: string) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function textParts(raw: string): { plain: string[]; html: string[] } {
  const part = splitMimePart(raw);
  const type = contentType(part.headers);
  if (type.startsWith("multipart/")) {
    const boundary = contentTypeParameter(type, "boundary");
    if (!boundary) return { plain: [], html: [] };
    return splitMultipart(part.body, boundary)
      .map(textParts)
      .reduce(
        (result, child) => ({ plain: [...result.plain, ...child.plain], html: [...result.html, ...child.html] }),
        { plain: [], html: [] } as { plain: string[]; html: string[] },
      );
  }
  if (type.startsWith("text/plain")) {
    return { plain: [decodeTransferBody(part.body, contentTransferEncoding(part.headers))], html: [] };
  }
  if (type.startsWith("text/html")) {
    return { plain: [], html: [decodeHtmlText(decodeTransferBody(part.body, contentTransferEncoding(part.headers)))] };
  }
  return { plain: [], html: [] };
}

export function parseGmailRawMessage(raw: string) {
  const root = splitMimePart(raw);
  const parts = textParts(raw);
  const plain = parts.plain.find((value) => value.trim()) ?? "";
  const html = parts.html.find((value) => value.trim()) ?? "";
  return {
    headers: root.headers,
    subject: decodeMimeHeader(root.headers.get("subject")?.[0] ?? "").trim(),
    body: plain || html,
  };
}

function headerParameter(value: string, name: string) {
  return new RegExp(`(?:^|;)\\s*${name}=\\s*([^;\\s]+)`, "i").exec(value)?.[1]?.replace(/^"|"$/g, "") ?? "";
}

function authenticationResults(headers: Map<string, string[]>) {
  return (headers.get("authentication-results") ?? [])
    .filter((value) => TRUSTED_GOOGLE_AUTHSERV_IDS.has(value.split(";", 1)[0]!.trim().toLowerCase()));
}

function authDomain(result: string, parameter: string) {
  const value = new RegExp(`${parameter}=([^;\\s)]+)`, "i").exec(result)?.[1] ?? "";
  return normalizedDomain(value);
}

function isPassForDomain(result: string, method: string, parameter: string, domains: Set<string>) {
  return new RegExp(`${method}=pass(?:\\s+[^;]*)?`, "i").test(result) && domains.has(authDomain(result, parameter));
}

function dkimSignatureCoversIcloudRelay(headers: Map<string, string[]>) {
  return (headers.get("dkim-signature") ?? []).some((value) => {
    const domain = normalizedDomain(headerParameter(value, "d"));
    const signedHeaders = headerParameter(value, "h").split(":").map((name) => name.trim().toLowerCase());
    return ICLOUD_DOMAINS.has(domain) && signedHeaders.includes("x-icloud-hme");
  });
}

type SenderAuthenticationResult =
  | { authenticated: true }
  | {
      authenticated: false;
      reason:
        | "unauthenticated-google-results"
        | "unauthenticated-cathay-alignment"
        | "unauthenticated-hme-original-sender"
        | "unauthenticated-hme-relay-auth"
        | "unauthenticated-hme-relay-signature";
    };

function senderAuthentication(headers: Map<string, string[]>): SenderAuthenticationResult {
  const results = authenticationResults(headers);
  if (results.length === 0)
    return { authenticated: false, reason: "unauthenticated-google-results" };
  const direct = results.some((result) => {
    const from = authDomain(result, "header.from");
    const alignedFrom = ALLOWED_CATHAY_DOMAINS.has(from) || from.endsWith(".cathaybk.com.tw");
    const alignedDkim = isPassForDomain(result, "dkim", "header.d", ALLOWED_CATHAY_DOMAINS) ||
      isPassForDomain(result, "dkim", "header.i", ALLOWED_CATHAY_DOMAINS) ||
      (authDomain(result, "header.d").endsWith(".cathaybk.com.tw") && /dkim=pass/i.test(result));
    return alignedFrom && alignedDkim && /dmarc=pass(?:\s|;|$)/i.test(result);
  });
  if (direct) return { authenticated: true };

  const hmeHeaders = headers.get("x-icloud-hme") ?? [];
  if (hmeHeaders.length === 0)
    return { authenticated: false, reason: "unauthenticated-cathay-alignment" };
  // Apple HME records the final destination in `f` and the authenticated
  // pre-relay sender in `s`; only the signed `s` value establishes Cathay.
  const hmeOriginalDomain = hmeHeaders
    .map((value) => normalizedDomain(headerParameter(value, "s")))
    .some((domain) => domain === CATHAY_GMAIL_SENDER_DOMAIN);
  if (!hmeOriginalDomain)
    return { authenticated: false, reason: "unauthenticated-hme-original-sender" };
  const hmeAuth = results.some((result) => {
    const alignedFrom = ICLOUD_DOMAINS.has(authDomain(result, "header.from"));
    const alignedDkim = isPassForDomain(result, "dkim", "header.i", ICLOUD_DOMAINS) ||
      isPassForDomain(result, "dkim", "header.d", ICLOUD_DOMAINS);
    return alignedFrom && alignedDkim && /dmarc=pass(?:\s|;|$)/i.test(result);
  });
  if (!hmeAuth)
    return { authenticated: false, reason: "unauthenticated-hme-relay-auth" };
  if (!dkimSignatureCoversIcloudRelay(headers))
    return { authenticated: false, reason: "unauthenticated-hme-relay-signature" };
  return { authenticated: true };
}

export type GmailOtpInspection =
  | { status: "eligible"; otp: string }
  | {
      status: "rejected";
      reason:
        | "stale-candidate"
        | "malformed-candidate"
        | Exclude<SenderAuthenticationResult, { authenticated: true }>["reason"];
    };

export function inspectCathayGmailOtpMessage(message: GmailRawMessage, requestedAfterMs: number): GmailOtpInspection {
  const internalDateMs = Number(message.internalDate);
  if (!Number.isSafeInteger(internalDateMs) || internalDateMs <= requestedAfterMs)
    return { status: "rejected", reason: "stale-candidate" };
  const parsed = parseGmailRawMessage(message.raw);
  if (parsed.subject !== CATHAY_GMAIL_OTP_SUBJECT)
    return { status: "rejected", reason: "malformed-candidate" };
  const authentication = senderAuthentication(parsed.headers);
  if (!authentication.authenticated)
    return { status: "rejected", reason: authentication.reason };
  if (
    !/CUBE/i.test(parsed.body) ||
    !/(?:5|五)\s*分鐘/.test(parsed.body) ||
    !/登入兩步(?:驟)?驗證|兩步(?:驟)?驗證/.test(parsed.body) ||
    !/若非您本人操作/.test(parsed.body) ||
    !/重設網銀密碼/.test(parsed.body)
  )
    return { status: "rejected", reason: "malformed-candidate" };
  const candidates = [...parsed.body.matchAll(/\b[A-Z]{4}-[0-9]{6}\b/g)].map((match) => match[0]!);
  if (candidates.length !== 1)
    return { status: "rejected", reason: "malformed-candidate" };
  return { status: "eligible", otp: candidates[0]! };
}

export type GmailOtpPollInput = {
  requestedAfterMs: number;
  knownMessageIds?: ReadonlySet<string>;
  listMessages: (signal?: AbortSignal) => Promise<{ messages: { id: string }[]; nextPageToken?: string }>;
  getMessage: (id: string, signal?: AbortSignal) => Promise<GmailRawMessage>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
};

function cathayGmailOtpAbortError() {
  return new Error("Cathay Gmail OTP retrieval was cancelled.");
}

function throwIfCathayGmailOtpAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw cathayGmailOtpAbortError();
}

function awaitCathayGmailOtpOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(cathayGmailOtpAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(cathayGmailOtpAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function sleepWithCathayGmailOtpAbort(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCathayGmailOtpAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(cathayGmailOtpAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollCathayGmailOtp({
  requestedAfterMs,
  knownMessageIds,
  listMessages,
  getMessage,
  now = Date.now,
  sleep = sleepWithCathayGmailOtpAbort,
  signal,
  intervalMs = CATHAY_GMAIL_POLL_INTERVAL_MS,
  timeoutMs = CATHAY_GMAIL_POLL_TIMEOUT_MS,
}: GmailOtpPollInput): Promise<CathayGmailOtpResult> {
  throwIfCathayGmailOtpAborted(signal);
  if (!Number.isSafeInteger(requestedAfterMs) || requestedAfterMs < 0)
    return { status: "fallback", reason: "protocol-error" };
  const startedAt = now();
  let lastRejection: GmailOtpFallbackReason = "no-candidate";
  while (now() - startedAt <= timeoutMs) {
    let listing: { messages: { id: string }[]; nextPageToken?: string };
    try {
      throwIfCathayGmailOtpAborted(signal);
      listing = await awaitCathayGmailOtpOperation(listMessages(signal), signal);
      throwIfCathayGmailOtpAborted(signal);
    } catch {
      throwIfCathayGmailOtpAborted(signal);
      return { status: "fallback", reason: "gmail-request-failed" };
    }
    if (listing.nextPageToken) return { status: "fallback", reason: "ambiguous-candidate" };
    const inspections: GmailOtpInspection[] = [];
    try {
      for (const item of listing.messages.slice(0, 100)) {
        throwIfCathayGmailOtpAborted(signal);
        if (knownMessageIds?.has(item.id)) continue;
        inspections.push(await inspectCathayGmailOtpMessage(
          await awaitCathayGmailOtpOperation(getMessage(item.id, signal), signal),
          knownMessageIds ? 0 : requestedAfterMs,
        ));
        throwIfCathayGmailOtpAborted(signal);
      }
    } catch {
      throwIfCathayGmailOtpAborted(signal);
      return { status: "fallback", reason: "gmail-request-failed" };
    }
    const eligible = inspections.filter((item): item is { status: "eligible"; otp: string } => item.status === "eligible");
    throwIfCathayGmailOtpAborted(signal);
    if (eligible.length > 1) return { status: "fallback", reason: "ambiguous-candidate" };
    if (eligible.length === 1 && inspections.length === 1) {
      throwIfCathayGmailOtpAborted(signal);
      return { status: "found", otp: eligible[0]!.otp };
    }
    if (inspections.some((item) => item.status === "rejected")) {
      const reason = inspections.find((item) => item.status === "rejected")!.reason;
      lastRejection = reason;
      if (eligible.length === 1) return { status: "fallback", reason: "ambiguous-candidate" };
    }
    if (now() - startedAt >= timeoutMs) break;
    throwIfCathayGmailOtpAborted(signal);
    await awaitCathayGmailOtpOperation(
      sleep(Math.min(intervalMs, timeoutMs - Math.max(0, now() - startedAt)), signal),
      signal,
    );
  }
  throwIfCathayGmailOtpAborted(signal);
  return { status: "fallback", reason: lastRejection === "no-candidate" ? "timeout" : lastRejection };
}

function defaultApi(fetchImpl: FetchLike): GmailApi {
  async function apiJson<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(url, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`Gmail API request failed (${response.status}).`);
    return await response.json() as T;
  }
  return {
    async listMessages(accessToken, requestedAfterMs, signal) {
      const after = Number.isSafeInteger(requestedAfterMs) && requestedAfterMs !== undefined
        ? ` after:${Math.max(0, Math.floor(requestedAfterMs / 1000))}`
        : "";
      const query = encodeURIComponent(`subject:"${CATHAY_GMAIL_OTP_SUBJECT}"${after}`);
      const value = await apiJson<{ messages?: { id: string }[]; nextPageToken?: string }>(
        `${GMAIL_API_ENDPOINT}/messages?maxResults=100&q=${query}`,
        accessToken,
        signal ? { signal } : undefined,
      );
      return { messages: value.messages ?? [], ...(value.nextPageToken ? { nextPageToken: value.nextPageToken } : {}) };
    },
    async getMessage(accessToken, id, signal) {
      const value = await apiJson<GmailRawMessage & { raw?: unknown }>(
        `${GMAIL_API_ENDPOINT}/messages/${encodeURIComponent(id)}?format=raw`,
        accessToken,
        signal ? { signal } : undefined,
      );
      if (!nonEmpty(value.raw)) throw new Error("Gmail message did not include raw content.");
      let raw = value.raw;
      try {
        raw = Buffer.from(value.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      } catch {
        throw new Error("Gmail message raw content is invalid.");
      }
      return { ...value, raw };
    },
    async profile(accessToken, signal) {
      return await apiJson<{ emailAddress: string }>(
        `${GMAIL_API_ENDPOINT}/profile`,
        accessToken,
        signal ? { signal } : undefined,
      );
    },
  };
}

function parseTokenResponse(value: OAuthTokenResponse) {
  const accessToken = safeString(value.access_token).trim();
  const refreshToken = safeString(value.refresh_token).trim();
  const expiresIn = typeof value.expires_in === "number" && Number.isFinite(value.expires_in)
    ? value.expires_in
    : 3600;
  if (!accessToken) throw new Error("Google OAuth token response did not include an access token.");
  return { accessToken, refreshToken, expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 };
}

class CathayGmailOtpService implements GmailOtpBrokerService {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private readonly retrievalBoundaries = new Map<string, {
    createdAtMs: number;
    searchAfterMs: number;
    knownMessageIds: ReadonlySet<string>;
  }>();
  private readonly credentialsPath: string;
  private readonly appRoot: string;
  private readonly fetchImpl: FetchLike;
  private readonly openExternal: (url: string) => Promise<void> | void;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly api: GmailApi;
  private readonly oauthAuthorizeOverride?: GmailOtpServiceOptions["oauthAuthorize"];
  private readonly credentialCodec: AutomationCredentialCodec | null;

  constructor(options: GmailOtpServiceOptions = {}) {
    this.credentialsPath = options.credentialsPath ?? "credentials.json";
    this.appRoot = options.appRoot ?? process.env.OCTOPUSBEAK_APP_ROOT ?? process.cwd();
    this.fetchImpl = options.fetch ?? fetch;
    this.openExternal = options.openExternal ?? (() => {
      throw new Error("System browser opener is not configured.");
    });
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleepWithCathayGmailOtpAbort;
    this.credentialCodec = getAutomationCredentialCodec();
    const api = defaultApi(this.fetchImpl);
    this.api = {
      ...api,
      ...(options.api ?? {}),
    };
    this.oauthAuthorizeOverride = options.oauthAuthorize;
  }

  status(): CathayGmailOtpStatus {
    const credentials = readAutomationCredentialsFile(this.credentialsPath, this.credentialCodec);
    // Automatic verification is policy, independent of the saved Gmail grant.
    // Legacy enable flags cannot disable an already authorized mailbox.
    const enabled = true;
    const connectedEmail = nonEmpty(credentials[CATHAY_GMAIL_CONNECTED_EMAIL_KEY])
      ? credentials[CATHAY_GMAIL_CONNECTED_EMAIL_KEY].trim()
      : null;
    return {
      enabled,
      connectedEmail,
      needsAuthorization: enabled && !nonEmpty(credentials[CATHAY_GMAIL_REFRESH_TOKEN_KEY]),
    };
  }

  private credentials() {
    return readAutomationCredentialsFile(this.credentialsPath, this.credentialCodec);
  }

  private saveAuthorization(result: OAuthAuthorizationResult, signal?: AbortSignal) {
    try {
      throwIfCathayGmailOtpAborted(signal);
      requireCredentialCodec(this.credentialCodec);
      const credentials = this.credentials();
      throwIfCathayGmailOtpAborted(signal);
      writeAutomationCredentialsFile(this.credentialsPath, {
        ...credentials,
        [CATHAY_GMAIL_REFRESH_TOKEN_KEY]: result.refreshToken,
        [CATHAY_GMAIL_CONNECTED_EMAIL_KEY]: result.connectedEmail,
      }, this.credentialCodec);
    } catch {
      throw new GmailOtpAuthorizationError("credential-storage-failed");
    }
  }

  private async authorization(signal?: AbortSignal): Promise<OAuthAuthorizationResult> {
    throwIfCathayGmailOtpAborted(signal);
    let flight = globalAuthorizationFlight;
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = this.oauthAuthorizeOverride
        ? awaitCathayGmailOtpOperation(
          Promise.resolve().then(() => this.oauthAuthorizeOverride!(controller.signal)),
          controller.signal,
        )
        : this.performAuthorization(controller.signal);
      flight = { promise, controller, consumers: 0 };
      globalAuthorizationFlight = flight;
      void promise.then(
        () => { if (globalAuthorizationFlight === flight) globalAuthorizationFlight = null; },
        () => { if (globalAuthorizationFlight === flight) globalAuthorizationFlight = null; },
      );
    }
    const activeFlight = flight;
    activeFlight.consumers += 1;
    try {
      return await awaitCathayGmailOtpOperation(activeFlight.promise, signal);
    } finally {
      activeFlight.consumers -= 1;
      if (activeFlight.consumers === 0 && globalAuthorizationFlight === activeFlight) {
        globalAuthorizationFlight = null;
        activeFlight.controller.abort();
      }
    }
  }

  private clientConfig(): GoogleOAuthClient {
    const environmentClientId = process.env.OCTOPUSBEAK_GOOGLE_OAUTH_CLIENT_ID?.trim();
    if (environmentClientId) {
      return {
        clientId: environmentClientId,
        authorizationEndpoint: GOOGLE_AUTH_ENDPOINT,
        tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
      };
    }
    const path = join(this.appRoot, CATHAY_GMAIL_OAUTH_CONFIG_RELATIVE_PATH);
    if (!existsSync(path)) throw new Error("Google OAuth client configuration is not available.");
    const parsed = parseGoogleOAuthClientConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (!parsed) throw new Error("Google OAuth client configuration is invalid.");
    return parsed;
  }

  private async performAuthorization(signal: AbortSignal): Promise<OAuthAuthorizationResult> {
    throwIfCathayGmailOtpAborted(signal);
    const client = this.clientConfig();
    const verifier = createPkceVerifier();
    const challenge = pkceChallengeForVerifier(verifier);
    const state = createOAuthState();
    let callbackServer: ReturnType<typeof createServer> | null = null;
    let authorizationTimeout: ReturnType<typeof setTimeout> | null = null;
    let redirectUri = "";
    const callbackPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
      let settled = false;
      const server = createServer((request, response) => {
        const host = request.headers.host ?? "";
        const port = server.address() && typeof server.address() === "object"
          ? String((server.address() as { port: number }).port)
          : "";
        const callback = `http://127.0.0.1:${port}${request.url ?? AUTH_CALLBACK_PATH}`;
        const result = validateOAuthCallbackUrl(callback, {
          state,
          redirectUri: `http://127.0.0.1:${port}${AUTH_CALLBACK_PATH}`,
        });
        if (host !== `127.0.0.1:${port}` || result.status === "invalid") {
          response.statusCode = 400;
          response.end("Invalid OAuth callback.");
          return;
        }
        response.statusCode = 200;
        response.end("Google authorization received. Return to OctopusBeak to confirm the connection result.");
        if (!settled) {
          settled = true;
          resolve(result);
        }
      });
      callbackServer = server;
      server.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      server.listen(0, "127.0.0.1", () => {
        if (signal.aborted) return;
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("OAuth loopback server did not expose a port."));
          return;
        }
        redirectUri = `http://127.0.0.1:${address.port}${AUTH_CALLBACK_PATH}`;
        const authorizationUrl = buildGoogleAuthorizationUrl({
          client,
          state,
          codeChallenge: challenge,
          redirectUri,
        });
        Promise.resolve(this.openExternal(authorizationUrl)).catch((error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      });
      authorizationTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Google OAuth authorization timed out."));
        }
      }, AUTH_TIMEOUT_MS);
      authorizationTimeout.unref?.();
    });
    try {
      const callback = await awaitCathayGmailOtpOperation(callbackPromise, signal);
      throwIfCathayGmailOtpAborted(signal);
      if (callback.status === "cancelled") throw new GmailOtpAuthorizationError("authorization-cancelled");
      if (callback.status !== "accepted") throw new GmailOtpAuthorizationError("authorization-failed");
      const body = new URLSearchParams({
        client_id: client.clientId,
        code: callback.code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      });
      if (client.clientSecret) body.set("client_secret", client.clientSecret);
      const response = await this.fetchImpl(client.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal,
      });
      throwIfCathayGmailOtpAborted(signal);
      const tokenResponse = await response.json() as OAuthTokenResponse;
      throwIfCathayGmailOtpAborted(signal);
      if (!response.ok || tokenResponse.error) throw new GmailOtpAuthorizationError("token-exchange-failed");
      let token: ReturnType<typeof parseTokenResponse>;
      try {
        token = parseTokenResponse(tokenResponse);
      } catch {
        throw new GmailOtpAuthorizationError("token-exchange-failed");
      }
      if (!token.refreshToken) throw new GmailOtpAuthorizationError("token-exchange-failed");
      let profile: { emailAddress: string };
      try {
        profile = await awaitCathayGmailOtpOperation(this.api.profile(token.accessToken, signal), signal);
      } catch {
        throwIfCathayGmailOtpAborted(signal);
        throw new GmailOtpAuthorizationError("gmail-profile-failed");
      }
      throwIfCathayGmailOtpAborted(signal);
      if (!nonEmpty(profile.emailAddress)) throw new GmailOtpAuthorizationError("gmail-profile-failed");
      return {
        refreshToken: token.refreshToken,
        connectedEmail: profile.emailAddress,
        accessToken: token.accessToken,
        accessTokenExpiresAt: this.now() + Math.max(60, typeof tokenResponse.expires_in === "number" ? tokenResponse.expires_in : 3600) * 1000,
      };
    } finally {
      if (authorizationTimeout) clearTimeout(authorizationTimeout);
      (callbackServer as ReturnType<typeof createServer> | null)?.close();
      callbackServer = null;
    }
  }

  private async refreshAccessToken(refreshToken: string, signal?: AbortSignal) {
    throwIfCathayGmailOtpAborted(signal);
    const client = this.clientConfig();
    const body = new URLSearchParams({
      client_id: client.clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    if (client.clientSecret) body.set("client_secret", client.clientSecret);
    const response = await awaitCathayGmailOtpOperation(this.fetchImpl(client.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal,
    }), signal);
    throwIfCathayGmailOtpAborted(signal);
    const value = await awaitCathayGmailOtpOperation(response.json() as Promise<OAuthTokenResponse>, signal);
    throwIfCathayGmailOtpAborted(signal);
    if (!response.ok || value.error) {
      if (value.error === "invalid_grant") throw new GmailOtpAuthorizationError("token-invalid");
      throw new Error("Google token refresh failed.");
    }
    const token = parseTokenResponse(value);
    if (token.refreshToken) requireCredentialCodec(this.credentialCodec);
    if (token.refreshToken) {
      throwIfCathayGmailOtpAborted(signal);
      const credentials = this.credentials();
      throwIfCathayGmailOtpAborted(signal);
      writeAutomationCredentialsFile(this.credentialsPath, {
        ...credentials,
        [CATHAY_GMAIL_REFRESH_TOKEN_KEY]: token.refreshToken,
      }, this.credentialCodec);
    }
    throwIfCathayGmailOtpAborted(signal);
    this.accessToken = token.accessToken;
    this.accessTokenExpiresAt = this.now() + Math.max(60, typeof value.expires_in === "number" ? value.expires_in : 3600) * 1000;
  }

  async ensureAccess(signal?: AbortSignal): Promise<CathayGmailOtpAccessResult> {
    if (signal?.aborted) return { status: "fallback", reason: "gmail-request-failed" };
    if (!this.credentialCodec) return { status: "fallback", reason: "not-configured" };
    const credentials = this.credentials();
    const refreshToken = credentials[CATHAY_GMAIL_REFRESH_TOKEN_KEY]?.trim();
    if (!refreshToken && !(this.accessToken && this.accessTokenExpiresAt - this.now() > ACCESS_TOKEN_SKEW_MS)) {
      return { status: "fallback", reason: "needs-authorization" };
    }
    try {
      if (this.accessToken && this.accessTokenExpiresAt - this.now() > ACCESS_TOKEN_SKEW_MS)
        return { status: "ready" };
      await this.refreshAccessToken(refreshToken!, signal);
      throwIfCathayGmailOtpAborted(signal);
      return { status: "ready" };
    } catch (error) {
      if (signal?.aborted) return { status: "fallback", reason: "gmail-request-failed" };
      return {
        status: "fallback",
        reason: error instanceof GmailOtpAuthorizationError && error.reason === "token-invalid"
          ? "needs-authorization"
          : /configuration|configured/i.test(error instanceof Error ? error.message : "")
            ? "not-configured"
            : "authorization-failed",
      };
    }
  }

  async prepareRetrieval(signal?: AbortSignal): Promise<CathayGmailOtpBoundaryResult> {
    if (signal?.aborted) return { status: "fallback", reason: "gmail-request-failed" };
    const access = await this.ensureAccess(signal);
    if (signal?.aborted) return { status: "fallback", reason: "gmail-request-failed" };
    if (access.status !== "ready") return access;
    if (!this.accessToken) return { status: "fallback", reason: "token-invalid" };
    const createdAtMs = this.now();
    const searchAfterMs = Math.max(0, createdAtMs - CATHAY_GMAIL_BOUNDARY_LOOKBACK_MS);
    let listing: { messages: { id: string }[]; nextPageToken?: string };
    try {
      listing = await awaitCathayGmailOtpOperation(
        this.api.listMessages(this.accessToken, searchAfterMs, signal),
        signal,
      );
    } catch {
      if (signal?.aborted) return { status: "fallback", reason: "gmail-request-failed" };
      return { status: "fallback", reason: "gmail-request-failed" };
    }
    if (signal?.aborted) return { status: "fallback", reason: "gmail-request-failed" };
    if (listing.nextPageToken)
      return { status: "fallback", reason: "ambiguous-candidate" };
    for (const [id, boundary] of this.retrievalBoundaries) {
      if (createdAtMs - boundary.createdAtMs > CATHAY_GMAIL_BOUNDARY_TTL_MS)
        this.retrievalBoundaries.delete(id);
    }
    const boundaryId = randomUUID();
    this.retrievalBoundaries.set(boundaryId, {
      createdAtMs,
      searchAfterMs,
      knownMessageIds: new Set(listing.messages.map((message) => message.id)),
    });
    return { status: "prepared", boundaryId };
  }

  async retrieve(boundaryId: string, signal?: AbortSignal): Promise<CathayGmailOtpResult> {
    const boundary = this.retrievalBoundaries.get(boundaryId);
    if (!boundary) return { status: "fallback", reason: "protocol-error" };
    this.retrievalBoundaries.delete(boundaryId);
    throwIfCathayGmailOtpAborted(signal);
    const access = await this.ensureAccess(signal);
    throwIfCathayGmailOtpAborted(signal);
    if (access.status !== "ready") return access;
    if (!this.accessToken) return { status: "fallback", reason: "token-invalid" };
    return await pollCathayGmailOtp({
      requestedAfterMs: boundary.createdAtMs,
      knownMessageIds: boundary.knownMessageIds,
      listMessages: (pollSignal) => this.api.listMessages(this.accessToken!, boundary.searchAfterMs, pollSignal),
      getMessage: (id, pollSignal) => this.api.getMessage(this.accessToken!, id, pollSignal),
      now: this.now,
      sleep: this.sleep,
      signal,
    });
  }

  async enable(): Promise<CathayGmailOtpStatus> {
    try {
      requireCredentialCodec(this.credentialCodec);
      const credentials = this.credentials();
      const refreshToken = credentials[CATHAY_GMAIL_REFRESH_TOKEN_KEY]?.trim();
      if (refreshToken) {
        try {
          await this.refreshAccessToken(refreshToken);
        } catch (error) {
          if (!(error instanceof GmailOtpAuthorizationError) || error.reason !== "token-invalid") throw error;
          const authorized = await this.authorization();
          this.saveAuthorization(authorized);
          if (authorized.accessToken) {
            this.accessToken = authorized.accessToken;
            this.accessTokenExpiresAt = authorized.accessTokenExpiresAt ?? 0;
          }
        }
      } else {
        const authorized = await this.authorization();
        this.saveAuthorization(authorized);
        if (authorized.accessToken) {
          this.accessToken = authorized.accessToken;
          this.accessTokenExpiresAt = authorized.accessTokenExpiresAt ?? 0;
        }
      }
    } catch (error) {
      return {
        ...this.status(),
        connectionError: connectionErrorFor(error),
      };
    }
    return this.status();
  }

  async setEnabled(enabled: boolean): Promise<CathayGmailOtpStatus> {
    if (enabled) return await this.enable();
    throw new Error("Automatic Cathay Gmail OTP cannot be disabled. Disconnect Gmail to revoke access.");
  }

  async disconnect(): Promise<CathayGmailOtpStatus> {
    const credentials = this.credentials();
    const refreshToken = credentials[CATHAY_GMAIL_REFRESH_TOKEN_KEY]?.trim();
    if (refreshToken) {
      try {
        await this.fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }),
        });
      } catch {
        // Local deletion remains authoritative even when revoke is offline.
      }
    }
    const next = { ...credentials };
    delete next[CATHAY_GMAIL_REFRESH_TOKEN_KEY];
    delete next[CATHAY_GMAIL_CONNECTED_EMAIL_KEY];
    writeAutomationCredentialsFile(this.credentialsPath, next, this.credentialCodec);
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    return this.status();
  }
}

type GmailOtpAuthorizationErrorReason = CathayGmailOtpConnectionError | "token-invalid";

class GmailOtpAuthorizationError extends Error {
  readonly reason: GmailOtpAuthorizationErrorReason;

  constructor(reason: GmailOtpAuthorizationErrorReason) {
    super(reason);
    this.reason = reason;
  }
}

function connectionErrorFor(error: unknown): CathayGmailOtpConnectionError {
  if (error instanceof GmailOtpAuthorizationError && error.reason !== "token-invalid") {
    return error.reason;
  }
  return "authorization-failed";
}

let configuredService: CathayGmailOtpService | null = null;

export function createCathayGmailOtpService(options: GmailOtpServiceOptions = {}) {
  return new CathayGmailOtpService(options);
}

export function configureCathayGmailOtpService(options: GmailOtpServiceOptions = {}) {
  configuredService = new CathayGmailOtpService(options);
  return configuredService;
}

function service() {
  return configuredService ?? (configuredService = new CathayGmailOtpService());
}

export function cathayGmailOtpStatus() {
  return service().status();
}

export function enableCathayGmailOtp() {
  return service().enable();
}

export function setCathayGmailOtpEnabled(enabled: boolean) {
  return service().setEnabled(enabled);
}

export function disconnectCathayGmailOtp() {
  return service().disconnect();
}

export async function ensureCathayGmailOtpAccess(signal?: AbortSignal): Promise<CathayGmailOtpAccessResult> {
  return await service().ensureAccess(signal);
}

export async function prepareCathayGmailOtpRetrieval(signal?: AbortSignal): Promise<CathayGmailOtpBoundaryResult> {
  return await service().prepareRetrieval(signal);
}

export async function retrieveCathayGmailOtp(boundaryId: string, signal?: AbortSignal): Promise<CathayGmailOtpResult> {
  return await service().retrieve(boundaryId, signal);
}

export function resetCathayGmailOtpServiceForTests() {
  configuredService = null;
  globalAuthorizationFlight?.controller.abort();
  globalAuthorizationFlight = null;
}
