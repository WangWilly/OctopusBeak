import { createCipheriv, createHash, randomBytes } from "node:crypto";

// Reproduces the TDCC e-Passbook Android App's request envelope, ported from
// the TedLin1993/all-set-tw reference client. See the TDCC App protocol ADR
// (docs/adr/, tdcc-epassbook-app-protocol-source).
export const TDCC_BASE_URL = "https://epassbooksys.tdcc.com.tw/MPSBKV2/rest/";
export const TDCC_APP_INFO = "tw.com.tdcc.epassbook:3.3.8";
export const TDCC_API_VER = "20250220";
const USER_AGENT = "okhttp/4.9.3";
const ASSET_TREND_REFERER = "https://digitalprocesssys-epassbook.cdn.hinet.net/";
const DEFAULT_LAST_UPDATE = "19000101000000";
const BANK_TRANSACTION_PAGE_SIZE = 100;
export const TDCC_MAX_PAGES = 1_000;
// The reference App uses the ASCII text "0000000000000000" as IV, not zero bytes.
const AES_IV = Buffer.from("0000000000000000", "utf8");
const SUCCESS_CODE = "0000";
const TRADE_DETAILS_END_CODE = "D0002";

export type TdccDeviceIdentity = Readonly<{
  deviceId: string;
  devType: string;
  devModel: string;
}>;

export type TdccSession = Readonly<{
  tokenId: string | null;
  richUrl: string | null;
}>;

export type TdccOtpChannel = "email" | "sms";

export type TdccLoginOutcome =
  | { kind: "trusted" }
  | { kind: "device-verification-required" };

export type TdccOtpVerifyOutcome =
  | { kind: "registered" }
  | { kind: "sms-verification-required" };

export type TdccSignInDetails = Readonly<{ userId: string; password: string }>;

export type TdccBankAccountRef = Readonly<{ bankId: string; accountNo: string; currency: string }>;
export type TdccBrokerAccountRef = Readonly<{ brokerNo: string; brokerAccount: string }>;

export type TdccFailure =
  | { reason: "device-untrusted"; code: string | null }
  | { reason: "otp-expired"; code: string }
  | { reason: "session-expired"; code: string }
  | { reason: "protocol-outdated"; code: string }
  | { reason: "rejected"; code: string }
  | { reason: "http"; status: number }
  | { reason: "malformed-response" }
  | { reason: "pagination"; detail: "page-limit" | "repeated-cursor" | "incomplete" };

export class TdccError extends Error {
  readonly failure: TdccFailure;
  readonly endpoint: TdccEndpointName;
  /** TDCC's own return message. It may name the person, so callers decide where it goes. */
  readonly providerMessage: string | undefined;

  constructor(endpoint: TdccEndpointName, failure: TdccFailure, providerMessage?: string) {
    super(`TDCC ${endpoint} failed: ${describeFailure(failure)}`);
    this.name = "TdccError";
    this.endpoint = endpoint;
    this.failure = failure;
    this.providerMessage = providerMessage;
  }
}

function describeFailure(failure: TdccFailure) {
  if (failure.reason === "http") return `http ${failure.status}`;
  if (failure.reason === "pagination") return `pagination ${failure.detail}`;
  if ("code" in failure && failure.code) return `${failure.reason} (${failure.code})`;
  return failure.reason;
}

type TdccEndpointSpec = Readonly<{
  path: string;
  encryptedFields: readonly string[];
  /** Non-success codes that carry a meaningful body instead of failing. */
  passCodes: readonly string[];
  /** Codes that mean "this device is not trusted"; TDCC only signals this at sign-in. */
  deviceUntrustedCodes: readonly string[];
}>;

const endpoint = (
  path: string,
  options: Partial<Omit<TdccEndpointSpec, "path">> = {},
): TdccEndpointSpec => ({
  path,
  encryptedFields: options.encryptedFields ?? [],
  passCodes: options.passCodes ?? [],
  deviceUntrustedCodes: options.deviceUntrustedCodes ?? [],
});

