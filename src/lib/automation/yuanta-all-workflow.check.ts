import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { PGliteWorkflowRunItem } from "../../ledger/pglite/workflow-run.ts";
import type { WorkflowContext } from "./workflow-executor.ts";
import type { runYuantaAllStatementsWorkflow as runYuantaAllStatementsWorkflowType } from "../../workflows/yuanta-all-statements.ts";
import { strictSourceText } from "./source-text.ts";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-yuanta-workflow-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const loaded = await server
  .ssrLoadModule("/src/workflows/yuanta-all-statements.ts")
  .finally(() => server.close());
const runYuantaAllStatementsWorkflow = loaded.runYuantaAllStatementsWorkflow as typeof runYuantaAllStatementsWorkflowType;

function item(product: string, value = "complete"): PGliteWorkflowRunItem {
  return {
    provider: "yuanta",
    product,
    itemKey: `${product}-capture-1`,
    command: {
      kind: "canonical.deposit.commit",
      request: { value },
    } as unknown as PGliteWorkflowRunItem["command"],
  };
}

function context(
  signal: AbortSignal,
  calls: string[],
  commitBatches: PGliteWorkflowRunItem[][] = [],
  text = strictSourceText,
): WorkflowContext {
  return {
    runId: "yuanta-test-run",
    signal,
    now: () => "2026-09-25T00:00:00.000Z",
    browser: {
      withPage: async <T>(run: (page: Page) => Promise<T>) => run({} as Page),
    },
    text,
    humanAssistance: {
      request: async (contract: { stageId?: string }, receivedSignal: AbortSignal) => {
        assert.equal(receivedSignal, signal);
        calls.push(`human:${contract.stageId}`);
        return "verified" as const;
      },
    },
    financialCommit: {
      execute: async (runItems: Iterable<PGliteWorkflowRunItem>) => {
        const collected = [...runItems];
        commitBatches.push(collected);
        calls.push("commit");
        return {
          status: "completed" as const,
          items: collected.map((entry) => ({
            itemKey: entry.itemKey,
            provider: entry.provider,
            product: entry.product,
            status: "committed" as const,
            admissionSummaries: [],
            value: null,
            relationWarnings: [],
          })),
          diagnostics: [],
          committedCount: collected.length,
          failedCount: 0,
        };
      },
    },
    event: async (stage, code) => { calls.push(`event:${stage}:${code}`); },
  };
}

const input = {
  managedIdentitySecret: "synthetic-yuanta-managed-secret",
  statementTypes: ["deposit", "foreign_currency", "credit_card", "loan", "fund"] as const,
  credentials: {
    yuanta_user_id: "synthetic-id",
    yuanta_account: "synthetic-account",
    yuanta_password: "synthetic-password",
  },
};

function collector(
  product: string,
  calls: string[],
  items?: PGliteWorkflowRunItem[],
) {
  return async (_page: Page, _input: unknown, _context: WorkflowContext, _identity: unknown, target: PGliteWorkflowRunItem[]) => {
    calls.push(`${product}-collected`);
    target.push(items?.find((entry) => entry.product === product) ?? item(product));
    return { sourceCount: 1, rowCount: 2, itemCount: 1 };
  };
}

const products = ["deposit", "foreign-currency-deposit", "credit-card", "loan", "investment"];
const productTypes = ["deposit", "foreign_currency", "credit_card", "loan", "fund"];

function collectors(calls: string[]) {
  return {
    authenticate: async (_page: Page, _credentials: unknown, workflowContext: WorkflowContext) => {
      const status = await workflowContext.humanAssistance.request(
        { stageId: "yuanta-bank-login-captcha" } as never,
        workflowContext.signal,
      );
      assert.equal(status, "verified");
      calls.push("authenticated");
    },
    collectDeposit: collector(products[0]!, calls),
    collectForeignCurrency: collector(products[1]!, calls),
    collectCreditCard: collector(products[2]!, calls),
    collectLoan: collector(products[3]!, calls),
    collectFund: collector(products[4]!, calls),
    prepareForComponent: async (_page: Page, product: string) => { calls.push(`prepared:${product}`); },
    assertSession: async () => undefined,
    signOut: async () => { calls.push("signed-out"); },
  };
}

