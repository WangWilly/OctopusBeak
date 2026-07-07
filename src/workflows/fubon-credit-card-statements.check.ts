import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./fubon-credit-card-statements.ts", import.meta.url),
  "utf8",
);

assert.match(source, /isFubonCreditCardNoRecordText/);
assert.match(source, /查無相關資料/);
assert.match(source, /openUnbilledDetailsPage[\s\S]*?findUnbilledDetailsScope/);
assert.match(
  source,
  /findUnbilledDetailsScope[\s\S]*?isFubonCreditCardNoRecordText/,
);
