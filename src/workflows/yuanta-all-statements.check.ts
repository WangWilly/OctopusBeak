import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./yuanta-all-statements.ts", import.meta.url),
  "utf8",
);

assert.match(source, /for \(const scope of \[\.\.\.page\.frames\(\), page\]\)/);
assert.match(source, /const hasMonthLink = await hasAttachedLocator\(/);
assert.match(source, /const hasTable = await hasAttachedLocator\(/);
assert.match(source, /if \(hasMonthLink && hasTable\) return true/);
assert.match(source, /yuanta-all-component-page-ready[\s\S]*durationMs/);
assert.match(source, /yuanta-all-component-page-not-ready[\s\S]*durationMs/);
assert.match(source, /BANK_STATEMENT_CAPABILITIES/);
assert.match(
  source,
  /resolveStatementSelection\([\s\S]*BANK_STATEMENT_CAPABILITIES\.yuanta/,
);
assert.match(source, /runSelectedStatements\(selectedIds, \[/);
assert.match(
  source,
  /typeId: "deposit"[\s\S]*typeId: "foreign_currency"[\s\S]*typeId: "loan"[\s\S]*typeId: "credit_card"[\s\S]*typeId: "fund"/,
);
assert.match(source, /prepare:[\s\S]*?prepareForComponent\(ctx, "foreignCurrency"\)/);
assert.match(source, /prepare:[\s\S]*?prepareForComponent\(ctx, "loan"\)/);
assert.match(source, /prepare:[\s\S]*?prepareForComponent\(ctx, "creditCard"\)/);
assert.match(source, /prepare:[\s\S]*?prepareForComponent\(ctx, "fund"\)/);
assert.match(
  source,
  /typeId: "fund"[\s\S]*run:[\s\S]*?yuantaFundStatements\.run/,
);
assert.doesNotMatch(
  source,
  /\.or\(candidate\.locator\('a\[onclick\*="queryMonth\("\]'\)\)/,
);