const temp = await mkdtemp(join(tmpdir(), "yuanta-typed-workflow-"));
const originalCwd = process.cwd();
process.chdir(temp);
try {
  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const result = await runYuantaAllStatementsWorkflow(
      context(controller.signal, calls, batches),
      input,
      collectors(calls),
    );
    assert.deepEqual(result, {
      sourceCaptureCount: 5,
      rowCount: 10,
      itemCount: 5,
      committedCount: 5,
      skippedProductCount: 0,
      products: productTypes.map((typeId) => ({ typeId, status: "success", itemCount: 1, committedCount: 1 })),
      status: "financial-admitted",
    });
    assert.equal(batches.length, 5, "Yuanta commits each selected product independently");
    assert.deepEqual(
      batches.map((batch) => batch.map(({ product, itemKey }) => [product, itemKey])),
      products.map((product) => [[product, `${product}-capture-1`]]),
      "each commit contains only its product's completed evidence",
    );
    assert.ok(calls.includes("human:yuanta-bank-login-captcha"));
    assert.ok(calls.includes("event:authentication:authentication-completed"));
    assert.ok(calls.includes("event:validation:source-validation-completed"));
    assert.ok(calls.includes("event:commit:deposit-canonical-commit-completed"));
    assert.ok(calls.includes("event:commit:foreign-currency-canonical-commit-completed"));
    assert.ok(calls.includes("event:commit:credit-card-canonical-commit-completed"));
    assert.ok(calls.includes("event:commit:loan-canonical-commit-completed"));
    assert.ok(calls.includes("event:commit:fund-canonical-commit-completed"));
    assert.ok(calls.indexOf("investment-collected") < calls.lastIndexOf("commit"));
  }

  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const result = await runYuantaAllStatementsWorkflow(
        context(controller.signal, calls, batches),
        input,
        {
          ...collectors(calls),
          collectDeposit: async (_page, _input, _context, _identity, items) => {
            calls.push("deposit-collected");
            items.push(item("deposit"));
            return { sourceCount: 1, rowCount: 1, itemCount: 1 };
          },
          collectForeignCurrency: async () => {
            calls.push("foreign-currency-failed-after-deposit");
            throw new Error("foreign-currency export is incomplete");
          },
        },
      );
    assert.ok(calls.indexOf("deposit-collected") < calls.indexOf("foreign-currency-failed-after-deposit"));
    assert.equal(batches.length, 4, "a product error does not block later complete products");
    assert.deepEqual(result.products.map(({ typeId, status }) => [typeId, status]), [
      ["deposit", "success"], ["foreign_currency", "failed"], ["credit_card", "success"],
      ["loan", "success"], ["fund", "success"],
    ]);
    assert.equal(result.status, "partial");
  }

  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const workflowContext = context(controller.signal, calls, batches, {
      ...strictSourceText,
      assertIntact(value) {
        if (value.includes("\uFFFD")) throw new Error("Malformed Big5 source text.");
      },
    });
    const result = await runYuantaAllStatementsWorkflow(workflowContext, input, {
        ...collectors(calls),
        collectDeposit: async (_page, _input, _context, _identity, items) => {
          items.push(item("deposit", "bad\uFFFDsource"));
          return { sourceCount: 1, rowCount: 1, itemCount: 1 };
        },
      });
    assert.equal(batches.length, 4, "a malformed product staging group does not leak or block other products");
    assert.equal(result.products.find((product) => product.typeId === "deposit")?.status, "failed");
    assert.equal(result.status, "partial");
  }

  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const workflowContext = context(controller.signal, calls, batches);
    await assert.rejects(
      runYuantaAllStatementsWorkflow(workflowContext, input, {
        ...collectors(calls),
        collectDeposit: async (_page, _input, _context, _identity, items) => {
          items.push(item("deposit"));
          return { sourceCount: 1, rowCount: 1, itemCount: 1 };
        },
        collectForeignCurrency: async () => {
          controller.abort(new Error("cancelled"));
          return { sourceCount: 1, rowCount: 1, itemCount: 0 };
        },
      }),
      (error: unknown) => {
        const summary = (error as { summary?: { products?: readonly { typeId: string; status: string; committedCount: number }[] } }).summary;
        assert.deepEqual(summary?.products?.map(({ typeId, status, committedCount }) => [typeId, status, committedCount]), [
          ["deposit", "success", 1],
          ["foreign_currency", "failed", 0],
          ["credit_card", "skipped", 0],
          ["loan", "skipped", 0],
          ["fund", "skipped", 0],
        ]);
        return true;
      },
    );
    assert.equal(batches.length, 1, "receipts for a completed product are retained before cancellation");
  }

  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const result = await runYuantaAllStatementsWorkflow(
      context(controller.signal, calls, batches),
      { ...input, statementTypes: ["fund"] },
      {
        ...collectors(calls),
        collectDeposit: async () => { calls.push("deposit-called"); throw new Error("unselected"); },
        collectForeignCurrency: async () => { calls.push("foreign-called"); throw new Error("unselected"); },
        collectCreditCard: async () => { calls.push("card-called"); throw new Error("unselected"); },
        collectLoan: async () => { calls.push("loan-called"); throw new Error("unselected"); },
        collectFund: async (_page, _input, _context, _identity, items) => {
          calls.push("fund-called");
          items.push(item("investment"));
          return { sourceCount: 1, rowCount: 2, itemCount: 1 };
        },
      },
    );
    assert.deepEqual(calls.filter((call) => call.endsWith("-called")), ["fund-called"]);
    assert.deepEqual(result.products.map(({ typeId, status, skipReason }) => [typeId, status, skipReason]), [
      ["deposit", "skipped", "not_selected"],
      ["foreign_currency", "skipped", "not_selected"],
      ["credit_card", "skipped", "not_selected"],
      ["loan", "skipped", "not_selected"],
      ["fund", "success", undefined],
    ]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.[0]?.product, "investment");
  }

  assert.deepEqual(await readdir(temp), [], "typed Yuanta workflow must not write downloads or logs");
} finally {
  process.chdir(originalCwd);
  await rm(temp, { recursive: true, force: true });
}
