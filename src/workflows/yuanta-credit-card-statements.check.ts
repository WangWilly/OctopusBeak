import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { hasUntraversedPager, submitCreditCardMonthOptions } = await import(
  "./yuanta-credit-card-statements.ts"
);

const noPagerResponse = `
  <table class="rwdTable"><tr><td>本期帳單</td></tr></table>
  <a onclick="queryMonth('0')">115/06</a>
`;
const pagerResponse = `
  <table class="rwdTable"><tr><td>本期帳單</td></tr></table>
  <a class="pager" href="javascript:goPage(2)">下一頁</a>
`;

assert.equal(hasUntraversedPager(noPagerResponse), false);
assert.equal(hasUntraversedPager(pagerResponse), true);

const submitted: number[] = [];
const handled: number[] = [];
await submitCreditCardMonthOptions(
  [
    { index: 0, label: "115/06" },
    { index: 1, label: "115/05" },
  ],
  async (month) => {
    submitted.push(month.index);
    return noPagerResponse;
  },
  (month) => {
    handled.push(month.index);
  },
);
assert.deepEqual(submitted, [0, 1]);
assert.deepEqual(handled, [0, 1]);
await assert.rejects(
  submitCreditCardMonthOptions(
    [{ index: 0, label: "115/06" }],
    async () => pagerResponse,
    () => assert.fail("truncated response must not be handled"),
  ),
  /untraversed pagination/,
);
