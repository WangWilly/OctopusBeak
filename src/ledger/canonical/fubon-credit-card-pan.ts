import { createHmac } from "node:crypto";

/**
 * The PAN is deliberately not a member of any canonical capture type.  This
 * module accepts it only at the identity boundary and returns opaque metadata
 * that is safe to retain in a capture or database row.
 */
export const FUBON_CREDIT_CARD_PAN_FINGERPRINT_CONTRACT = Object.freeze({
  algorithm: "hmac-sha256",
  version: "fubon-credit-card-pan-hmac-v1",
  keyVersion: "v1",
} as const);

export type FubonCreditCardPanFingerprintKey = {
  readonly secret: string | Uint8Array;
  readonly keyVersion?: string;
};

export type FubonCreditCardPanIdentityMetadata = {
  readonly fingerprint: `sha256:${string}`;
  readonly last4: `${number}${number}${number}${number}`;
  readonly keyVersion: string;
};

function validKeyVersion(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.trim()))
    throw new Error("Fubon PAN fingerprint key version is invalid.");
  return value.trim();
}

function keyBytes(key: FubonCreditCardPanFingerprintKey): string | Uint8Array {
  if (
    typeof key !== "object" ||
    key === null ||
    (typeof key.secret !== "string" && !(key.secret instanceof Uint8Array)) ||
    (typeof key.secret === "string" && key.secret.trim().length === 0) ||
    (key.secret instanceof Uint8Array && key.secret.byteLength === 0)
  )
    throw new Error("Fubon PAN fingerprint key is unavailable.");
  return key.secret;
}

/** Normalize separators without ever including the PAN in an error message. */
export function normalizeFubonCreditCardPan(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Fubon card number is invalid.");
  const normalized = value.replace(/[\s-]/gu, "");
  if (!/^\d{12,19}$/u.test(normalized) || !passesLuhn(normalized))
    throw new Error("Fubon card number is invalid.");
  return normalized;
}

function passesLuhn(value: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

export function fubonCreditCardPanFingerprint(
  value: unknown,
  key: FubonCreditCardPanFingerprintKey,
): FubonCreditCardPanIdentityMetadata {
  const pan = normalizeFubonCreditCardPan(value);
  const secret = keyBytes(key);
  const keyVersion = validKeyVersion(
    key.keyVersion ?? FUBON_CREDIT_CARD_PAN_FINGERPRINT_CONTRACT.keyVersion,
  );
  const digest = createHmac("sha256", secret)
    .update(
      JSON.stringify([
        FUBON_CREDIT_CARD_PAN_FINGERPRINT_CONTRACT.version,
        keyVersion,
        pan,
      ]),
    )
    .digest("base64url");
  return {
    fingerprint: `sha256:${digest}`,
    last4: pan.slice(-4) as `${number}${number}${number}${number}`,
    keyVersion,
  };
}

/** Return a display-safe last-four value, without exposing an invalid input. */
export function fubonCreditCardPanLast4(value: unknown): `${number}${number}${number}${number}` {
  return normalizeFubonCreditCardPan(value).slice(-4) as
    `${number}${number}${number}${number}`;
}
