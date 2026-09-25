import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import {
  parsePostStatementResponse,
  postRowsToStatementRows,
  runPostProviderWorkflow,
  type PostQueriedStatement,
  type PostStatementResponseMetadata,
} from "../../workflows/post-statements.ts";
import { SourceTextIntegrityError, strictSourceText } from "./source-text.ts";
import type { WorkflowContext, WorkflowRunEvent } from "./workflow-executor.ts";

const providerSource = readFileSync(
  new URL("../../workflows/post-statements.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  providerSource,
  /from\s+["']libretto["']|librettoAuthenticate|export\s+default\s+workflow\s*\(|\bpause\(/u,
  "Post production must use the App-owned typed workflow only",
);
assert.doesNotMatch(
  providerSource,
  /node:fs\/promises|writeStatementFile|outputDir|downloads\/post-statements|csvFilename|jsonFilename|postStatementRowsToCsv/u,
  "Post production must not create statement files",
);
assert.doesNotMatch(
  providerSource,
  /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun/u,
  "Post must commit through the injected Canonical Financial Commit port",
);
assert.doesNotMatch(
  providerSource,
  /console\./u,
  "Post production must report progress through structured events",
);
assert.match(providerSource, /runPostProviderWorkflow/u);
assert.match(providerSource, /financialCommit\.execute\(/u);

const accountId = ["0311", "5240", "5293", "95"].join("");
const requestPostData = JSON.stringify({
  header: { TxnCode: "EB100200", BizCode: "inquire" },
  body: { _USER_ID: accountId, DATE: "20260201", END_DATE: "20260824" },
});
const screenEnvelope = {
  header: { EndBracket: false, OutputType: "Screen" },
  body: {
    host_rs_1: {
      ITEM: [{
        PRS_DATE: "20260802",
        TX_TIME: "091011",
        MEM: "薪資",
        TX_AMT: "100",
        BAL_AMT: "900",
        DR_FLG: "+",
      }],
    },
  },
};
const successEnvelope = {
  header: { EndBracket: false, OutputType: "EndBracket" },
  body: { result: "success" },
};
const responseMetadata: PostStatementResponseMetadata = {
  url: "https://ipost.post.gov.tw/pst/EsoafDispatcher",
  status: 200,
  method: "POST",
  contentType: "application/json; charset=utf-8",
  requestPostData,
};

const statement: PostQueriedStatement = {
  accountId,
  queryPeriods: ["2026/02/01~2026/08/24"],
  queryRange: { startDate: "2026/02/01", endDate: "2026/08/24" },
  httpStatus: 200,
  itemShape: "array",
  rows: postRowsToStatementRows(accountId, screenEnvelope.body.host_rs_1.ITEM),
};

test("Post statement source decode validates the endpoint and complete response before commit", () => {
  const completeBytes = Buffer.from(
    JSON.stringify([screenEnvelope, successEnvelope]),
    "utf8",
  );
  const parsed = parsePostStatementResponse({
    bytes: completeBytes,
    response: responseMetadata,
    text: strictSourceText,
  });

  assert.equal(parsed.accountId, accountId);
  assert.deepEqual(parsed.queryRange, {
    startDate: "2026/02/01",
    endDate: "2026/08/24",
  });
  assert.equal(parsed.httpStatus, 200);
  assert.equal(parsed.itemShape, "array");
  assert.deepEqual(parsed.rows[0]?.values, [
    "2026/08/02",
    "2026/08/02",
    "09:10:11",
    "薪資",
    "",
    "100",
    "900",
    "",
  ]);

  const malformedBytes = Buffer.from([
    0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
  ]);
  assert.throws(
    () => parsePostStatementResponse({
      bytes: malformedBytes,
      response: responseMetadata,
      text: strictSourceText,
    }),
    SourceTextIntegrityError,
  );
  assert.throws(
    () => parsePostStatementResponse({
      bytes: completeBytes,
      response: { ...responseMetadata, status: 503 },
      text: strictSourceText,
    }),
    /not terminal/u,
  );
  assert.throws(
    () => parsePostStatementResponse({
      bytes: Buffer.from(JSON.stringify([screenEnvelope]), "utf8"),
      response: responseMetadata,
      text: strictSourceText,
    }),
    /incomplete/u,
  );
  assert.throws(
    () => parsePostStatementResponse({
      bytes: completeBytes,
      response: { ...responseMetadata, contentType: "text/html; charset=utf-8" },
      text: strictSourceText,
    }),
    /content type/u,
  );
  assert.throws(
    () => parsePostStatementResponse({
      bytes: completeBytes,
      response: { ...responseMetadata, url: "https://example.test/pst/EsoafDispatcher" },
      text: strictSourceText,
    }),
    /endpoint/u,
  );
  assert.throws(
    () => parsePostStatementResponse({
      bytes: completeBytes,
      response: { ...responseMetadata, method: "GET" },
      text: strictSourceText,
    }),
    /method/u,
  );
  assert.throws(
    () => parsePostStatementResponse({
      bytes: Buffer.from(JSON.stringify([
        {
          ...screenEnvelope,
          body: {
            host_rs_1: {
              ITEM: [{ ...screenEnvelope.body.host_rs_1.ITEM[0], DR_FLG: "?" }],
            },
          },
        },
        successEnvelope,
      ]), "utf8"),
      response: responseMetadata,
      text: strictSourceText,
    }),
    /unsupported transaction direction/u,
  );
});

function createPage(signedInInitially: boolean): Page & { setSignedIn(value: boolean): void } {
  let signedIn = signedInInitially;
  const locator = (selector: string) => {
    const self = {
      first() { return this; },
      filter() { return this; },
      nth() { return this; },
      isVisible: async () => selector === "a.btn_td_orange_dtl:visible" && signedIn,
      waitFor: async () => {
        if (selector === "a.btn_td_orange_dtl:visible") signedIn = true;
      },
      fill: async () => undefined,
      focus: async () => undefined,
      click: async () => undefined,
      isChecked: async () => true,
      count: async () => 1,
      inputValue: async () => "1234",
      evaluate: async () => true,
      elementHandle: async () => ({ dispose: async () => undefined }),
      boundingBox: async () => ({ x: 10, y: 10, width: 100, height: 24 }),
    };
    return self;
  };
  return Object.assign({
    on: () => undefined,
    off: () => undefined,
    locator,
    goto: async () => undefined,
    url: () => "https://ipost.post.gov.tw/pst/home.html",
  }, { setSignedIn(value: boolean) { signedIn = value; } }) as unknown as Page & {
    setSignedIn(value: boolean): void;
  };
}

function createContext(input: {
  page: Page & { setSignedIn(value: boolean): void };
  signal?: AbortSignal;
  assistance?: (
    contract: Parameters<WorkflowContext["humanAssistance"]["request"]>[0],
    signal: AbortSignal,
  ) => Promise<"entered" | "verified" | "failed">;
}) {
  const events: WorkflowRunEvent[] = [];
  const committed: unknown[][] = [];
  const context: WorkflowContext = {
    runId: "run-post-check",
    signal: input.signal ?? new AbortController().signal,
    now: () => "2026-09-25T12:00:00.000Z",
    browser: {
      async withPage(run) {
        return run(input.page);
      },
    },
    text: strictSourceText,
    humanAssistance: {
      async request(contract, signal) {
        assert.equal(contract.stageId, "ipost-login-captcha");
        return input.assistance?.(contract, signal) ?? "verified";
      },
    },
    financialCommit: {
      async execute(items) {
        const materialized = [];
        for await (const item of items) materialized.push(item);
        committed.push(materialized);
        return {
          status: "completed",
          items: materialized.map((item) => ({
            itemKey: item.itemKey,
            provider: item.provider,
            product: item.product,
            status: "committed" as const,
            admissionSummaries: [],
            value: null,
            relationWarnings: [],
          })),
          diagnostics: [],
          committedCount: materialized.length,
          failedCount: 0,
        };
      },
    },
    async event(stage, code, counts) {
      events.push({
        runId: "run-post-check",
        stage,
        code,
        occurredAt: "2026-09-25T12:00:00.000Z",
        ...counts,
      });
    },
  };
  return { context, events, committed };
}

const workflowInput = {
  credentials: {
    post_user_id: "synthetic-user-id",
    post_account: "synthetic-user-account",
    post_password: "synthetic-password",
  },
};

test("Post typed workflow gets human assistance, admits complete source, and commits once without files", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "post-typed-workflow-"));
  const previousDirectory = process.cwd();
  const page = createPage(false);
  const harness = createContext({
    page,
    assistance: async (_contract, signal) => {
      assert.equal(signal.aborted, false);
      page.setSignedIn(true);
      return "verified";
    },
  });
  let sourceCount = 0;
  try {
    process.chdir(outputDir);
    const result = await runPostProviderWorkflow(harness.context, workflowInput, {
      collectSourceStatements: async (_page, text, signal, event) => {
        assert.equal(text, strictSourceText);
        assert.equal(signal, harness.context.signal);
        assert.equal(harness.committed.length, 0, "commit waits for full source admission");
        sourceCount += 1;
        await event?.("collection", "collection-started", { completed: 0, total: 1 });
        await event?.("decoding", "source-decoding-completed", { completed: 1, total: 1 });
        return [statement];
      },
      readCurrentDepositBalances: async () => [],
    });

    assert.equal(result.status, "financial-admitted");
    assert.equal(result.accountCount, 1);
    assert.equal(result.rowCount, 1);
    assert.equal(sourceCount, 1);
    assert.equal(harness.committed.length, 1);
    assert.ok(harness.committed[0]?.length);
    assert.ok(harness.events.some((event) => event.code === "human-assistance-requested"));
    assert.ok(harness.events.some((event) => event.code === "human-assistance-completed"));
    assert.ok(harness.events.some((event) => event.stage === "decoding" && event.code === "source-decoding-completed"));
    assert.ok(harness.events.some((event) => event.stage === "commit" && event.code === "canonical-commit-completed"));
    assert.deepEqual(await readdir(outputDir), []);
  } finally {
    process.chdir(previousDirectory);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Post typed workflow rejects malformed and incomplete source before Canonical Financial Commit", async () => {
  const page = createPage(true);
  const harness = createContext({ page });
  const malformedBytes = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28]);
  await assert.rejects(
    runPostProviderWorkflow(harness.context, workflowInput, {
      collectSourceStatements: async (_page, text) => [parsePostStatementResponse({
        bytes: malformedBytes,
        response: responseMetadata,
        text,
      })],
      readCurrentDepositBalances: async () => [],
    }),
    SourceTextIntegrityError,
  );
  assert.equal(harness.committed.length, 0);

  await assert.rejects(
    runPostProviderWorkflow(harness.context, workflowInput, {
      collectSourceStatements: async (_page, text) => [parsePostStatementResponse({
        bytes: Buffer.from(JSON.stringify([screenEnvelope]), "utf8"),
        response: responseMetadata,
        text,
      })],
      readCurrentDepositBalances: async () => [],
    }),
    /incomplete/u,
  );
  assert.equal(harness.committed.length, 0);

  await assert.rejects(
    runPostProviderWorkflow(harness.context, workflowInput, {
      collectSourceStatements: async () => [{ ...statement, rows: [] }],
      readCurrentDepositBalances: async () => [],
    }),
    /source admission blocked/u,
  );
  assert.equal(harness.committed.length, 0);

  await assert.rejects(
    runPostProviderWorkflow(harness.context, workflowInput, {
      collectSourceStatements: async (_page, text) => [parsePostStatementResponse({
        bytes: Buffer.from(JSON.stringify([
          {
            ...screenEnvelope,
            body: {
              host_rs_1: {
                ITEM: [{ ...screenEnvelope.body.host_rs_1.ITEM[0], DR_FLG: "?" }],
              },
            },
          },
          successEnvelope,
        ]), "utf8"),
        response: responseMetadata,
        text,
      })],
      readCurrentDepositBalances: async () => [],
    }),
    /unsupported transaction direction/u,
  );
  assert.equal(harness.committed.length, 0);
});

test("Post typed workflow cancellation during human assistance stops before collection and commit", async () => {
  const controller = new AbortController();
  const page = createPage(false);
  let sourceCount = 0;
  const harness = createContext({
    page,
    signal: controller.signal,
    assistance: async (_contract, signal) => await new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      controller.abort(new Error("Post assistance cancelled"));
    }),
  });
  await assert.rejects(
    runPostProviderWorkflow(harness.context, workflowInput, {
      collectSourceStatements: async () => {
        sourceCount += 1;
        return [statement];
      },
      readCurrentDepositBalances: async () => [],
    }),
    /Post assistance cancelled/u,
  );
  assert.equal(sourceCount, 0);
  assert.equal(harness.committed.length, 0);
  assert.ok(harness.events.some((event) => event.code === "human-assistance-requested"));
});
