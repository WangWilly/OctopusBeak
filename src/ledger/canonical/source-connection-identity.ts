import { scryptSync, createHash } from "node:crypto";

/**
 * The source connection contract deliberately derives its public key from
 * stable provider-login identity, not from a password, session, device, or
 * product stream.  The KDF makes accidental offline enumeration more
 * expensive while keeping the result reproducible on a clean device.
 */
export const SOURCE_CONNECTION_IDENTITY_CONTRACT_VERSION =
  "source-connection/identity/v1" as const;

/**
 * The separator is part of the portable stable-login scope contract.  Keep it
 * in this module so every provider assembles the same scope without copying
 * delimiter or normalization rules into its workflow.
 */
export const SOURCE_CONNECTION_SCOPE_SEPARATOR = "\u0000" as const;
const SOURCE_CONNECTION_IDENTITY_PART_SEPARATOR = "\u001f" as const;

export type StableSourceLoginScopeField = Readonly<{
  name: string;
  value?: string | null;
}>;

export type StableSourceLoginMissingPolicy = "throw" | "undefined";

export type StableSourceLoginIdentity =
  | string
  | Readonly<Record<string, string | number | boolean>>
  | readonly (string | number | boolean)[];

function normalizePart(value: string | number | boolean): string {
  const normalized = String(value)
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleUpperCase("en-US");
  if (/[\u0000-\u001f\u007f]/u.test(normalized))
    throw new Error("Stable source login identity contains an unsafe control character.");
  return normalized;
}

/**
 * Assemble the ordered, required stable-login fields used by provider
 * workflows. The caller supplies values in the provider's documented order;
 * this helper owns normalization, separator choice, and missing-field policy.
 * No password, OTP, session, solver, or query-range value belongs here.
 */
export function assembleStableSourceLoginScope(
  fields: readonly StableSourceLoginScopeField[],
  missingPolicy: StableSourceLoginMissingPolicy = "throw",
): string | undefined {
  if (fields.length === 0)
    throw new Error("Stable source login identity fields are required.");
  const invalidName = fields.find(
    (field) => typeof field.name !== "string" || field.name.trim() === "",
  );
  if (invalidName)
    throw new Error("Stable source login identity field names are required.");
  const missing = fields.filter(
    (field) => typeof field.value !== "string" || field.value.trim() === "",
  );
  if (missing.length > 0) {
    if (missingPolicy === "undefined") return undefined;
    const names = missing.map((field) => field.name.trim()).join(", ");
    throw new Error(
      `Stable source login identity requires: ${names}.`,
    );
  }
  return fields
    .map((field) => normalizePart(field.value!))
    .join(SOURCE_CONNECTION_SCOPE_SEPARATOR);
}

/** Normalize only provider login identifiers. Secrets must never be passed. */
export function normalizeStableSourceLoginIdentity(
  identity: StableSourceLoginIdentity,
): string {
  if (typeof identity === "string") {
    const parts = identity.split(SOURCE_CONNECTION_SCOPE_SEPARATOR);
    const normalized = parts.map(normalizePart);
    if (parts.length === 1 && normalized[0] === "")
      throw new Error("Stable source login identity is required.");
    if (normalized.some((part) => !part))
      throw new Error("Stable source login identity parts are required.");
    return normalized.join(SOURCE_CONNECTION_SCOPE_SEPARATOR);
  }
  if (Array.isArray(identity)) {
    const normalized = identity.map(normalizePart);
    if (normalized.some((part) => !part))
      throw new Error("Stable source login identity parts are required.");
    return normalized.join(SOURCE_CONNECTION_IDENTITY_PART_SEPARATOR);
  }
  const entries = Object.entries(identity)
    .filter(([key]) => key.trim() !== "")
    // Source Connection keys must be byte-for-byte reproducible across OS
    // locales and machines. Do not use locale-sensitive collation here.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${normalizePart(key)}=${normalizePart(value)}`);
  if (entries.length === 0)
    throw new Error("Stable source login identity is required.");
  return entries.join(SOURCE_CONNECTION_IDENTITY_PART_SEPARATOR);
}

