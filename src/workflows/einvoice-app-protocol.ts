import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

// The E-Invoice mobile App's v2 HTTP protocol, reimplemented from the
// TedLin1993/all-set-tw reference project (MIT, commit a5c56e9,
// apps/worker/src/sources/einvoice/v2-client.ts). This module holds only the
// protocol primitives (crypto + session parsing); it makes no network calls
// and never sees credentials or tokens.

export const EINVOICE_APP_MIDDLE_HOST = "https://uia.einvoice.nat.gov.tw";
export const EINVOICE_APP_BIG_HOST = "https://upi.einvoice.nat.gov.tw";
export const EINVOICE_APP_VERSION = "6.800.2";
export const EINVOICE_APP_BUILD = 66;

const ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export type EInvoiceAppSession = {
  sid: string;
  token: string;
  skey?: string;
  iv?: string;
  svrCode?: string;
  clientCode?: string;
  appid: string;
  liat: number;
  ssme: string;
  ltoken?: string;
  carrierCode?: string;
  now?: number;
};

type LDataCryptoContext = { key: Uint8Array; iv: Uint8Array };

function sha256(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value, "utf8").digest());
}

function swapPairs(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 2) {
    output += value[index + 1] ?? "";
    output += value[index] ?? "";
  }
  return output;
}

function randomAlphanumeric(length: number): string {
  const random = randomBytes(length);
  return Array.from(random, (value) => ALPHANUMERIC[value % ALPHANUMERIC.length]).join("");
}

/** A per-login client code, as the App generates on each fresh sign-in. */
export function randomClientCode(): string {
  return randomAlphanumeric(8);
}

function aesGcmEncrypt(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([encrypted, tag]);
}

function aesGcmDecrypt(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  if (ciphertext.length < 16) throw new Error("電子發票登入回應的密文太短。");
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
}

function ldataContext(a: string, b: string): LDataCryptoContext {
  const reversed = (value: string): string => [...value].reverse().join("");
  const seed = `${swapPairs(b)}${swapPairs(a)}${reversed(a)}${reversed(b)}`;
  return {
    key: sha256(seed),
    iv: new TextEncoder().encode(`${a.slice(-6)}${b.slice(-6)}`),
  };
}

/** AppCrypto.lDataEncrypt: random 16+16 seed, SHA-256 key, AES-GCM payload. */
export function encryptLoginData(
  data: Record<string, unknown>,
): { ldata: string; context: LDataCryptoContext } {
  const a = randomAlphanumeric(16);
  const b = randomAlphanumeric(16);
  const context = ldataContext(a, b);
  const ciphertext = aesGcmEncrypt(
    new TextEncoder().encode(JSON.stringify(data)),
    context.key,
    context.iv,
  );
  return {
    ldata: `${a}|${Buffer.from(ciphertext).toString("base64")}|${b}`,
    context,
  };
}

/** Decrypts the ldata response returned in the middle API payload. */
export function decryptLoginData(value: string): Record<string, unknown> {
  const parts = value.split("|");
  if (parts.length !== 3 || parts[0].length !== 16 || parts[2].length !== 16) {
    throw new Error("新版電子發票登入回應的 ldata 格式無效。");
  }
  const [a, encoded, b] = parts;
  const context = ldataContext(a!, b!);
  const plaintext = aesGcmDecrypt(
    new Uint8Array(Buffer.from(encoded!, "base64")),
    context.key,
    context.iv,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseLoginSession(data: unknown): EInvoiceAppSession {
  const value = recordValue(data) ?? {};
  const session: EInvoiceAppSession = {
    sid: stringValue(value.sid),
    token: stringValue(value.token),
    skey: stringValue(value.skey) || undefined,
    iv: stringValue(value.iv) || undefined,
    svrCode: stringValue(value.svrCode ?? value.svr_code) || undefined,
    clientCode: stringValue(value.clientCode) || undefined,
    appid: stringValue(value.appid ?? value.loginAppId),
    liat: Number(value.liat ?? value.loginLiat ?? 0),
    ssme: stringValue(value.ssme ?? value.loginSsMe),
    ltoken: stringValue(value.ltoken) || undefined,
    carrierCode: stringValue(value.carrier_code ?? value.carrierCode) || undefined,
    ...(Number.isFinite(Number(value.now)) ? { now: Number(value.now) } : {}),
  };
  if (!session.sid || !session.token || !session.appid || !session.ssme || !Number.isFinite(session.liat)) {
    throw new Error(
      `新版電子發票登入成功回應缺少必要 session 欄位（回應欄位：${Object.keys(value).join(",") || "無"}）。`,
    );
  }
  return session;
}

export type EInvoiceJwtSession = Pick<
  EInvoiceAppSession,
  "appid" | "liat" | "ssme" | "carrierCode"
>;

/** Signs an invoice query request as an HS256 JWT over the comms claim. */
export function signInvoiceJwt(
  request: Record<string, unknown>,
  session: EInvoiceJwtSession,
  now: number,
): string {
  const header = base64url(
    new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT", ver: "1.0" })),
  );
  const claims = base64url(
    new TextEncoder().encode(JSON.stringify({
      comms: {
        iat: now,
        exp: now + 40,
        liat: session.liat,
        appid: session.appid,
        barcode: session.carrierCode ?? "",
        keyType: "2",
      },
      reqdata: request,
    })),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createHmac("sha256", Buffer.from(session.ssme, "utf8"))
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

/** Server-time offset, in seconds, from a login `now` value. */
export function serverTimeOffset(session: EInvoiceAppSession, nowMs: number = Date.now()): number {
  if (session.now === undefined || !Number.isFinite(session.now)) return 0;
  return Math.trunc(session.now - nowMs / 1000);
}
