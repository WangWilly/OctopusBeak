import assert from "node:assert/strict";
import test from "node:test";
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

const { readYuantaLoanAccountOptions, parseYuantaLoanStatementRows } =
  await import("./yuanta-loan-statements.ts");
const { parseYuantaLoanCompletenessEvidence } = await import(
  "./yuanta-loan-statements.ts"
);
const { StatementComponentAbsentError } =
  await import("./run-selected-statements.ts");
const { persistYuantaLoanCapture } = await import(
  "../ledger/canonical/yuanta-loan.ts"
);

function loanOptionsPage(
  options: Array<{ value: string; label: string }>,
): never {
  const optionLocator = {
    first: () => ({
      waitFor: async ({ state }: { state: "attached" }) => {
        assert.equal(state, "attached");
      },
    }),
    count: async () => options.length,
    nth: (index: number) => ({
      getAttribute: async (name: string) =>
        name === "value" ? (options[index]?.value ?? null) : null,
      textContent: async () => options[index]?.label ?? null,
    }),
    filter: () => optionLocator,
  };
  return {
    frames: () => [],
    waitForTimeout: async () => {},
    locator: (selector: string) => {
      if (selector === "#acctno") return optionLocator;
      if (selector === "#acctno option") return optionLocator;
      if (selector === "#duration a") return optionLocator;
      throw new Error(`Unexpected selector ${selector}`);
    },
  } as never;
}

await assert.rejects(
  readYuantaLoanAccountOptions(
    loanOptionsPage([{ value: "0", label: "請選擇貸款帳戶" }]),
  ),
  (error: unknown) => {
    assert.ok(error instanceof StatementComponentAbsentError);
    assert.equal(error.skipReason, "absent");
    return true;
  },
);

assert.deepEqual(
  await readYuantaLoanAccountOptions(
    loanOptionsPage([
      { value: "0", label: "請選擇貸款帳戶" },
      { value: "loan-1", label: "房屋貸款" },
      { value: "loan-2", label: "信用貸款" },
    ]),
  ),
  [
    { value: "loan-1", label: "房屋貸款" },
    { value: "loan-2", label: "信用貸款" },
  ],
);

test("commits one canonical capture for a parsed Yuanta loan result", async () => {
  let commitCount = 0;
  const admittedCaptures: unknown[] = [];
  await persistYuantaLoanCapture(
    null as never,
    {
      accountValue: "yuanta-option-test",
      sourceConnectionScope: "yuanta-connection-test",
      observedAt: "2026-02-01T00:00:00.000Z",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      scope: {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        completeness: "complete-range",
        completenessBasis: "source-declared-terminal-range",
        completenessRuleVersion: "loan/canonical/v1.yuanta",
        pageCount: 1,
        terminal: true,
      },
      pages: [
        {
          pageOrdinal: 0,
          responseCode: "200",
          terminal: true,
          rowCount: 1,
          proofKind: "source-declared-terminal-range",
        },
      ],
      relationCoverage: "not-asserted",
      counterpartTransactions: [],
      relations: [],
      rows: [
        {
          transactionDate: "2026/01/05",
          postingDate: "2026/01/06",
          paymentItem: "LOAN-DISBURSEMENT",
          transactionAmount: "100000.00",
          balanceAfterTransaction: "100000.00",
        },
      ],
    },
    {
      commit: async (_store, admitted) => {
        commitCount += 1;
        admittedCaptures.push(admitted);
        return {} as never;
      },
    },
  );

  assert.equal(commitCount, 1);
  assert.equal(admittedCaptures.length, 1);
  assert.equal(
    (admittedCaptures[0] as { relationCoverage?: string }).relationCoverage,
    "not-asserted",
  );
});

test("fails closed when a Yuanta result row does not have six source cells", () => {
  assert.throws(
    () =>
      parseYuantaLoanStatementRows("masked-loan", [
        ["2026/01/01", "LOAN-PAYMENT", "", "10", "90"],
      ]),
    /unexpected Yuanta loan result row/i,
  );
});

test("Yuanta completeness requires explicit provider terminal/page evidence", () => {
  assert.equal(parseYuantaLoanCompletenessEvidence(undefined), null);
  assert.equal(
    parseYuantaLoanCompletenessEvidence({
      pageCount: 1,
      terminal: false,
      proofKind: "source-declared-terminal-range",
    }),
    null,
  );
  assert.deepEqual(
    parseYuantaLoanCompletenessEvidence({
      pageCount: 1,
      terminal: true,
      proofKind: "source-declared-terminal-range",
    }),
    { pageCount: 1, terminal: true, proofKind: "source-declared-terminal-range" },
  );
  assert.deepEqual(
    parseYuantaLoanCompletenessEvidence({
      pageCount: 3,
      terminal: true,
      proofKind: "source-declared-terminal-range",
    }),
    { pageCount: 3, terminal: true, proofKind: "source-declared-terminal-range" },
  );
});

assert.deepEqual(
  await readYuantaLoanAccountOptions(
    loanOptionsPage([
      { value: "loan-1", label: "房屋貸款" },
      { value: "loan-2", label: "信用貸款" },
    ]),
    ["missing"],
  ),
  [
    { value: "loan-1", label: "房屋貸款" },
    { value: "loan-2", label: "信用貸款" },
  ],
);
