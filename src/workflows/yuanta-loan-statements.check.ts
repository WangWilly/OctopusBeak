import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  YUANTA_LOAN_PAGINATION_FIXTURES_V1,
  YUANTA_LOAN_PAGINATION_FIXTURES_V2,
} from "./yuanta-loan-statements.fixtures.ts";
import type {
  LoanRepaymentRelationResolutionRequest,
  LoanRepaymentRelationResolutionResult,
} from "../ledger/canonical/loan-repayment-relations.ts";
import { queryCounterpartyAccountEvidence } from "../ledger/canonical/loan-repayment-relations.ts";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import { createCanonicalSourceStore } from "../ledger/canonical/canonical-source-store.ts";
import {
  collectRepaymentRouteInventory,
  type RepaymentRouteAnchorSnapshot,
  type RepaymentRouteInventoryEvent,
} from "./repayment-route-inventory.ts";
import { YUANTA_FMENU_MENU_FIXTURE } from "./repayment-route-inventory.fixtures.ts";

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
const { persistYuantaLoanCapture } = await import(
  "../ledger/canonical/yuanta-loan.ts"
);

const loanSource = await readFile(
  new URL("./yuanta-loan-statements.ts", import.meta.url),
  "utf8",
);
assert.match(loanSource, /await openStatementPage\(page\)/);
assert.match(loanSource, /emitRoutes\(/);
assert.match(loanSource, /collectRoutes\(page, \{/);
assert.ok(
  loanSource.indexOf("await openStatementPage(page)") <
    loanSource.indexOf("emitRoutes("),
  "Yuanta route inventory must wait for the verified loan page",
);
assert.ok(
  loanSource.indexOf("emitRoutes(") <
    loanSource.indexOf("const accounts = await readAccounts("),
  "Yuanta route inventory must run before loan form mutation/query",
);

function inventoryLocatorFor(
  anchors: readonly RepaymentRouteAnchorSnapshot[],
) {
  return {
    count: async () => anchors.length,
    nth: (index: number) => ({
      isVisible: async () => anchors[index]?.visible !== false,
      textContent: async () => anchors[index]?.label ?? null,
      getAttribute: async (name: string) => {
        const anchor = anchors[index];
        if (name === "href") return anchor?.href ?? null;
        if (name === "onclick") return anchor?.onclick ?? null;
        if (name === "data-action") return anchor?.action ?? null;
        return null;
      },
    }),
  };
}

function readyInventoryPage(): never {
  const fmenu = {
    name: () => "fmenu",
    childFrames: () => [],
    locator: (selector: string) => {
      assert.equal(selector, "a");
      return inventoryLocatorFor(YUANTA_FMENU_MENU_FIXTURE);
    },
  };
  const main = {
    name: () => "main",
    childFrames: () => [],
    locator: (selector: string) => {
      assert.equal(selector, "a");
      return inventoryLocatorFor([]);
    },
  };
  return {
    frames: () => [main, fmenu],
    mainFrame: () => main,
    locator: (selector: string) => {
      assert.equal(selector, "a");
      return inventoryLocatorFor([]);
    },
  } as never;
}

test("Yuanta loan emits one route inventory after the verified page is ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yuanta-loan-route-inventory-"));
  const eventOrder: string[] = [];
  const inventories: RepaymentRouteInventoryEvent[] = [];
  const stableConnectionScope = "YUANTA-USER-READY\u0000YUANTA-ACCOUNT-READY";
  const stableConnectionKey = deriveSourceConnectionIdentityKey(
    "yuanta",
    stableConnectionScope,
  );
  const page = readyInventoryPage();

  try {
    await runYuantaLoanStatements(
      page,
      {
        dateRange: "one_year",
        customDateRange: {
          startDate: "2026/01/01",
          endDate: "2026/01/31",
        },
        loanAccountFilters: [],
        replaceActiveSession: true,
      },
      {
        canonicalLedgerDir: directory,
        sourceConnectionScope: stableConnectionScope,
        sourceConnectionKey: stableConnectionKey,
        openLoanStatementPage: async () => {
          eventOrder.push("ready");
        },
        collectRepaymentRouteInventory: async (receivedPage, options) => {
          eventOrder.push("inventory");
          return await collectRepaymentRouteInventory(receivedPage, options);
        },
        emitRepaymentRouteInventory: (inventory) => {
          eventOrder.push("emit");
          inventories.push(inventory);
        },
        readLoanAccountOptions: async () => {
          eventOrder.push("accounts");
          return [];
        },
        writeLoanStatementsFile: (async () => ({})) as never,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  assert.deepEqual(eventOrder, ["ready", "inventory", "emit", "accounts"]);
  assert.equal(inventories.length, 1);
  assert.ok(
    inventories[0]?.candidates.some(
      (candidate) => candidate.label === "貸款繳款明細查詢",
    ),
  );
  assert.ok(
    inventories[0]?.candidates.some(
      (candidate) => candidate.label === "自動扣繳服務",
    ),
  );
});

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

test("Yuanta resolves only after a complete committed capture and preserves it when resolution fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yuanta-loan-relation-workflow-"));
  const relationRequests: LoanRepaymentRelationResolutionRequest[] = [];
  const eventOrder: string[] = [];
  const stableConnectionScope = "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001";
  const stableConnectionKey = deriveSourceConnectionIdentityKey(
    "yuanta",
    stableConnectionScope,
  );
  const sourceRow = {
    accountLabel: "房屋貸款",
    transactionDate: "2026/01/15",
    postingDate: "2026/01/15",
    paymentItem: "LOAN-PAYMENT",
    interestStartDate: "",
    interestEndDate: "",
    transactionAmount: "12500.00",
    balanceAfterTransaction: "87500.00",
    overpayment: "0.00",
    sortTime: Date.parse("2026-01-15T00:00:00+08:00"),
  };
  const parsed = {
    rows: [sourceRow],
    completeness: {
      pageCount: 1,
      terminal: true as const,
      proofKind: "source-declared-terminal-range" as const,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200" as const,
        terminal: true as const,
        rowCount: 1,
        proofKind: "source-declared-terminal-range" as const,
      },
    ],
  };
  try {
    const output = await runYuantaLoanStatements(
      {} as never,
      {
        dateRange: "one_year",
        customDateRange: {
          startDate: "2026/01/01",
          endDate: "2026/01/31",
        },
        loanAccountFilters: [],
        replaceActiveSession: true,
      },
      {
        canonicalLedgerDir: directory,
        sourceConnectionScope: stableConnectionScope,
        sourceConnectionKey: stableConnectionKey,
        observedAt: () => "2026-02-01T00:00:00.000Z",
        openLoanStatementPage: async () => undefined,
        readLoanAccountOptions: async () => [
          {
            label: "房屋貸款 - 12345678901234",
            value: "12345678901234",
          },
        ],
        queryLoanAccount: async () => undefined,
        traverseLoanStatementPages: async () => parsed,
        persistLoanCapture: async (store, input) => {
          const result = await persistYuantaLoanCapture(store, input);
          eventOrder.push("capture-committed");
          return result;
        },
        resolveRelations: async (store, request) => {
          relationRequests.push(request);
          eventOrder.push(
            `resolver-after-${
              Number(
                (
                  store.db
                    .prepare("SELECT COUNT(*) AS count FROM source_captures")
                    .get() as { count?: number }
                ).count ?? 0,
              )
            }-captures`,
          );
          throw new Error("synthetic relation resolver failure");
        },
        writeLoanStatementsFile: (async () => ({
          baseName: "yuanta-loan-relation-check",
          kind: "loan-statements",
          rowCount: 1,
          headers: [],
          accounts: ["房屋貸款"],
          dateRange: "2026/01/01-2026/01/31",
          sourceTables: [{ account: "房屋貸款", rowCount: 1 }],
          csvFilename: "yuanta-loan-relation-check.csv",
          jsonFilename: "yuanta-loan-relation-check.json",
          csvPath: "yuanta-loan-relation-check.csv",
          jsonPath: "yuanta-loan-relation-check.json",
          csvBytes: 0,
          jsonBytes: 0,
        })) as never,
      },
    );

    // No date/amount candidate is emitted as a fallback. The resolver failed
    // independently, so the committed financial fact remains usable and the
    // workflow still returns its table output.
    assert.equal(output.relationResolution, undefined);
    assert.deepEqual(eventOrder, ["capture-committed", "resolver-after-1-captures"]);
    assert.equal(relationRequests.length, 1);
    assert.equal(relationRequests[0]?.sourceConnectionKey, stableConnectionKey);
    assert.deepEqual(relationRequests[0]?.requiredCoverage, { complete: true });
    assert.equal("explicitLinks" in relationRequests[0]!, false);

    const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
    try {
      assert.equal(
        (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM source_captures")
            .get() as { count?: number }
        ).count,
        1,
      );
      const evidence = queryCounterpartyAccountEvidence(store);
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.sourceValue, "12345678901234");
      assert.equal(evidence[0]?.normalizedValue, "12345678901234");
      assert.equal(evidence[0]?.sourceField, "貸款帳號");
      assert.equal(evidence[0]?.evidenceKind, "repayment-mandate");
      assert.equal(evidence[0]?.effectiveStartDate, "2026-01-01");
      assert.equal(evidence[0]?.effectiveEndDate, "2026-01-31");
      assert.notEqual(evidence[0]?.accountId, null);
      assert.equal(evidence[0]?.transactionId, null);
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
