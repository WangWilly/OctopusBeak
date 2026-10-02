import assert from "node:assert/strict";
import { parseYuantaFundCatalog, resolveYuantaFundCatalogName } from "./yuanta-fund-catalog.ts";

function record(code: string, name: string, currency: string): string {
  const fields = Array<string>(39).fill("");
  fields[0] = "71"; fields[1] = "SYNTHETIC COMPANY";
  fields[2] = code; fields[3] = name; fields[4] = currency;
  return fields.join("_");
}
const a = record("7116", "SYNTHETIC FUND A美元", "USD");
const u = record("7310", "SYNTHETIC FUND U美元", "USD");
const script = `var singleTwFund = new Array();
var singleFxFund = new Array();
tempChoiceSingleFund= '${a}';
singleFxFund[parseInt(0,10)][parseInt(0,10)]=${JSON.stringify(u)};
singleFxFund[parseInt(1,10)][parseInt(0,10)]=${JSON.stringify(a)};
globalThis.untrustedCatalogExecuted = true;`;
const catalog = parseYuantaFundCatalog(script);
assert.deepEqual(catalog.map(e => e.fundCode), ["7116", "7310"]);
assert.equal(resolveYuantaFundCatalogName(catalog, "SYNTHETIC FUND Ｕ美元").fundCode, "7310");
assert.equal(resolveYuantaFundCatalogName(catalog, "SYNTHETIC FUND A美元").pricingCurrency, "USD");
assert.equal(Reflect.get(globalThis, "untrustedCatalogExecuted"), undefined);
assert.throws(() => resolveYuantaFundCatalogName(catalog, "SYNTHETIC FUND"));
assert.throws(() => resolveYuantaFundCatalogName(catalog, "SYNTHETIC 基金 FUND A美元"));
assert.throws(() => resolveYuantaFundCatalogName([...catalog, { ...catalog[0], fundCode: "9999" }], catalog[0].name));
assert.throws(() => parseYuantaFundCatalog(`${script}\ntempChoiceSingleFund=${JSON.stringify(record("7310", "OTHER", "EUR"))};`));
assert.throws(() => parseYuantaFundCatalog("tempChoiceSingleFund='malformed';"));
assert.throws(() => parseYuantaFundCatalog("var singleFxFund = new Array();"));
const escaped = record("1234", "SYNTHETIC O'BRIEN A", "USD").replace(/'/g, "\\'");
assert.equal(parseYuantaFundCatalog(`tempChoiceSingleFund='${escaped}';`)[0].name, "SYNTHETIC O'BRIEN A");

const { resolveYuantaFundIdentity } = await import("./yuanta-fund-catalog.ts");
assert.deepEqual(resolveYuantaFundIdentity("  SYNTHETIC ＦＵＮＤ Ａ  "), {
  fundCode: "name:SYNTHETIC FUND A", name: "SYNTHETIC FUND A", pricingCurrency: null, identityKind: "source-fund-name",
});
assert.throws(() => resolveYuantaFundIdentity("   "));
