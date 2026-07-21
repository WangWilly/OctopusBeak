import { createHash } from "node:crypto";

export function sourceVersionKey(bank: string, product: string, sourceFileHash: string) {
  return createHash("sha256")
    .update(JSON.stringify([bank, product, sourceFileHash]))
    .digest("hex");
}
