import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./yuanta-credit-card-statements.ts", import.meta.url),
  "utf8",
);

assert.match(
  source,
  /const ready = await waitForCreditCardBillsReady\(\s*page,\s*undefined,\s*8_000,\s*\)\.catch\(\(\) => null\)/,
);
assert.match(source, /if \(ready\) return ready/);
assert.match(source, /if \(await clickCreditCardBillsLink\(page, 5_000\)\)/);
