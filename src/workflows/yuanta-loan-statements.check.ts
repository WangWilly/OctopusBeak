import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerHooks } from "node:module";
import {
  assertYuantaLoanCaptureAccountNumberEvidence,
  buildYuantaLoanCapture,
} from "../ledger/canonical/yuanta-loan-admission.ts";
import {
  YUANTA_LOAN_PAGINATION_FIXTURES_V1,
  YUANTA_LOAN_PAGINATION_FIXTURES_V2,
} from "./yuanta-loan-statements.fixtures.ts";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";

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

const {
  readYuantaLoanAccountOptions,
  parseYuantaLoanStatementRows,
  runYuantaLoanStatements,
  deriveYuantaLoanAccountNumberEvidence,
  yuantaLoanSelectorAccountEvidence,
} =
  await import("./yuanta-loan-statements.ts");

assert.deepEqual(
  yuantaLoanSelectorAccountEvidence({
    value: "12345678901234",
    label: "秀朗 - 信貸中放 - 12345678901234",
  }),
  {
    rowOrdinal: 0,
    accountValue: "12345678901234",
    role: "beneficiary",
    purpose: "loan_repayment",
    scope: "loan_contract",
    evidenceKind: "repayment-mandate",
    sourceField: "貸款帳號",
    contractVersion: "yuanta/loan-statement-selector-account/v1",
  },
);
assert.deepEqual(
  deriveYuantaLoanAccountNumberEvidence({
    value: "12345678901234",
    label: "秀朗 - 信貸中放 - 12345678901234",
  }),
  {
    value: "12345678901234",
    kind: "loan-account",
    evidenceVersion: "yuanta/loan/account-number-v1",
    sourceField: "#acctno option.value",
  },
);
assert.equal(
  deriveYuantaLoanAccountNumberEvidence({
    value: "12345678901234",
    label: "秀朗 - 信貸中放 - ******1234",
  }),
  null,
);
for (const account of [
  { value: "opaque-query-token", label: "房屋貸款" },
  { value: "12345678901234", label: "房屋貸款 ******1234" },
  { value: "12345678901234", label: "房屋貸款 99999999999999" },
  {
    value: "12345678901234foo",
    label: "房屋貸款 12345678901234",
  },
  {
    value: "12-345678901234",
    label: "房屋貸款 12345678901234",
  },
  {
    value: "12345678901234",
    label: "房屋貸款 123456789012345",
  },
]) {
  assert.throws(
    () => yuantaLoanSelectorAccountEvidence(account),
    /one matching full 14-digit account/u,
  );
}
const { parseYuantaLoanPaginationSignal } = await import(
  "./yuanta-loan-statements.ts"
);

test("Yuanta exported loan run fails closed without caller Source Connection identity", async () => {
  await assert.rejects(
    () =>
      runYuantaLoanStatements(
        {} as Parameters<typeof runYuantaLoanStatements>[0],
        {} as Parameters<typeof runYuantaLoanStatements>[1],
      ),
    /stable caller-supplied Source Connection scope and key/u,
  );
});
const { assembleYuantaLoanStatement } = await import(
  "./yuanta-loan-statements.ts"
);
const { StatementComponentAbsentError } =
  await import("./run-selected-statements.ts");

