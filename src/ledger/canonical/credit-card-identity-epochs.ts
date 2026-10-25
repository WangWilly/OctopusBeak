import { createHash } from "node:crypto";

/**
 * One card source's identity epochs (ADR 0062). Workflows declare `current`;
 * the canonical spine persists every epoch as a digest under `spineLabel`. A
 * superseded epoch's accounts leave the store only through a Canonical Reset,
 * so its captures are refused until then.
 */
export type CreditCardIdentityEpochs = Readonly<{
  spineLabel: string;
  current: string;
  superseded: readonly string[];
}>;

/** The identity epoch key the canonical spine persists for a workflow epoch. */
export function creditCardSpineEpochKey(
  epochs: CreditCardIdentityEpochs,
  identityEpochKey: string,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([epochs.spineLabel, identityEpochKey]))
    .digest("base64url")}`;
}

export function supersededCreditCardSpineEpochKeys(
  epochs: CreditCardIdentityEpochs,
): readonly `sha256:${string}`[] {
  return Object.freeze(epochs.superseded.map((epoch) => creditCardSpineEpochKey(epochs, epoch)));
}
