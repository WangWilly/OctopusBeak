import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Page } from "playwright";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { assertLoanCommitGolden, recordDepositCommit } from "./deposit-commit-golden.ts";
import type { FubonAllWorkflowDependencies } from "./fubon-all-statements.ts";
import type { FubonLoanSourceSnapshot } from "./fubon-loan-statements.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { fubonWorkflowWith } = await import("./fubon-all-statements.ts");
const { runVerifiedEntry } = await import("../lib/automation/server/verified-entry.ts");
const { withBoundProducts } = await import("../lib/automation/product-collection.fixtures.ts");
const { FUBON_SOURCE } = await import("../lib/automation/server/sources/fubon.ts");
const { assembleFubonLoanStatement, stageFubonLoan } = await import("./fubon-loan-statements.ts");

const NOW = "2026-09-25T00:00:00.000Z";
const QUERY = { quickMonths: "6", startDate: "2026/03/24", endDate: "2026/09/25" } as const;
const RANGE = { startDate: "2026-03-24", endDate: "2026-09-25" };

type Account = Readonly<{ label: string; value: string }>;
type Cells = readonly [date: string, content: string, amount: string, balance: string];

/** One result page as the parser reads it: 交易日期, 交易內容, 異動金額, 利率, 計息起日, 計息止日, 餘額, 備註. */
function page(rows: readonly Cells[], pageOrdinal: number, nextPage: string | null) {
  return {
    accountType: "SYNTHETIC-LOAN",
    branchName: "SYNTHETIC-BRANCH",
    currency: "TWD",
    rows: rows.map(([date, content, amount, balance]) => [date, content, amount, "1.50", date, date, balance, ""]),
    pageOrdinal,
    pagination: nextPage === null
      ? { nextPage: null, pageFieldName: null, terminal: true, evidence: "terminal-no-next" as const }
      : { nextPage, pageFieldName: "resultGrid:dataGridCurrentPage", terminal: false, evidence: "next-page" as const },
  };
}

function statement(account: Account, pages: readonly (readonly Cells[])[]) {
  return assembleFubonLoanStatement(
    pages.map((rows, index) => page(rows, index, index === pages.length - 1 ? null : String(index + 2))),
    account,
    QUERY,
  );
}

// Expand each item's relation thunk so the golden pins the relation commands
// rather than the helper's "[function]" placeholder. The thunks ignore the
// commit value, so the stub commit's null stands in for it.
function expandRelationCommands(
  items: readonly PGliteWorkflowRunItem[],
): readonly PGliteWorkflowRunItem[] {
  return items.map((item) => (item.relationCommands
    ? { ...item, relationCommands: item.relationCommands(null) }
    : item) as PGliteWorkflowRunItem);
}

function workflowContext(recorder: ReturnType<typeof recordDepositCommit>): WorkflowContextWith<"financialCommit" | "accountIdentity"> {
  return {
    runId: "fubon-loan-golden",
    signal: new AbortController().signal,
    now: () => NOW,
    browser: {
      withPage: async <T>(run: (page: Page) => Promise<T>) =>
        run({ context: () => ({ clearCookies: async () => undefined }) } as unknown as Page),
    },
    text: strictSourceText,
    verification: { complete: async () => undefined },
    accountIdentity: { continuity: async () => ({ status: "unseen" }) },
    financialCommit: {
      execute: (items, options) => recorder.financialCommit.execute(expandRelationCommands(items), options),
    },
    event: recorder.event,
    signalEvent: recorder.signalEvent,
  };
}

async function runGolden(name: string, snapshot: FubonLoanSourceSnapshot): Promise<void> {
  const recorder = recordDepositCommit();
  const collectLoan: NonNullable<FubonAllWorkflowDependencies["collectLoan"]> = async (_page, input, _context, product) =>
    await stageFubonLoan(snapshot, input, product);
  const input = {
    managedIdentitySecret: "synthetic-fubon-loan-golden-secret",
    statementTypes: ["loan"],
    credentials: {
      fubon_user_id: "SYNTHETIC-FUBON-USER",
      fubon_account: "SYNTHETIC-FUBON-LOGIN",
      fubon_password: "synthetic-password",
    },
  };
  const result = await runVerifiedEntry(FUBON_SOURCE, fubonWorkflowWith({
    authenticate: async () => ({ usedExistingSession: false }),
    signOut: async () => undefined,
    startSessionKeepAlive: () => () => undefined,
    collectLoan,
  }), withBoundProducts(workflowContext(recorder), FUBON_SOURCE, input), input);
  await assertLoanCommitGolden(name, { result, ...recorder.recorded() });
}

const mortgageNumber = ["9990", "0000", "0001", "01"].join("");
const mortgage: Account = { value: "opaque-loan-a", label: `${mortgageNumber} (房屋貸款)` };
const personal: Account = { value: "opaque-loan-b", label: "**********0202 (信用貸款)" };

test("a selector account proves the repayment mandate; a masked one commits without evidence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("fubon-mandate-and-masked-accounts", {
    range: RANGE,
    accounts: [
      {
        statement: statement(mortgage, [
          [["2026/04/05", "還款", "12,500.00", "987,500.00"], ["2026/05/05", "繳息", "12,500.00", "975,000.00"]],
          [["2026/06/05", "本金還款", "50,000.00", "925,000.00"]],
        ]),
        observedAt: "2026-09-25T00:00:01.000Z",
      },
      {
        statement: statement(personal, [[["2026/08/10", "LOAN-PAYMENT", "3,000.00", "47,000.00"]]]),
        observedAt: "2026-09-25T00:00:02.000Z",
      },
    ],
  });
});