const loanSource = await readFile(
  new URL("./yuanta-loan-statements.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  loanSource,
  /from\s+["']libretto["']|LibrettoWorkflowContext|from\s+["']node:fs\/promises["']|writeFile\(|outputDir|requirePGliteChildRpcClient|executePGliteWorkflowRun|export\s+default\s+workflow/u,
  "the App-owned provider must not retain a separate runner or persistence path",
);
assert.match(loanSource, /sourceText\??\.assertIntact/u);
assert.match(loanSource, /await openStatementPage\(page\)/);
assert.doesNotMatch(loanSource, /RepaymentRouteInventory/);
assert.match(loanSource, /PGLITE_CANONICAL_LOAN_COMMIT_COMMAND/u);
assert.match(loanSource, /PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND/u);
assert.doesNotMatch(
  loanSource,
  /canonicalLoanCaptureSpines|persistCanonicalLoanCaptureExtensions|commitCanonicalFinancialDepositCaptureBatchInTransaction/u,
  "the workflow must not coordinate internal loan spines or low-level deposit batches",
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

test("Yuanta loan typed collection admits complete source without writing or committing", async () => {
  const deferred: PGliteWorkflowRunItem[] = [];
  const testLoanAccount = "1234".repeat(3) + "12";
  const account = { label: `房屋貸款 - ${testLoanAccount}`, value: testLoanAccount };
  const controller = new AbortController();
  const collection = await runYuantaLoanStatements(
    {} as never,
    {
      dateRange: "one_year",
      customDateRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
      loanAccountFilters: [],
      replaceActiveSession: true,
    },
    {
      sourceConnectionScope: "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001",
      sourceConnectionKey: deriveSourceConnectionIdentityKey(
        "yuanta",
        "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001",
      ),
      observedAt: () => "2026-02-01T00:00:00.000Z",
      openLoanStatementPage: async () => undefined,
      readLoanAccountOptions: async () => [account],
      queryLoanAccount: async () => undefined,
      traverseLoanStatementPages: async (_page, _label, options) => {
        assert.equal(options?.silent, true);
        return {
          rows: [{
            accountLabel: "房屋貸款", transactionDate: "2026/01/15", postingDate: "2026/01/15",
            paymentItem: "LOAN-PAYMENT", interestStartDate: "", interestEndDate: "",
            transactionAmount: "12500.00", balanceAfterTransaction: "87500.00",
            overpayment: "0.00", sortTime: Date.parse("2026-01-15T00:00:00+08:00"),
          }],
          completeness: { pageCount: 1, terminal: true, proofKind: "source-declared-terminal-range" },
          pages: [{ pageOrdinal: 0, responseCode: "200", terminal: true, rowCount: 1, proofKind: "source-declared-terminal-range" }],
        };
      },
      collectOnly: true,
      deferredCommitItems: deferred,
      sourceText: strictSourceText,
      signal: controller.signal,
    },
  );
  assert.deepEqual(collection, { sourceCount: 1, rowCount: 1, itemCount: 1 });
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0]?.product, "loan");
});

test("Yuanta loan typed collection rejects an incomplete source before yielding items", async () => {
  const deferred: PGliteWorkflowRunItem[] = [];
  await assert.rejects(
    runYuantaLoanStatements(
      {} as never,
      { dateRange: "one_year", loanAccountFilters: [], replaceActiveSession: true },
      {
        sourceConnectionScope: "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001",
        sourceConnectionKey: deriveSourceConnectionIdentityKey(
          "yuanta",
          "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001",
        ),
        openLoanStatementPage: async () => undefined,
        readLoanAccountOptions: async () => [
          { label: "房屋貸款 - 12345678901234", value: "12345678901234" },
        ],
        queryLoanAccount: async () => undefined,
        traverseLoanStatementPages: async () => ({
          rows: [],
          completeness: null,
          pages: [{ pageOrdinal: 0, responseCode: "200", terminal: false, rowCount: 0, proofKind: "source-declared-terminal-range" }],
        }),
        collectOnly: true,
        deferredCommitItems: deferred,
        sourceText: strictSourceText,
        signal: new AbortController().signal,
      },
    ),
    /explicit complete terminal page evidence/u,
  );
  assert.deepEqual(deferred, []);
});

test("builds and validates a canonical Yuanta loan capture from source rows", () => {
  const capture = buildYuantaLoanCapture({
    accountValue: "yuanta-option-test",
    accountNumber: {
      value: "12345678901234",
      kind: "loan-account",
      evidenceVersion: "yuanta/loan/account-number-v1",
      sourceField: "#acctno option.value",
    } as const,
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
  });

  assertYuantaLoanCaptureAccountNumberEvidence(capture);
  assert.equal(capture.sourceId, "yuanta");
  assert.equal(capture.relationCoverage, "not-asserted");
  assert.equal(capture.records.length, 1);
  assert.match(capture.identity.accountNo, /^sha256:/u);
  assert.deepEqual(capture.identity.accountNumber, {
    value: "12345678901234",
    kind: "loan-account",
    evidenceVersion: "yuanta/loan/account-number-v1",
    sourceField: "#acctno option.value",
  });
});

test("Yuanta complete loan captures preserve duplicate-group slots and reject changed claims on one source anchor", () => {
  const build = (rows: Parameters<typeof buildYuantaLoanCapture>[0]["rows"]) =>
    buildYuantaLoanCapture({
      accountValue: "yuanta-duplicate-group-account",
      sourceConnectionScope: "yuanta-duplicate-group-connection",
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
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: rows.length,
        proofKind: "source-declared-terminal-range",
      }],
      counterpartTransactions: [],
      relations: [],
      relationCoverage: "not-asserted",
      rows,
    });
  const first = {
    transactionDate: "2026/01/05",
    postingDate: "2026/01/06",
    paymentItem: "LOAN-PAYMENT",
    transactionAmount: "1000.00",
    balanceAfterTransaction: "9000.00",
  };
  const duplicateCapture = build([first, first]);
  assert.deepEqual(duplicateCapture.records.map((record) => record.occurrenceIndex), [1, 2]);
  assert.notEqual(duplicateCapture.records[0]?.sourceRecordKey, duplicateCapture.records[1]?.sourceRecordKey);
  assert.deepEqual(duplicateCapture.records.map((record) => record.sourceSequenceIndex), [1, 2]);
  const insertedUnrelatedRow = build([{
    transactionDate: "2026/01/04",
    postingDate: "2026/01/04",
    paymentItem: "LOAN-FEE",
    transactionAmount: "100.00",
    balanceAfterTransaction: "9100.00",
  }, first, first]);
  assert.deepEqual(
    insertedUnrelatedRow.records.slice(1).map((record) => record.sourceRecordKey),
    duplicateCapture.records.map((record) => record.sourceRecordKey),
  );
  assert.throws(
    () => build([first, { ...first, transactionAmount: "1200.00" }]),
    /contradictory transaction claims/u,
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

test("Yuanta pagination derives terminal/page evidence from provider controls", () => {
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V1.activePage,
    ),
    {
      nextPageTarget: "page:2",
      terminal: false,
      evidence: "next-page",
    },
  );
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V1.activePageWithoutExplicitAriaState,
    ),
    {
      nextPageTarget: "page:2",
      terminal: false,
      evidence: "next-page",
    },
  );
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V1.terminalPage,
    ),
    {
      nextPageTarget: null,
      terminal: true,
      evidence: "terminal-no-next",
    },
  );
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V1.ambiguousTable,
    ),
    {
      nextPageTarget: null,
      terminal: false,
      evidence: null,
    },
  );
  for (const fixture of [
    YUANTA_LOAN_PAGINATION_FIXTURES_V1.unrelatedPagerOnly,
    YUANTA_LOAN_PAGINATION_FIXTURES_V1.unrelatedPagerOutsideResult,
  ]) {
    assert.deepEqual(parseYuantaLoanPaginationSignal(fixture), {
      nextPageTarget: null,
      terminal: false,
      evidence: null,
    });
  }
});

