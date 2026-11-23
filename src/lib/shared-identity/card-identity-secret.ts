import { createHash } from "node:crypto";

/**
 * What the ledger knows about the Card identity secret workflows derive card
 * identities from (ADR 0149). `verifier` is one-way: it cannot be turned back
 * into the secret. `created` says this install created the secret itself,
 * rather than finding it already in credentials.json.
 */
export type CardIdentitySecret = Readonly<{ verifier: string; created: boolean }>;

export const CARD_IDENTITY_SECRET_VERIFIER = /^[0-9a-f]{64}$/u;

export function cardIdentitySecretVerifier(secret: string): string {
  return createHash("sha256").update("octopusbeak/card-identity-secret-verifier/v1\0").update(secret).digest("hex");
}