export const TDCC_ENDPOINTS = {
  initialToken: endpoint("CM001"),
  login: endpoint("AU001", {
    encryptedFields: ["userID", "loginCode"],
    deviceUntrustedCodes: ["C9999", "D0005"],
  }),
  requestEmailOtp: endpoint("AU013", { encryptedFields: ["userID"] }),
  requestMobileOtp: endpoint("AU014", { encryptedFields: ["userID"] }),
  verifyOtp: endpoint("AU015", { encryptedFields: ["userID", "otp"] }),
  positions: endpoint("TR001"),
  fundPositions: endpoint("TR051V1"),
  bankBalances: endpoint("tsp/TSP006"),
  bankTransactions: endpoint("tsp/TSP007"),
  tradeDetails: endpoint("TR002", { passCodes: [TRADE_DETAILS_END_CODE] }),
} as const satisfies Record<string, TdccEndpointSpec>;

export type TdccEndpointName = keyof typeof TDCC_ENDPOINTS | "assetTrend";

const OTP_EXPIRED_CODES = new Set(["V0017"]);
// A stored tokenID can die between runs; these mean "sign in again", not "wrong credentials".
const SESSION_EXPIRED_CODES = new Set(["D0006", "D0007", "A0001", "A0002", "T8000", "D9993", "D9998"]);
// No observed TDCC code identifies a stale App version yet; the return message is the only signal.
const PROTOCOL_OUTDATED_MESSAGE = /版本|version/iu;

export function classifyTdccReturnCode(
  name: TdccEndpointName,
  code: string,
  message: string | undefined,
): TdccFailure {
  const spec = name === "assetTrend" ? undefined : TDCC_ENDPOINTS[name];
  if (spec?.deviceUntrustedCodes.includes(code)) return { reason: "device-untrusted", code };
  if (OTP_EXPIRED_CODES.has(code)) return { reason: "otp-expired", code };
  if (SESSION_EXPIRED_CODES.has(code)) return { reason: "session-expired", code };
  if (message && PROTOCOL_OUTDATED_MESSAGE.test(message)) return { reason: "protocol-outdated", code };
  return { reason: "rejected", code };
}

export function createTdccDeviceIdentity(): TdccDeviceIdentity {
  return {
    deviceId: randomBytes(8).toString("hex"),
    devType: "Android:14",
    devModel: "SM-G991B",
  };
}

