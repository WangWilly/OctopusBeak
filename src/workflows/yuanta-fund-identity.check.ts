import assert from "node:assert/strict";
import { resolveYuantaFundIdentity } from "./yuanta-fund-identity.ts";
assert.deepEqual(resolveYuantaFundIdentity("  SYNTHETIC ＦＵＮＤ Ａ  "), {
  producerSecurityId: "name:SYNTHETIC FUND A", name: "SYNTHETIC FUND A", pricingCurrency: null, identityKind: "source-fund-name",
});
assert.throws(() => resolveYuantaFundIdentity("   "));
