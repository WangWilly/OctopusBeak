import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import {
  downloadCurrentStatementInMemory,
  parseStatementExport,
  readHncbDepositSource,
  runHncbStatements,
  stageHncbDeposit,
  type HncbDepositRunner,
  type HncbDepositSource,
  type HncbStatementDownload,
  type HncbStatementsContext,
} from "../../workflows/hncb-statements.ts";
import { SourceTextIntegrityError, strictSourceText } from "./source-text.ts";
import type { WorkflowContext, WorkflowContextWith, WorkflowFinancialCommitPort } from "./workflow-executor.ts";
import { ProductCollectionInterruptedError } from "./product-collection.ts";
import { withBoundProducts } from "./product-collection.fixtures.ts";
import { HNCB_SOURCE } from "./server/sources/hncb.ts";

const account = "123456";
// CP950 fixture bytes exercise the mapping used by the browser's WHATWG
// "big5" decoder for HNCB's Traditional Chinese Excel-labelled HTML export.
const exportBytes = Buffer.from(
  "PCFkb2N0eXBlIGh0bWw+PGh0bWw+PGJvZHk+CiAgPHRhYmxlPjx0cj48dGQ+sWK4uTwvdGQ+PHRkPjEyMzQ1NjwvdGQ+PC90cj4KICAgIDx0cj48dGQ+uOquxrBfsFek6TwvdGQ+PHRkPjIwMjYvMDgvMDEtMjAyNi8wOC8zMTwvdGQ+PC90cj4KICAgIDx0cj48dGQ+ufSnTzwvdGQ+PHRkPlRXRDwvdGQ+PC90cj4KICAgIDx0cj48dGQ+peap9qTptME8L3RkPjx0ZD6l5qn2rsm2oTwvdGQ+PHRkPrFisMik6bTBPC90ZD48dGQ+ufSnTzwvdGQ+CiAgICA8dGQ+pOSlWKr3w0I8L3RkPjx0ZD6mc6RKqvfDQjwvdGQ+PHRkPqdZrsm+bMNCPC90ZD48dGQ+ukutbjwvdGQ+CiAgICA8dGQ+pnO02qRIpU64uTwvdGQ+PHRkPrPGtfk8L3RkPjx0ZD64ybpQpOm0wS+yvL7auLm9WDwvdGQ+PC90cj4KICAgIDx0cj48dGQ+MjAyNi8wOC8wMjwvdGQ+PHRkPjA5OjEwOjExPC90ZD48dGQ+MjAyNi8wOC8wMzwvdGQ+PHRkPlRXRDwvdGQ+CiAgICAgIDx0ZD4xMDA8L3RkPjx0ZD48L3RkPjx0ZD45MDA8L3RkPjx0ZD5maXh0dXJlPC90ZD48dGQ+PC90ZD48dGQ+PC90ZD48dGQ+PC90ZD48L3RyPgogIDwvdGFibGU+CjwvYm9keT48L2h0bWw+".replace(/\s/gu, ""),
  "base64",
);
const parsedFixture = parseStatementExport(strictSourceText.decode(exportBytes, "big5"), account);
assert.equal(parsedFixture.queryPeriod, "2026/08/01-2026/08/31");
assert.equal(parsedFixture.currency, "TWD");

/** The real read and build halves over one account whose query opens `download`, with no current balances. */
function oneAccount(download: () => Promise<HncbStatementDownload>): HncbDepositRunner {
  const source: HncbDepositSource = {
    accounts: async () => [{ value: account, label: `HNCB ${account}` }],
    query: async () => ({ download }),
  };
  return async (_page, input, context, product) => await stageHncbDeposit(
    await readHncbDepositSource(source, input, context, product),
    context,
    product,
    async () => [],
  );
}

/** A deposit-only HNCB run, its Product collection run bound to HNCB_SOURCE as the executor binds it. */
function runContext(
  financialCommit: WorkflowFinancialCommitPort,
  overrides: Partial<Pick<WorkflowContext, "signal" | "event">> = {},
): HncbStatementsContext {
  const context = {
    signal: new AbortController().signal,
    text: strictSourceText,
    event: async () => undefined,
    financialCommit,
    ...overrides,
  } as Pick<WorkflowContext, "signal" | "text" | "event"> as WorkflowContextWith<"financialCommit">;
  return withBoundProducts(context, HNCB_SOURCE, { statementTypes: ["deposit"] });
}

