import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    if (specifier === "./yuanta-statements.js") {
      return nextResolve("./yuanta-statements.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { isYuantaFundPositionAbsentText } =
  await import("./yuanta-fund-statements.ts");

const source = await readFile(
  new URL("./yuanta-fund-statements.ts", import.meta.url),
  "utf8",
);

assert.match(source, /yuanta-fund-positions-found/);
assert.match(source, /yuanta-fund-history-start/);
assert.match(source, /yuanta-fund-positions-found[\s\S]*durationMs/);
assert.match(source, /yuanta-fund-history-start[\s\S]*startedAt/);
assert.match(source, /yuanta-fund-history-complete[\s\S]*durationMs/);
assert.match(source, /const fundProgress = \(\) =>/);
assert.match(source, /selectedFunds = fundPositions/);
assert.doesNotMatch(source, /selectedFunds = fundPositions\.filter/);
assert.match(source, /runFundMenuAction\(/);
assert.match(source, /evaluateYuantaFundCanonicalAdmission/);
assert.match(source, /source-effective-time-not-validated/);
assert.match(source, /yuanta-fund-canonical-not-admitted/);
assert.match(
  source,
  /automation-progress: \$\{[\s\S]*75 \+[\s\S]*Math\.min\(\s*24,/,
);

assert.equal(isYuantaFundPositionAbsentText("目前無持有基金"), true);
assert.equal(isYuantaFundPositionAbsentText("未持有基金部位"), true);
assert.equal(
  isYuantaFundPositionAbsentText("投資日期 基金名稱 交易編號"),
  false,
);
