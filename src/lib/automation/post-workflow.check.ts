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
  stagePostDeposit,
  type PostQueriedStatement,
  type PostReadCurrentDepositBalances,
  type PostStatementResponseMetadata,
  type PostWorkflowDependencies,
} from "../../workflows/post-statements.ts";
import type { PostCurrentDepositBalanceRow } from "../../workflows/post-current-deposit-balances.ts";
import type { ProductCollectionHandle, ProductStageRequest } from "./product-collection.ts";
import { SourceTextIntegrityError, strictSourceText, type SourceTextPort } from "./source-text.ts";
import type { WorkflowContextWith, WorkflowFinancialCommitPort } from "./workflow-executor.ts";
import { POST_SOURCE } from "./server/sources/post.ts";
import { withBoundProducts } from "./product-collection.fixtures.ts";
import { signalRunEvent, type WorkflowRunEvent } from "./run-event.ts";
import {
  assertProductFailure,
  assertStoppedRun,
  STOPPED_COMMITS,
  stoppedCommitPort,
} from "./single-product-run.fixtures.ts";

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
  assistance?: () => Promise<void>;
  financialCommit?: WorkflowFinancialCommitPort;
}) {
  const events: WorkflowRunEvent[] = [];
  const committed: unknown[][] = [];
  const context: WorkflowContextWith<"financialCommit"> = {
    runId: "run-post-check",
    signal: input.signal ?? new AbortController().signal,
    now: () => "2026-09-25T12:00:00.000Z",
    browser: {
      async withPage(run) {
        return run(input.page);
      },
    },
    text: strictSourceText,
    verification: {
      async complete(stage) {
        assert.equal(stage.stageId, "ipost-login-captcha");
        await input.assistance?.();
      },
    },
    financialCommit: input.financialCommit ?? {
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
    async event(stage, outcome, code, counts) {
      events.push({
        runId: "run-post-check",
        stage,
        outcome,
        code,
        occurredAt: "2026-09-25T12:00:00.000Z",
        ...counts,
      });
    },
    async signalEvent(signal) {
      events.push(signalRunEvent(signal, { runId: "run-post-check", occurredAt: "2026-09-25T12:00:00.000Z" }));
    },
  };
  return { context: withBoundProducts(context, POST_SOURCE, workflowInput), events, committed };
}

const workflowInput = {
  credentials: {
    post_user_id: "synthetic-user-id",
    post_account: "synthetic-user-account",
    post_password: "synthetic-password",
  },
  statementTypes: ["deposit" as const],
};

const observedAt = "2026-09-25T20:00:00+08:00";

/** Run the real build half on statements the read would have returned. */
function depositReading(
  read: (text: SourceTextPort) => PostQueriedStatement[],
  onRead: () => void = () => undefined,
): PostWorkflowDependencies {
  return {
    collectDeposit: async (_page, input, context, product) => {
      onRead();
      return await stagePostDeposit(
        { observedAt, statements: read(context.text) },
        input,
        context,
        product,
        async () => [],
      );
    },
  };
}

function currentBalance(account: string, coefficient: string): PostCurrentDepositBalanceRow {
  return {
    source: "post",
    stream: "domestic-deposit",
    accountNumber: account,
    sourceAccountKey: account,
    currency: "TWD",
    ledger: { coefficient, scale: 0, sourceLexeme: coefficient },
    effectiveAt: "2026-09-25T11:59:00.000Z",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    effectiveTimeSourceValue: "Fri, 25 Sep 2026 11:59:00 GMT",
    providerHttpDate: "Fri, 25 Sep 2026 11:59:00 GMT",
    observedAt,
    sourceEvidence: {
      endpoint: "/pst/EsoafDispatcher",
      status: 200,
      contentType: "application/json; charset=UTF-8",
      cacheControl: "no-store",
      txnCode: "EB100103",
      bizCode: "getOverViewById",
      pageCount: 50,
      contractVersion: "post/current-deposit-balance-v1",
    },
  };
}

async function stageSnapshot(
  statements: readonly PostQueriedStatement[],
  readCurrentBalances: PostReadCurrentDepositBalances,
) {
  const { context } = createContext({ page: createPage(true) });
  const staged: ProductStageRequest[] = [];
  const codes: string[] = [];
  const product: ProductCollectionHandle = {
    stage: (...requests) => { staged.push(...requests); },
    reportActivity: async () => undefined,
    event: async (_stage, _outcome, code) => { codes.push(code); },
    collectionPeriod: () => assert.fail("Post declares no collection period"),
  };
  const outcome = await stagePostDeposit(
    { observedAt, statements },
    workflowInput,
    context,
    product,
    readCurrentBalances,
  ).catch((error: unknown) => error);
  return { outcome, staged, codes };
}

test("Post deposit build stages each admitted account and its matched current balance", async () => {
  let reads = 0;
  const result = await stageSnapshot([statement], async (input) => {
    reads += 1;
    assert.deepEqual(input, { observedAt });
    return [currentBalance(accountId, "900")];
  });
  assert.deepEqual(result.outcome, { sourceCaptureCount: 1, rowCount: 1 });
  assert.equal(reads, 1);
  assert.deepEqual(result.staged.map((item) => item.product), ["domestic-deposit", "current-balance"]);
  assert.deepEqual(result.codes, [
    "source-validation-completed",
    "current-balance-collection-started",
    "current-balance-validation-completed",
  ]);
});

test("Post deposit build stages nothing when the read or the current balances fail", async () => {
  const empty = await stageSnapshot([], async () => {
    throw new Error("an empty read must not read current balances");
  });
  assert.match(String(empty.outcome), /No Post accounts reached a terminal source result/u);
  assert.deepEqual([empty.staged, empty.codes], [[], []]);

  const rejected = await stageSnapshot([statement], async () => {
    throw new Error("overview unavailable");
  });
  assert.match(String(rejected.outcome), /overview unavailable/u);
  assert.deepEqual(rejected.staged, []);
  assert.equal(rejected.codes.at(-1), "current-balance-rejected");

  const unknown = await stageSnapshot([statement], async () => [currentBalance("99990000000009", "1")]);
  assert.match(String(unknown.outcome), /without an existing admitted identity/u);
  assert.deepEqual(unknown.staged, []);
});

test("Post typed workflow gets human assistance, admits complete source, and commits once without files", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "post-typed-workflow-"));
  const previousDirectory = process.cwd();
  const page = createPage(false);
  let assisted = 0;
  const harness = createContext({
    page,
    assistance: async () => {
      assisted += 1;
      page.setSignedIn(true);
    },
  });
  let sourceCount = 0;
  try {
    process.chdir(outputDir);
    const result = await runPostProviderWorkflow(harness.context, workflowInput, depositReading((text) => {
      assert.equal(text, strictSourceText);
      assert.equal(harness.committed.length, 0, "commit waits for full source admission");
      sourceCount += 1;
      return [statement];
    }));

    assert.deepEqual(result, {
      status: "financial-admitted",
      counts: { sourceCaptureCount: 1, rowCount: 1, itemCount: 1, committedCount: 1, accountCount: 1 },
      products: [{ typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 }],
    });
    assert.equal(sourceCount, 1);
    assert.equal(harness.committed.length, 1);
    assert.ok(harness.committed[0]?.length);
    assert.equal(assisted, 1);
    assert.ok(harness.events.some((event) => event.stage === "validation" && event.code === "source-validation-completed"));
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
    runPostProviderWorkflow(harness.context, workflowInput, depositReading((text) => [parsePostStatementResponse({
      bytes: malformedBytes,
      response: responseMetadata,
      text,
    })])),
    assertProductFailure("source-integrity-failed", SourceTextIntegrityError),
  );
  assert.equal(harness.committed.length, 0);

  await assert.rejects(
    runPostProviderWorkflow(harness.context, workflowInput, depositReading((text) => [parsePostStatementResponse({
      bytes: Buffer.from(JSON.stringify([screenEnvelope]), "utf8"),
      response: responseMetadata,
      text,
    })])),
    assertProductFailure("source-collection-failed", /incomplete/u),
  );
  assert.equal(harness.committed.length, 0);

  await assert.rejects(
    runPostProviderWorkflow(harness.context, workflowInput, depositReading(() => [{ ...statement, rows: [] }])),
    assertProductFailure("source-collection-failed", /source admission blocked/u),
  );
  assert.equal(harness.committed.length, 0);

  await assert.rejects(
    runPostProviderWorkflow(harness.context, workflowInput, depositReading((text) => [parsePostStatementResponse({
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
    })])),
    assertProductFailure("source-collection-failed", /unsupported transaction direction/u),
  );
  assert.equal(harness.committed.length, 0);
});

for (const { stop, errorCode } of STOPPED_COMMITS) {
  test(`Post names a ${stop} commit ${errorCode}`, async () => {
    const harness = createContext({ page: createPage(true), financialCommit: stoppedCommitPort(stop) });
    await assert.rejects(runPostProviderWorkflow(harness.context, workflowInput,
      depositReading(() => [statement])), assertStoppedRun("deposit", 1, errorCode));
  });
}

test("Post typed workflow cancellation during human assistance stops before collection and commit", async () => {
  const controller = new AbortController();
  const page = createPage(false);
  let sourceCount = 0;
  const harness = createContext({
    page,
    signal: controller.signal,
    assistance: async () => {
      controller.abort(new Error("Post assistance cancelled"));
      throw controller.signal.reason;
    },
  });
  await assert.rejects(
    runPostProviderWorkflow(harness.context, workflowInput, depositReading(() => [statement], () => {
      sourceCount += 1;
    })),
    /Post assistance cancelled/u,
  );
  assert.equal(sourceCount, 0);
  assert.equal(harness.committed.length, 0);
});