/**
 * Produce the durable source-connection key shared by every product stream
 * under one provider login.  Passwords, OTPs, solver state and sessions are
 * intentionally not accepted by this API.
 */
export function deriveSourceConnectionIdentityKey(
  integrationNamespace: string,
  stableLoginIdentity: StableSourceLoginIdentity,
): `sha256:${string}` {
  const namespace = normalizePart(integrationNamespace);
  if (!namespace) throw new Error("Integration namespace is required.");
  const normalized = normalizeStableSourceLoginIdentity(stableLoginIdentity);
  const salt = Buffer.from(
    `${SOURCE_CONNECTION_IDENTITY_CONTRACT_VERSION}${SOURCE_CONNECTION_SCOPE_SEPARATOR}${namespace}`,
    "utf8",
  );
  const derived = scryptSync(
    Buffer.from(`${namespace}${SOURCE_CONNECTION_SCOPE_SEPARATOR}${normalized}`, "utf8"),
    salt,
    32,
    { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
  );
  // Keep the canonical opaque-token shape used by the existing store while
  // retaining the memory-hard derivation above.
  return `sha256:${createHash("sha256").update(derived).digest("base64url")}`;
}

export type RequiredSourceConnectionIdentity = Readonly<{
  sourceConnectionScope: string;
  sourceConnectionKey: `sha256:${string}`;
}>;

export type SourceConnectionIdentityDefect =
  | "source-connection-scope-invalid"
  | "source-connection-key-invalid"
  | "source-connection-key-mismatch";

export type SourceConnectionIdentityValidation = Readonly<{
  sourceConnectionScope: string | null;
  sourceConnectionKey: `sha256:${string}` | null;
  defects: readonly SourceConnectionIdentityDefect[];
}>;

/** Canonical non-throwing validator used by provider admission adapters. */
export function validateSourceConnectionIdentity(
  integrationNamespace: string,
  input: Readonly<{
    sourceConnectionScope?: string;
    sourceConnectionKey?: string;
  }>,
): SourceConnectionIdentityValidation {
  const defects: SourceConnectionIdentityDefect[] = [];
  const sourceConnectionScope = input.sourceConnectionScope?.trim() || null;
  const suppliedKey = input.sourceConnectionKey?.trim() || null;
  if (!sourceConnectionScope)
    defects.push("source-connection-scope-invalid");
  if (!suppliedKey || !/^sha256:[A-Za-z0-9_-]+$/u.test(suppliedKey))
    defects.push("source-connection-key-invalid");
  let expected: `sha256:${string}` | null = null;
  if (sourceConnectionScope)
    expected = deriveSourceConnectionIdentityKey(
      integrationNamespace,
      sourceConnectionScope,
    );
  if (expected && suppliedKey && /^sha256:[A-Za-z0-9_-]+$/u.test(suppliedKey)) {
    if (suppliedKey !== expected)
      defects.push("source-connection-key-mismatch");
  }
  return {
    sourceConnectionScope,
    sourceConnectionKey: defects.length === 0 ? expected : null,
    defects,
  };
}

/**
 * Validate the portable Source Connection identity at an exported workflow
 * boundary. This deliberately accepts no fallback: callers must supply both
 * pieces and they must describe the same provider login.
 */
export function requireSourceConnectionIdentity(
  integrationNamespace: string,
  providerLabel: string,
  input: Readonly<{
    sourceConnectionScope?: string;
    sourceConnectionKey?: string;
  }>,
): RequiredSourceConnectionIdentity {
  const validated = validateSourceConnectionIdentity(
    integrationNamespace,
    input,
  );
  if (
    validated.defects.includes("source-connection-scope-invalid") ||
    validated.defects.includes("source-connection-key-invalid")
  )
    throw new Error(
      `${providerLabel} workflow requires a stable caller-supplied Source Connection scope and key.`,
    );
  if (validated.defects.includes("source-connection-key-mismatch"))
    throw new Error(
      `${providerLabel} workflow Source Connection scope and key do not identify the same login.`,
    );
  return {
    sourceConnectionScope: validated.sourceConnectionScope!,
    sourceConnectionKey: validated.sourceConnectionKey!,
  };
}