export function tdccTimestamp(date: Date) {
  const pad = (value: number, width = 2) => value.toString().padStart(width, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${pad(date.getUTCMilliseconds(), 3)}Z`;
}

/** Interleaves the base64 of timestamp + appInfo + devType from both ends, as the App does. */
export function deriveTdccEncryptionKey(timestamp: string, devType: string) {
  const chars = Buffer.from(timestamp + TDCC_APP_INFO + devType, "latin1").toString("base64").split("");
  const out: string[] = [];
  for (let index = 0; index < chars.length && out.length < 32; index += 1) {
    const source = index % 2 === 0
      ? index - Math.floor(index / 2)
      : chars.length - 1 - Math.floor(index / 2);
    out.push(chars[source] ?? "");
  }
  return out.join("");
}

export function encryptTdccField(key: string, plaintext: string) {
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(key, "utf8"), AES_IV);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

function sha256Base64(text: string) {
  return createHash("sha256").update(text, "utf8").digest("base64");
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type TdccClientOptions = Readonly<{
  identity: TdccDeviceIdentity;
  session?: TdccSession;
  fetch?: FetchLike;
  signal?: AbortSignal;
  now?: () => Date;
}>;

type TdccEnvelope = Readonly<{
  code: string;
  message: string | undefined;
  body: Record<string, unknown>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeCount(value: unknown) {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return undefined;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : undefined;
}

export class TdccClient {
  readonly #identity: TdccDeviceIdentity;
  readonly #fetch: FetchLike;
  readonly #signal: AbortSignal | undefined;
  readonly #now: () => Date;
  #tokenId: string | null;
  #richUrl: string | null;

  constructor(options: TdccClientOptions) {
    this.#identity = options.identity;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#signal = options.signal;
    this.#now = options.now ?? (() => new Date());
    this.#tokenId = options.session?.tokenId ?? null;
    this.#richUrl = options.session?.richUrl ?? null;
  }

  exportSession(): TdccSession {
    return { tokenId: this.#tokenId, richUrl: this.#richUrl };
  }

  async #post(name: keyof typeof TDCC_ENDPOINTS, body: Record<string, string | number>): Promise<TdccEnvelope> {
    const spec: TdccEndpointSpec = TDCC_ENDPOINTS[name];
    const timestamp = tdccTimestamp(this.#now());
    const requestBody: Record<string, string | number> = { ...body };
    if (spec.encryptedFields.length > 0) {
      const key = deriveTdccEncryptionKey(timestamp, this.#identity.devType);
      for (const field of spec.encryptedFields) {
        const value = requestBody[field];
        if (typeof value === "string") requestBody[field] = encryptTdccField(key, value);
      }
    }
    const hasBody = Object.keys(requestBody).length > 0;
    const requestHeader = {
      appInfo: TDCC_APP_INFO,
      devID: this.#identity.deviceId,
      devType: this.#identity.devType,
      sequence: Buffer.from(timestamp, "latin1").toString("base64"),
      signature: sha256Base64(hasBody ? JSON.stringify(requestBody) : timestamp),
      tokenID: this.#tokenId,
    };

    const response = await this.#fetch(`${TDCC_BASE_URL}${spec.path}`, {
      method: "POST",
      signal: this.#signal,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": USER_AGENT,
        Connection: "Keep-Alive",
        "Accept-Encoding": "gzip",
      },
      body: JSON.stringify({ requestHeader, requestBody }),
    });
    if (!response.ok) throw new TdccError(name, { reason: "http", status: response.status });

    const envelope = await parseJson(name, response);
    const header = isRecord(envelope.responseHeader) ? envelope.responseHeader : {};
    const rotatedToken = optionalString(header.tokenID);
    if (rotatedToken) this.#tokenId = rotatedToken;
    const code = optionalString(header.returnCode) ?? SUCCESS_CODE;
    const message = optionalString(header.returnMsg);
    if (code !== SUCCESS_CODE && !spec.passCodes.includes(code)) {
      throw new TdccError(name, classifyTdccReturnCode(name, code, message), message);
    }
    return {
      code,
      message,
      body: isRecord(envelope.responseBody) ? envelope.responseBody : {},
    };
  }

  async getInitialToken(): Promise<void> {
    const { body } = await this.#post("initialToken", {});
    const token = optionalString(body.tokenID);
    if (token) this.#tokenId = token;
  }

  async login(details: TdccSignInDetails): Promise<TdccLoginOutcome> {
    let body: Record<string, unknown>;
    try {
      ({ body } = await this.#post("login", {
        apiVer: TDCC_API_VER,
        devModel: this.#identity.devModel,
        loginCode: details.password,
        loginType: "M",
        networkType: "WIFI",
        userID: details.userId,
      }));
    } catch (error) {
      if (error instanceof TdccError && error.failure.reason === "device-untrusted") {
        return { kind: "device-verification-required" };
      }
      throw error;
    }
    const richUrl = optionalString(body.richUrl);
    if (richUrl) this.#richUrl = richUrl;
    const token = optionalString(body.tokenID);
    if (token) this.#tokenId = token;
    return body.isDiffDevice === "Y" || body.isEmailValid === "N"
      ? { kind: "device-verification-required" }
      : { kind: "trusted" };
  }

  async requestEmailOtp(userId: string): Promise<void> {
    await this.#post("requestEmailOtp", { apiVer: TDCC_API_VER, applyType: "D", birthday: "", userID: userId });
  }

  async requestMobileOtp(userId: string): Promise<void> {
    await this.#post("requestMobileOtp", { applyType: "D", birthday: "", userID: userId });
  }

  async verifyOtp(userId: string, otp: string, channel: TdccOtpChannel): Promise<TdccOtpVerifyOutcome> {
    const { body } = await this.#post("verifyOtp", {
      applyType: "D",
      birthday: "",
      otp,
      sendType: channel === "sms" ? "MOBILE" : "EMAIL",
      userID: userId,
    });
    return channel === "email" && body.isMobileValid === "N"
      ? { kind: "sms-verification-required" }
      : { kind: "registered" };
  }

  async positions(): Promise<unknown> {
    return (await this.#post("positions", { lastUpdateTime: DEFAULT_LAST_UPDATE })).body;
  }

  async fundPositions(): Promise<unknown> {
    return (await this.#post("fundPositions", { lastUpdateTime: DEFAULT_LAST_UPDATE })).body;
  }

  async bankBalances(): Promise<unknown> {
    return (await this.#post("bankBalances", {})).body;
  }

  /** Every TSP007 page body for one settlement account, in request order. */
  async bankTransactions(account: TdccBankAccountRef): Promise<unknown[]> {
    const pages: unknown[] = [];
    const seenTokens = new Set<string>();
    let pageToken = "";
    let collected = 0;
    for (;;) {
      if (pages.length >= TDCC_MAX_PAGES) {
        throw new TdccError("bankTransactions", { reason: "pagination", detail: "page-limit" });
      }
      seenTokens.add(pageToken);
      const { body } = await this.#post("bankTransactions", {
        bankId: account.bankId,
        accountNo: account.accountNo,
        currency: account.currency,
        limitsInPage: BANK_TRANSACTION_PAGE_SIZE,
        pageToken,
      });
      pages.push(body);
      collected += Array.isArray(body.transactionDetails) ? body.transactionDetails.length : 0;
      const expected = nonNegativeCount(body.totalCount);
      if (expected !== undefined && collected >= expected) return pages;
      const next = optionalString(body.pageToken);
      if (!next) {
        if (expected !== undefined) {
          throw new TdccError("bankTransactions", { reason: "pagination", detail: "incomplete" });
        }
        return pages;
      }
      if (seenTokens.has(next)) {
        throw new TdccError("bankTransactions", { reason: "pagination", detail: "repeated-cursor" });
      }
      pageToken = next;
    }
  }

  /**
   * Every TR002 page body for one broker account, walking backward from the
   * newest trade. The cursor is the last row's postDate and txnSerNo; D0002 ends it.
   */
  async tradeDetails(account: TdccBrokerAccountRef): Promise<unknown[]> {
    const pages: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor = { postDate: "", txnSerNo: "" };
    for (;;) {
      if (pages.length >= TDCC_MAX_PAGES) {
        throw new TdccError("tradeDetails", { reason: "pagination", detail: "page-limit" });
      }
      seenCursors.add(`${cursor.postDate}\u0000${cursor.txnSerNo}`);
      const { code, body } = await this.#post("tradeDetails", {
        brokerNo: account.brokerNo,
        brokerAccount: account.brokerAccount,
        postDate: cursor.postDate,
        txnSerNo: cursor.txnSerNo,
        updateType: "B",
      });
      if (code === TRADE_DETAILS_END_CODE) return pages;
      const rows = Array.isArray(body.items) ? body.items.filter(Array.isArray) : [];
      if (rows.length === 0) return pages;
      pages.push(body);
      const last = rows.at(-1) as unknown[];
      cursor = { postDate: String(last[0] ?? ""), txnSerNo: String(last[1] ?? "") };
      if (seenCursors.has(`${cursor.postDate}\u0000${cursor.txnSerNo}`)) {
        throw new TdccError("tradeDetails", { reason: "pagination", detail: "repeated-cursor" });
      }
    }
  }

  /** TR087 is a GET that reuses the query string of the richUrl handed out at sign-in. */
  async assetTrend(type = "1Y"): Promise<unknown | null> {
    if (!this.#richUrl) return null;
    const query = this.#richUrl.includes("?") ? this.#richUrl.slice(this.#richUrl.indexOf("?")) : "?";
    const response = await this.#fetch(`${TDCC_BASE_URL}TR087${query}&type=${encodeURIComponent(type)}`, {
      method: "GET",
      signal: this.#signal,
      headers: { Referer: ASSET_TREND_REFERER, "User-Agent": USER_AGENT },
    });
    if (!response.ok) throw new TdccError("assetTrend", { reason: "http", status: response.status });
    return await parseJson("assetTrend", response);
  }
}

async function parseJson(name: TdccEndpointName, response: Response): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new TdccError(name, { reason: "malformed-response" });
  }
  if (!isRecord(parsed)) throw new TdccError(name, { reason: "malformed-response" });
  return parsed;
}
