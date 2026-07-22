import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./fubon-all-statements.ts", import.meta.url),
  "utf8",
);

assert.match(source, /function signOutFubon/);
assert.match(source, /activateControlWithoutPointer/);
assert.match(source, /logoutNow/);
assert.match(source, /BANK_STATEMENT_CAPABILITIES/);
assert.match(
  source,
  /resolveStatementSelection\([\s\S]*BANK_STATEMENT_CAPABILITIES\.fubon/,
);
assert.match(source, /runSelectedStatements\(selectedIds, \[/);
assert.match(
  source,
  /typeId: "deposit"[\s\S]*typeId: "credit_card"[\s\S]*typeId: "loan"/,
);
assert.equal(source.match(/await signInFubon\(/g)?.length, 1);
assert.match(
  source,
  /finally \{[\s\S]*?stopSessionKeepAlive\(\);[\s\S]*?signOutFubon\(page\)/,
);