function reply(response: ServerResponse, status: number, body: string | Buffer): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    ...(typeof body === "string" ? {} : { "content-length": body.byteLength }),
  });
  response.end(body);
}

test("HNCB export is parsed from the one cookie-authenticated POST without a browser download artifact", async () => {
  let postCount = 0;
  let requestCookie = "";
  let responseBody: Buffer = exportBytes;
  let responseStatus = 200;
  let responseContentType = "application/vnd.ms-excel; charset=big5";
  let responseDisposition = 'attachment; filename="bank-export.xls"';
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === "/start") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "hncb-session=fixture; Path=/; HttpOnly; SameSite=Lax",
      });
      response.end("<!doctype html><html><body></body></html>");
      return;
    }
    if (request.url?.startsWith("/popup")) {
      reply(response, 200, `<!doctype html><html><body>
        <form method="POST" action="/netbank/servlet/TrxDispatcher?export=1">
          <input name="excel_download" value="52">
        </form>
        <script>window.doSubmit = () => { console.info("hncb-export-submit"); setTimeout(() => document.forms[0].submit(), 0); };</script>
      </body></html>`);
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/netbank/servlet/TrxDispatcher")) {
      postCount += 1;
      requestCookie = request.headers.cookie ?? "";
      response.writeHead(responseStatus, {
        "content-type": responseContentType,
        "content-disposition": responseDisposition,
        ...(responseBody.byteLength > 0 ? { "content-length": responseBody.byteLength } : {}),
      });
      response.end(responseBody);
      return;
    }
    reply(response, 404, "not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  let downloadEvents = 0;
  let browserSubmissions = 0;
  let submitInvocations = 0;
  const workingDirectory = await mkdtemp(join(tmpdir(), "hncb-memory-workflow-"));
  const previousWorkingDirectory = process.cwd();
  try {
    process.chdir(workingDirectory);
    const page = await browser.newPage();
    page.on("popup", (popup) => {
      popup.on("download", () => { downloadEvents += 1; });
      popup.on("console", (message) => {
        if (message.text() === "hncb-export-submit") submitInvocations += 1;
      });
      popup.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/netbank/servlet/TrxDispatcher"))
          browserSubmissions += 1;
      });
    });
    await page.goto(`${origin}/start`);
    const openExportLink = async () => {
      await page.setContent(`<a target="_blank" href="${origin}/popup?doSubmit=5">匯出</a>`);
    };
    const commitItems: unknown[][] = [];
    const financialCommit: WorkflowFinancialCommitPort = {
      async execute(items) {
        const received = [];
        for await (const item of items) received.push(item);
        commitItems.push(received);
        return {
          status: "completed",
          items: received.map((item) => ({
            itemKey: item.itemKey,
            provider: item.provider,
            product: item.product,
            status: "committed" as const,
            admissionSummaries: [],
            value: null,
            relationWarnings: [],
          })),
          diagnostics: [],
          committedCount: received.length,
          failedCount: 0,
        };
      },
    };
    const events: Array<{ stage: string; code: string }> = [];
    let statementResponse: { status: number; contentType: string } | undefined;
    let statementDigest: string | undefined;
    let statementByteLength = -1;
    await openExportLink();
    const context = runContext(financialCommit, {
      event: async (stage, _outcome, code) => { events.push({ stage, code }); },
    });
    const output = await runHncbStatements(page, {
      startDate: "2026/08/01",
      endDate: "2026/08/31",
      accountFilters: [],
    }, context, {
      collectDeposit: oneAccount(async () => {
        const statement = await downloadCurrentStatementInMemory(
          page,
          `HNCB ${account}`,
          page.mainFrame(),
          context.text,
          context.signal,
          5_000,
        );
        statementResponse = statement.sourceResponse;
        statementDigest = statement.contentDigest;
        statementByteLength = statement.byteLength;
        return statement;
      }),
    });

    assert.equal(output.status, "financial-admitted");
    assert.equal(output.counts.accountCount, 1);
    assert.equal(statementResponse?.status, 200);
    assert.equal(statementResponse?.contentType, "application/vnd.ms-excel; charset=big5");
    assert.equal(postCount, 1);
    assert.equal(browserSubmissions, 1, "the export form is submitted once in the browser");
    assert.equal(submitInvocations, 1, "the provider's export submit action is invoked once");
    assert.equal(commitItems.length, 1);
    assert.equal(commitItems[0]?.length, 1);
    assert.equal(downloadEvents, 0);
    assert.deepEqual(await readdir(workingDirectory), []);

    assert.match(requestCookie, /hncb-session=fixture/u);
    assert.equal(
      statementDigest,
      `sha256:${createHash("sha256").update(exportBytes).digest("base64url")}`,
    );
    assert.equal(statementByteLength, exportBytes.byteLength);

    const rejectedResponses = [
      {
        label: "malformed Big5 bytes",
        status: 200,
        contentType: "application/vnd.ms-excel; charset=big5",
        disposition: 'attachment; filename="broken.xls"',
        body: Buffer.from([0x81]),
        error: SourceTextIntegrityError,
      },
      {
        label: "incomplete workbook",
        status: 200,
        contentType: "application/vnd.ms-excel; charset=big5",
        disposition: 'attachment; filename="incomplete.xls"',
        body: Buffer.from("<html><body><table><tr><td>partial", "ascii"),
        error: /transaction table/u,
      },
      {
        label: "nonterminal response",
        status: 503,
        contentType: "application/vnd.ms-excel; charset=big5",
        disposition: 'attachment; filename="retry.xls"',
        body: exportBytes,
        error: /not terminal/u,
      },
      {
        label: "unexpected response type",
        status: 200,
        contentType: "application/json; charset=utf-8",
        disposition: 'attachment; filename="unexpected.json"',
        body: Buffer.from("{}"),
        error: /unexpected content type/u,
      },
    ] as const;
    for (const scenario of rejectedResponses) {
      responseBody = scenario.body;
      responseStatus = scenario.status;
      responseContentType = scenario.contentType;
      responseDisposition = scenario.disposition;
      await openExportLink();
      await assert.rejects(
        downloadCurrentStatementInMemory(
          page,
          account,
          page.mainFrame(),
          strictSourceText,
          new AbortController().signal,
          5_000,
        ),
        scenario.error,
        scenario.label,
      );
    }
    assert.equal(postCount, rejectedResponses.length + 1);
    assert.equal(commitItems.length, 1);
    assert.equal(downloadEvents, 0);
    assert.match(requestCookie, /hncb-session=fixture/u);
    assert.equal(postCount - 1, rejectedResponses.length);
  } finally {
    process.chdir(previousWorkingDirectory);
    await rm(workingDirectory, { recursive: true, force: true });
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test("HNCB rejects malformed or incomplete exports before the Canonical Financial Commit", async () => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "hncb-memory-workflow-"));
  const previousWorkingDirectory = process.cwd();
  const commitItems: unknown[][] = [];
  const financialCommit: WorkflowFinancialCommitPort = {
    async execute(items) {
      const received = [];
      for await (const item of items) received.push(item);
      commitItems.push(received);
      return {
        status: "completed",
        items: received.map((item) => ({
          itemKey: item.itemKey,
          provider: item.provider,
          product: item.product,
          status: "committed" as const,
          admissionSummaries: [],
          value: null,
          relationWarnings: [],
        })),
        diagnostics: [],
        committedCount: received.length,
        failedCount: 0,
      };
    },
  };
  const baseInput = {
    startDate: "2026/08/01",
    endDate: "2026/08/31",
    accountFilters: [],
  };
  const page = {} as Page;
  try {
    process.chdir(workingDirectory);
    await assert.rejects(
      runHncbStatements(page, baseInput, runContext(financialCommit), {
        collectDeposit: oneAccount(async () => {
          strictSourceText.decode(Uint8Array.of(0x81), "big5");
          throw new Error("unreachable");
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProductCollectionInterruptedError);
        assert.equal(error.errorCode, "source-integrity-failed");
        assert.ok((error as Error & { cause?: unknown }).cause instanceof SourceTextIntegrityError);
        return true;
      },
    );
    assert.equal(commitItems.length, 0);

    await assert.rejects(
      runHncbStatements(page, baseInput, runContext(financialCommit), {
        collectDeposit: oneAccount(async () => ({
          account: account,
          accountId: account,
          queryPeriod: "2026/08/01-2026/08/31",
          currency: "TWD",
          rows: [],
          filename: "hncb-domestic-deposit-export.xls",
          byteLength: 0,
          contentDigest: "sha256:empty-export",
        })),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProductCollectionInterruptedError);
        assert.equal(error.errorCode, "source-collection-failed");
        assert.match(String((error as Error & { cause?: unknown }).cause), /source admission blocked/u);
        return true;
      },
    );
    assert.equal(commitItems.length, 0);

    const events: Array<{ stage: string; code: string }> = [];
    const result = await runHncbStatements(page, baseInput, runContext(financialCommit, {
      event: async (stage, _outcome, code) => { events.push({ stage, code }); },
    }), {
      collectDeposit: oneAccount(async () => ({
        account,
        accountId: account,
        queryPeriod: "2026/08/01-2026/08/31",
        currency: "TWD",
        rows: [[
          "2026/08/02", "09:10:11", "2026/08/03", "TWD", "100", "",
          "900", "fixture", "", "", "",
        ]],
        filename: "hncb-domestic-deposit-export.xls",
        byteLength: exportBytes.byteLength,
        contentDigest: `sha256:${createHash("sha256").update(exportBytes).digest("base64url")}`,
      })),
    });
    assert.equal(result.status, "financial-admitted");
    assert.equal(result.counts.accountCount, 1);
    assert.equal(commitItems.length, 1);
    assert.ok(events.some((event) => event.stage === "decoding" && event.code === "source-decoding-completed"));
    assert.deepEqual(await readdir(workingDirectory), []);

    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    await assert.rejects(
      runHncbStatements(page, baseInput, runContext(financialCommit, { signal: cancelled.signal }), {
        collectDeposit: oneAccount(async () => { throw new Error("unreachable"); }),
      }),
      (error: unknown) => error instanceof ProductCollectionInterruptedError && error.errorCode === "cancelled",
    );
    assert.equal(commitItems.length, 1);
  } finally {
    process.chdir(previousWorkingDirectory);
    await rm(workingDirectory, { recursive: true, force: true });
  }
});

