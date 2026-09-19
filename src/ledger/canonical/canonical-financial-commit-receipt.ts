import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The child-process environment variable carrying the per-child receipt key.
 * The key is supplied by the automation parent and is never part of a frame.
 */
export const CANONICAL_FINANCIAL_COMMIT_RECEIPT_TOKEN_ENV =
  "OCTOPUSBEAK_CANONICAL_FINANCIAL_COMMIT_RECEIPT_TOKEN" as const;

/** Reserved stdout prefix. Every frame is authenticated with the child key. */
export const CANONICAL_FINANCIAL_COMMIT_RECEIPT_PREFIX =
  "octopusbeak-canonical-financial-commit-receipt:v1:" as const;

const RECEIPT_VERSION = 1 as const;
const MAX_FRAME_LENGTH = 2_048;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/u;
const SECRET_OR_PHYSICAL =
  /account|credential|cookie|header|password|payload|path|record|secret|sql|token|trace|uuid/i;

/** Operational identity and the monotonic Canonical Knowledge Point only. */
export type CanonicalFinancialCommitReceipt = Readonly<{
  provider: string;
  product: string;
  itemKey: string;
  commitSequence: number;
}>;

export type CanonicalFinancialCommitReceiptPublisher = (
  receipt: CanonicalFinancialCommitReceipt,
) => void | Promise<void>;

function hashIdentity(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function safeIdentity(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (SAFE_IDENTITY.test(text) && !SECRET_OR_PHYSICAL.test(text)) return text;
  return text ? hashIdentity(text) : fallback;
}

function safeLabel(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return SAFE_IDENTITY.test(text) && !SECRET_OR_PHYSICAL.test(text)
    ? text
    : fallback;
}

function requireToken(token: string): string {
  if (typeof token !== "string" || token.length === 0 || token.length > 256)
    throw new Error("Canonical financial commit receipt token is invalid.");
  return token;
}

/** Sanitize the receipt at the domain boundary before it can enter transport. */
export function createCanonicalFinancialCommitReceipt(input: {
  provider: unknown;
  product: unknown;
  itemKey: unknown;
  commitSequence: unknown;
}): CanonicalFinancialCommitReceipt {
  const commitSequence = Number(input.commitSequence);
  if (!Number.isSafeInteger(commitSequence) || commitSequence <= 0)
    throw new Error("Canonical financial commit receipt sequence is invalid.");
  return Object.freeze({
    provider: safeLabel(input.provider, "unknown-provider"),
    product: safeLabel(input.product, "unknown-product"),
    itemKey: safeIdentity(input.itemKey, "unknown-item"),
    commitSequence,
  });
}

function payloadFor(receipt: CanonicalFinancialCommitReceipt): string {
  return JSON.stringify({
    v: RECEIPT_VERSION,
    provider: receipt.provider,
    product: receipt.product,
    itemKey: receipt.itemKey,
    commitSequence: receipt.commitSequence,
  });
}

function signatureFor(payload: string, token: string): string {
  return createHmac("sha256", requireToken(token))
    .update(payload)
    .digest("base64url");
}

/** Encode one authenticated line for a spawned workflow's stdout. */
export function encodeCanonicalFinancialCommitReceipt(
  receipt: CanonicalFinancialCommitReceipt,
  token: string,
): string {
  const normalized = createCanonicalFinancialCommitReceipt(receipt);
  const payload = Buffer.from(payloadFor(normalized), "utf8").toString("base64url");
  return `${CANONICAL_FINANCIAL_COMMIT_RECEIPT_PREFIX}${payload}.${signatureFor(payload, token)}\n`;
}

function decodePayload(encoded: string): CanonicalFinancialCommitReceipt | null {
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.length === 0 || decoded.toString("base64url") !== encoded) return null;
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 5 ||
      record.v !== RECEIPT_VERSION ||
      typeof record.provider !== "string" ||
      typeof record.product !== "string" ||
      typeof record.itemKey !== "string"
    )
      return null;
    return createCanonicalFinancialCommitReceipt({
      provider: record.provider,
      product: record.product,
      itemKey: record.itemKey,
      commitSequence: record.commitSequence,
    });
  } catch {
    return null;
  }
}

/** Parse and authenticate exactly one stdout line; untrusted lines return null. */
export function parseCanonicalFinancialCommitReceiptLine(
  line: string,
  token: string,
): CanonicalFinancialCommitReceipt | null {
  if (
    typeof line !== "string" ||
    line.length > MAX_FRAME_LENGTH ||
    !line.startsWith(CANONICAL_FINANCIAL_COMMIT_RECEIPT_PREFIX)
  )
    return null;
  const body = line
    .slice(CANONICAL_FINANCIAL_COMMIT_RECEIPT_PREFIX.length)
    .replace(/\r?\n$/u, "");
  const separator = body.lastIndexOf(".");
  if (separator <= 0 || separator === body.length - 1) return null;
  const payload = body.slice(0, separator);
  const signature = body.slice(separator + 1);
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(signatureFor(payload, token), "base64url");
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return decodePayload(payload);
}

/**
 * Parse a child stdout stream. Frames are authenticated, exact duplicates are
 * ignored, and a lower sequence cannot move the parent back to stale state.
 */
export function createCanonicalFinancialCommitReceiptFrameParser(options: {
  token: string;
  onReceipt: (receipt: CanonicalFinancialCommitReceipt) => void;
}) {
  const seen = new Set<string>();
  let highestCommitSequence = 0;
  let pending = "";

  const consume = (line: string) => {
    const receipt = parseCanonicalFinancialCommitReceiptLine(line, options.token);
    if (!receipt || receipt.commitSequence < highestCommitSequence) return;
    const key = `${receipt.provider}\u0000${receipt.product}\u0000${receipt.itemKey}\u0000${receipt.commitSequence}`;
    if (seen.has(key)) return;
    seen.add(key);
    highestCommitSequence = Math.max(highestCommitSequence, receipt.commitSequence);
    options.onReceipt(receipt);
  };

  const drain = (flush: boolean) => {
    const lines = pending.split("\n");
    const completeLines = flush ? lines : lines.slice(0, -1);
    pending = flush ? "" : (lines.at(-1) ?? "");
    for (const line of completeLines) if (line) consume(line);
  };

  return Object.freeze({
    push(chunk: string) {
      if (typeof chunk !== "string" || chunk.length === 0) return;
      pending += chunk;
      // A malicious workflow must not grow the parser buffer without bound.
      if (pending.length > MAX_FRAME_LENGTH * 2) pending = pending.slice(-MAX_FRAME_LENGTH * 2);
      drain(false);
    },
    flush() {
      if (pending) consume(pending);
      pending = "";
    },
  });
}

/** Return the process-local publisher when automation supplied a receipt key. */
export function createEnvironmentCanonicalFinancialCommitReceiptPublisher():
  | CanonicalFinancialCommitReceiptPublisher
  | undefined {
  const token = process.env[CANONICAL_FINANCIAL_COMMIT_RECEIPT_TOKEN_ENV];
  if (!token) return undefined;
  return (receipt) => {
    process.stdout.write(encodeCanonicalFinancialCommitReceipt(receipt, token));
  };
}
