import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Page } from "playwright";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { assertCreditCardCommitGolden, recordDepositCommit, withCountedUuids } from "./deposit-commit-golden.ts";
import type { YuantaAllWorkflowDependencies } from "./yuanta-all-statements.ts";
import type { YuantaCreditCardSourceSnapshot } from "./yuanta-credit-card-statements.ts";

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

const { yuantaWorkflowWith } = await import("./yuanta-all-statements.ts");
const { runVerifiedEntry } = await import("../lib/automation/server/verified-entry.ts");
const { withBoundProducts } = await import("../lib/automation/product-collection.fixtures.ts");
const { YUANTA_SOURCE } = await import("../lib/automation/server/sources/yuanta.ts");
const { stageYuantaCreditCard } = await import("./yuanta-credit-card-statements.ts");

const NOW = "2026-09-10T03:00:00.000Z";

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

/** A page already signed in to Yuanta Bank, as the shared signed-in probe reads it. */
function signedInPage(): Page {
  const frame = (name: string) => ({
    name: () => name,
    url: () => "https://ebank.yuantabank.com.tw/nib/tx/home",
    locator: () => ({ count: async () => 1 }),
  });
  const frames = [frame("fmenu"), frame("fmain")];
  return {
    url: () => "https://ebank.yuantabank.com.tw/nib/tx/home",
    frames: () => frames,
    frame: ({ name }: { name: string }) => frames.find((candidate) => candidate.name() === name) ?? null,
  } as unknown as Page;
}

function workflowContext(recorder: ReturnType<typeof recordDepositCommit>, now: string): WorkflowContextWith<"financialCommit"> {
  return {
    runId: "yuanta-credit-card-golden",
    signal: new AbortController().signal,
    now: () => now,
    browser: { withPage: async <T>(run: (page: Page) => Promise<T>) => run(signedInPage()) },
    text: strictSourceText,
    verification: { complete: async () => undefined },
    financialCommit: {
      execute: (items, options) => recorder.financialCommit.execute(expandRelationCommands(items), options),
    },
    event: recorder.event,
    signalEvent: recorder.signalEvent,
  };
}


async function runGolden(name: string, snapshot: YuantaCreditCardSourceSnapshot, now = NOW): Promise<void> {
  return withCountedUuids(() => recordGolden(name, snapshot, now));
}

async function recordGolden(name: string, snapshot: YuantaCreditCardSourceSnapshot, now: string): Promise<void> {
  const recorder = recordDepositCommit();
  const collectCreditCard: NonNullable<YuantaAllWorkflowDependencies["collectCreditCard"]> = async (
    _page, input, context, product,
  ) => stageYuantaCreditCard(snapshot, input, context, product);
  const input = {
    managedIdentitySecret: "synthetic-yuanta-golden-secret",
    statementTypes: ["credit_card"],
    credentials: {
      yuanta_user_id: "SYNTHETIC-YUANTA-USER",
      yuanta_account: "SYNTHETIC-YUANTA-LOGIN",
      yuanta_password: "synthetic-password",
    },
  };
  const result = await runVerifiedEntry(YUANTA_SOURCE, yuantaWorkflowWith({
    signOut: async () => undefined,
    collectCreditCard,
  }), withBoundProducts(workflowContext(recorder, now), YUANTA_SOURCE, input), input);
  await assertCreditCardCommitGolden(name, { result, ...recorder.recorded() });
}

const periods = ["115/01", "115/02", "115/03", "115/04", "115/05", "115/06"];
const monthOptions = periods.map((label, index) => ({ index, label }));
const historyIssuerSummaries = periods.map((period, index) => {
  const closeMonth = String(index + 1).padStart(2, "0");
  const dueMonth = String(index + 2).padStart(2, "0");
  return {
    period,
    closeDate: `2026-${closeMonth}-20`,
    issueDate: `2026-${closeMonth}-21`,
    dueDate: `2026-${dueMonth}-05`,
    balance: "1000",
    minimumPayment: "100",
  };
});
const billedRows = periods.map((period, index) => ({
  creditCardNo: "9999-99**-****-0101",
  creditCardName: "SYNTHETIC PRIMARY CARD",
  consumeDate: `2026-0${index + 1}-02`,
  postedDate: `2026-0${index + 1}-03`,
  description: `BILLED ${period}`,
  countryCurrency: "台灣/TWD",
  foreignExchangeDate: "",
  foreignAmount: "",
  twdAmount: "100.00",
  paymentStatus: "已繳",
  period,
}));
const unbilledRows = [{
  ...billedRows[0]!,
  consumeDate: "2026-07-02",
  postedDate: "2026-07-03",
  description: "UNBILLED PURCHASE",
  twdAmount: "-25.00",
  paymentStatus: "",
  period: null,
}];
const fullSnapshot: YuantaCreditCardSourceSnapshot = {
  allMonthOptions: monthOptions,
  selectedMonthOptions: monthOptions,
  billedRows,
  billedHistoryPages: historyIssuerSummaries.map((summary, index) => ({
    sourceKey: "yuanta-credit-card.queryHistoryDetail.settled-summary-v2" as const,
    monthIndex: index,
    pageOrdinal: index,
    summary,
  })),
  terminalPages: [true, true, true, true, true, true, true],
  unbilledRows,
};
const currentUsedCredit = {
  limit: "100000",
  usedCredit: "12345",
  available: "87655",
  sourceField: "已使用額度" as const,
  endpoint: "https://ebank.yuantabank.com.tw/nib/tx/creditcardsummary",
  httpDate: "Thu, 10 Sep 2026 02:03:04 GMT",
  cacheControl: "no-store",
};

test("a full read with current used credit commits the card and its current balance", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("yuanta-card-with-current-used-credit", { ...fullSnapshot, currentUsedCredit });
});

// 01:30 in Taipei is still the previous day in UTC, for the run clock and the HTTP Date alike.
const EARLY_MORNING = "2026-09-09T17:30:00.000Z";
test("current used credit read at 01:30 Taipei is scoped to the Taipei day", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(EARLY_MORNING) });
  await runGolden("yuanta-card-current-used-credit-taipei-early-morning", {
    ...fullSnapshot,
    currentUsedCredit: { ...currentUsedCredit, httpDate: "Wed, 09 Sep 2026 17:30:00 GMT" },
  }, EARLY_MORNING);
});

test("a full read without current used credit commits only the card", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("yuanta-card-without-current-used-credit", fullSnapshot);
});