test("HNCB export deadline also bounds a blocked submit evaluation", async () => {
  let releaseSubmit!: () => void;
  let closed = false;
  const blockedSubmit = new Promise<void>(resolve => { releaseSubmit = resolve; });
  const popup = {
    async waitForLoadState() {},
    async route() {},
    async evaluate() { await blockedSubmit; },
    async unroute() {},
    async close() { closed = true; releaseSubmit(); },
  };
  const page = { async waitForEvent() { return popup; } } as never;
  const frame = { locator() { return { first() { return { async click() {} }; } }; } } as never;
  const run = downloadCurrentStatementInMemory(page, account, frame, strictSourceText, new AbortController().signal, 20);
  let watchdog: ReturnType<typeof setTimeout>;
  try {
    await assert.rejects(Promise.race([
      run,
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("test watchdog: export did not stop")), 200); }),
    ]), /Timed out waiting for the HNCB export response/u);
    assert.equal(closed, true);
  } finally {
    clearTimeout(watchdog!);
    releaseSubmit();
    await run.catch(() => undefined);
  }
});

test("HNCB export stops at the run's cancellation instead of its deadline", async () => {
  let releaseSubmit!: () => void;
  let closed = false;
  const blockedSubmit = new Promise<void>(resolve => { releaseSubmit = resolve; });
  const popup = {
    async waitForLoadState() {},
    async route() {},
    async evaluate() { await blockedSubmit; },
    async unroute() {},
    async close() { closed = true; releaseSubmit(); },
  };
  const page = { async waitForEvent() { return popup; } } as never;
  const frame = { locator() { return { first() { return { async click() {} }; } }; } } as never;
  const run = new AbortController();
  const reason = new Error("run cancelled");
  const download = downloadCurrentStatementInMemory(page, account, frame, strictSourceText, run.signal, 60_000);
  setTimeout(() => run.abort(reason), 10);
  await assert.rejects(download, (error: unknown) => error === reason);
  assert.equal(closed, true);
});
