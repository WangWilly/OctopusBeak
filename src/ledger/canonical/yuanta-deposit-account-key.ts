import { createHash } from "node:crypto";

function yuantaAccountDigest(domain: string, ...values: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(domain);
  for (const value of values) hash.update("\0").update(value);
  return `sha256:${hash.digest("base64url")}`;
}

/** Stable digest for the account selector value used by Yuanta deposit rows. */
export function deriveYuantaDomesticDepositAccountKey(
  accountValue: string,
): string {
  return yuantaAccountDigest("yuanta-account-selector-v1", accountValue);
}