test("Yuanta v2 terminal rule accepts the live six-column result shape only", () => {
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V2.providerResultTerminalWithoutPager,
      1,
    ),
    {
      nextPageTarget: null,
      terminal: true,
      evidence: "terminal-no-next",
    },
  );
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V2.providerResultWithoutRows,
      0,
    ),
    {
      nextPageTarget: null,
      terminal: false,
      evidence: null,
    },
  );
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V2.providerResultWrongHeaderShape,
      1,
    ),
    {
      nextPageTarget: null,
      terminal: false,
      evidence: null,
    },
  );
});

test("Yuanta multi-page traversal preserves page ordinals and terminal evidence", () => {
  const parsed = assembleYuantaLoanStatement([
    {
      rows: [
        {
          accountLabel: "masked-loan",
          transactionDate: "2026/01/05",
          postingDate: "2026/01/06",
          paymentItem: "LOAN-DISBURSEMENT",
          interestStartDate: "",
          interestEndDate: "",
          transactionAmount: "100000.00",
          balanceAfterTransaction: "100000.00",
          overpayment: "",
          sortTime: 1,
        },
      ],
      pageOrdinal: 0,
      pagination: {
        nextPageTarget: "page:2",
        terminal: false,
        evidence: "next-page",
      },
    },
    {
      rows: [
        {
          accountLabel: "masked-loan",
          transactionDate: "2026/01/31",
          postingDate: "2026/02/01",
          paymentItem: "LOAN-PAYMENT",
          interestStartDate: "",
          interestEndDate: "",
          transactionAmount: "12500.00",
          balanceAfterTransaction: "87500.00",
          overpayment: "",
          sortTime: 2,
        },
      ],
      pageOrdinal: 1,
      pagination: {
        nextPageTarget: null,
        terminal: true,
        evidence: "terminal-no-next",
      },
    },
  ]);

  assert.equal(parsed.completeness?.pageCount, 2);
  assert.deepEqual(
    parsed.pages.map((page) => [page.pageOrdinal, page.rowCount, page.terminal]),
    [
      [0, 1, false],
      [1, 1, true],
    ],
  );
  assert.equal(parsed.rows.length, 2);
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
