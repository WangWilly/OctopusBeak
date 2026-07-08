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
assert.match(source, /turnCDFunc\(2\)/);
assert.match(source, /for \(const scope of \[\.\.\.page\.frames\(\), page\]\)/);
assert.doesNotMatch(source, /\[page, \.\.\.page\.frames\(\)\]/);
assert.match(
  source,
  /const hasMonthLink = await hasAttachedLocator\(\s*scope\.locator\('a\[onclick\*="queryMonth\("\]'\),\s*\)/,
);
assert.match(
  source,
  /const hasTable = await hasAttachedLocator\(scope\.locator\("table\.rwdTable"\)\)/,
);
assert.doesNotMatch(source, /\.or\(candidate\.locator\('a\[onclick\*="queryMonth\("\]'\)\)/);
assert.match(source, /yuanta-credit-card-months-found/);
assert.match(source, /yuanta-credit-card-page-ready-start/);
assert.match(source, /yuanta-credit-card-page-ready-complete[\s\S]*durationMs/);
assert.match(source, /yuanta-credit-card-month-start/);
assert.match(source, /yuanta-credit-card-month-start[\s\S]*startedAt/);
assert.match(source, /yuanta-credit-card-month-complete[\s\S]*durationMs/);
assert.match(source, /yuanta-credit-card-unbilled-start/);
assert.match(source, /yuanta-credit-card-unbilled-start[\s\S]*startedAt/);
assert.match(source, /yuanta-credit-card-unbilled-complete[\s\S]*durationMs/);
assert.match(source, /const creditCardProgress = \(currentCreditCardSteps/);
assert.match(source, /automation-progress: \$\{[\s\S]*60 \+[\s\S]*Math\.min\(\s*14,/);
assert.match(source, /creditCardProgress\(monthPosition \+ 1\)/);
assert.match(source, /creditCardProgress\(completedCreditCardSteps \+ 1\)/);
assert.doesNotMatch(source, /waitForTimeout\(500\)/);
assert.match(source, /function parseCreditCardBillsHtml\(/);
assert.match(source, /async function readCurrentCreditCardBillsHtml\(/);
assert.match(source, /async function readCreditCardBillsHtmlFromCurrentUrl\(/);
assert.match(source, /async function readCreditCardBillsHtmlFromFrameUrl\(/);
assert.match(source, /async function submitCreditCardMonth\(/);
assert.match(source, /async function waitForCreditCardForm\(frame: Frame\)/);
assert.match(source, /form#mform \[name="cdHistoryQuery"\]/);
assert.match(source, /state: "attached"/);
assert.match(source, /await waitForCreditCardForm\(frame\);/);
assert.match(source, /waitForResponse\(\s*\(response\) =>/);
assert.match(source, /form\.submit\(\)/);
assert.doesNotMatch(source, /frame\.locator\("#mform"\)\.evaluate/);
assert.doesNotMatch(source, /frame\.content\(\)/);
assert.match(source, /let currentMonthHtml = await readCurrentCreditCardBillsHtml\(page\)/);
assert.doesNotMatch(
  source,
  /await openCreditCardBillsPage\(page\);\s+let currentMonthHtml = await readCurrentCreditCardBillsHtml\(page\)/,
);
assert.match(source, /const parsedMonth = parseCreditCardBillsHtml\(currentMonthHtml, month\.label\)/);
assert.match(source, /parseCreditCardBillsHtml\(\s*await submitCreditCardUnbilled\(page\),\s*null,\s*false,\s*\)/);
assert.doesNotMatch(source, /const allMonthOptions = await readMonthOptions\(page\)/);
assert.doesNotMatch(source, /await clickMonth\(page, month\)/);
assert.doesNotMatch(source, /await parseStatementRows\(\s*page,/);
