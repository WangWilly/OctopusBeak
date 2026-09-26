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
      status: "financial-admitted",
    });
    assert.equal(batches.length, 1, "Yuanta must invoke injected canonical admission exactly once");
    assert.deepEqual(
      batches[0]?.map(({ product, itemKey }) => [product, itemKey]),
      products.map((product) => [product, `${product}-capture-1`]),
      "the one commit receives the completed source set from every selected product",
    );
    assert.ok(calls.includes("human:yuanta-bank-login-captcha"));
    assert.ok(calls.includes("event:authentication:authentication-completed"));
    assert.ok(calls.includes("event:validation:source-validation-completed"));
    assert.ok(calls.includes("event:commit:canonical-commit-completed"));
    assert.ok(calls.indexOf("investment-collected") < calls.indexOf("commit"));
  }

  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    await assert.rejects(
      runYuantaAllStatementsWorkflow(
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
      ),
      /export is incomplete/u,
    );
    assert.ok(calls.indexOf("deposit-collected") < calls.indexOf("foreign-currency-failed-after-deposit"));
    assert.equal(batches.length, 0, "a later selected export failure must happen before any commit");
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
    await assert.rejects(
      runYuantaAllStatementsWorkflow(workflowContext, input, {
        ...collectors(calls),
        collectDeposit: async (_page, _input, _context, _identity, items) => {
          items.push(item("deposit", "bad\uFFFDsource"));
          return { sourceCount: 1, rowCount: 1, itemCount: 1 };
        },
      }),
      /Malformed Big5 source text/u,
    );
    assert.equal(batches.length, 0, "malformed decoded text must be rejected before commit");
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
    );
    assert.equal(batches.length, 0, "cancellation must not admit already-collected products");
  }

  assert.deepEqual(await readdir(temp), [], "typed Yuanta workflow must not write downloads or logs");
} finally {
  process.chdir(originalCwd);
  await rm(temp, { recursive: true, force: true });
}
