import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./cathay-all-statements.ts", import.meta.url),
  "utf8",
);

assert.match(
  source,
  /statementTypes: z\.array\(statementTypeSchema\)\.min\(1\)\.optional\(\)/,
);
assert.match(source, /BANK_STATEMENT_CAPABILITIES/);
assert.match(
  source,
  /resolveStatementSelection\([\s\S]*BANK_STATEMENT_CAPABILITIES\.cathay/,
);
assert.match(source, /runSelectedStatements\(selectedIds, \[/);
assert.match(
  source,
  /typeId: "domestic"[\s\S]*retryableStage\([\s\S]*typeId: "foreign_currency"[\s\S]*retryableStage\(/,
);
assert.equal(source.match(/await signInCathay\(/g)?.length, 1);
assert.match(
  source,
  /reset: async \(\) => \{[\s\S]*cathaySession = await createCathaySession\(page\)/,
);
assert.match(
  source,
  /typeId === "foreign_currency"\s*\? "foreign" : "domestic"/,
);
