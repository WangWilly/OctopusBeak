import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { type Page } from "playwright";
import { launchCheckBrowser } from "./check-browser.fixtures.ts";
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
import { hncbCurrentDepositDetailTable, hncbCurrentDepositUnavailableRow } from "../../workflows/hncb-current-deposit-balances.fixtures.ts";
import { SourceTextIntegrityError, strictSourceText } from "./source-text.ts";
import type { WorkflowContext, WorkflowContextWith, WorkflowFinancialCommitPort } from "./workflow-executor.ts";
import { ProductCollectionInterruptedError, type ProductCollectionHandle } from "./product-collection.ts";
import { withBoundProducts } from "./product-collection.fixtures.ts";
import { HNCB_SOURCE } from "./server/sources/hncb.ts";
import { readHncbCurrentDepositOverviewTable } from "../../workflows/hncb-current-deposit-balances.ts";
import { frameScope } from "../../workflows/frame-scope.ts";
import { HNCB_NETBANK_ORIGIN, hncbNetbankSite } from "../../workflows/hncb-netbank-site.ts";
import { ProviderResponseCheckError } from "./provider-response-check.ts";

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

/** A check run outside any product, for the export read driven directly. */
const unreported: ProductCollectionHandle["validate"] = async (check) => await check();
const exportContext = { text: strictSourceText, now: () => "2026-09-01T04:00:00.000Z" };

/**
 * A throwaway self-signed certificate for netbank.hncb.com.tw, so the export
 * check can serve HNCB's https origin locally; the browser context ignores
 * its issuer. It is made per run so no private key lives in the repository.
 */
async function fixtureTls(): Promise<Readonly<{ key: string; cert: string }>> {
  const directory = await mkdtemp(join(tmpdir(), "hncb-tls-"));
  try {
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1",
      "-subj", "/CN=netbank.hncb.com.tw", "-addext", "subjectAltName=DNS:netbank.hncb.com.tw",
    ], { stdio: "ignore" });
    return { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The real read and build halves over one account whose query opens `download`, with no current balances. */
function oneAccount(
  download: (validate: ProductCollectionHandle["validate"]) => Promise<HncbStatementDownload>,
): HncbDepositRunner {
  const source: HncbDepositSource = {
    accounts: async () => [{ value: account, label: `HNCB ${account}` }],
    query: async () => ({ download }),
  };
  return async (_page, input, context, product) => await stageHncbDeposit(
    await readHncbDepositSource(source, input, context, product),
    context,
    product,
    async () => hncbCurrentDepositDetailTable([hncbCurrentDepositUnavailableRow(account)]),
  );
}

/** A deposit-only HNCB run, its Product collection run bound to HNCB_SOURCE as the executor binds it. */
function runContext(
  financialCommit: WorkflowFinancialCommitPort,
  overrides: Partial<Pick<WorkflowContext, "signal" | "event" | "now">> = {},
): HncbStatementsContext {
  const context = {
    signal: new AbortController().signal,
    now: () => "2026-09-01T04:00:00.000Z",
    text: strictSourceText,
    event: async () => undefined,
    financialCommit,
    ...overrides,
  } as Pick<WorkflowContext, "signal" | "now" | "text" | "event"> as WorkflowContextWith<"financialCommit">;
  return withBoundProducts(context, HNCB_SOURCE, { statementTypes: ["deposit"] });
}

test("HNCB queries two years and one day ending on the run's Taipei date", async () => {
  const queried: unknown[] = [];
  const source: HncbDepositSource = {
    accounts: async () => [{ value: account, label: `HNCB ${account}` }],
    query: async (_account, dateRange) => {
      queried.push(dateRange);
      return null;
    },
  };
  const committed: WorkflowFinancialCommitPort = {
    async execute(items) {
      const received = [];
      for await (const item of items) received.push(item);
      return {
        status: "completed",
        items: received.map((item) => ({
          itemKey: item.itemKey, provider: item.provider, product: item.product, status: "committed" as const,
          admissionSummaries: [], value: null, relationWarnings: [],
        })),
        diagnostics: [], committedCount: received.length, failedCount: 0,
      };
    },
  };
  // 16:30Z on Feb 28 is 00:30 on Feb 29 in Taipei; two years back clamps to Feb 28.
  await runHncbStatements({} as Page, { accountFilters: [] }, runContext(committed, { now: () => "2028-02-28T16:30:00.000Z" }), {
    collectDeposit: async (_page, input, context, product) => await stageHncbDeposit(
      await readHncbDepositSource(source, input, context, product),
      context,
      product,
      async () => hncbCurrentDepositDetailTable([hncbCurrentDepositUnavailableRow(account)]),
    ),
  });
  assert.deepEqual(queried, [{ startDate: "2026/02/28", endDate: "2028/02/29" }]);
});

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
  const site = createHttpsServer(await fixtureTls(), (request: IncomingMessage, response: ServerResponse) => {
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

  // The browser and route.fetch() both reach HNCB's origin through this proxy, which tunnels
  // only netbank.hncb.com.tw to the local site, so no request leaves the machine.
  const tunnels = new Set<Socket>();
  const proxy = createServer((_request, response) => {
    response.writeHead(403);
    response.end();
  });
  proxy.on("connect", (request: IncomingMessage, socket: Socket) => {
    if (request.url !== `${new URL(HNCB_NETBANK_ORIGIN).hostname}:443`) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    site.emit("connection", socket);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxy.unref();
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const origin = HNCB_NETBANK_ORIGIN;
  const browser = await launchCheckBrowser();
  let downloadEvents = 0;
  let browserSubmissions = 0;
  let submitInvocations = 0;
  const workingDirectory = await mkdtemp(join(tmpdir(), "hncb-memory-workflow-"));
  const previousWorkingDirectory = process.cwd();
  try {
    process.chdir(workingDirectory);
    const browserContext = await browser.newContext({
      proxy: { server: `http://127.0.0.1:${address.port}` },
      ignoreHTTPSErrors: true,
    });
    const page = await browserContext.newPage();
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
    const output = await runHncbStatements(page, { accountFilters: [] }, context, {
      collectDeposit: oneAccount(async (validate) => {
        const statement = await downloadCurrentStatementInMemory(
          frameScope(page, context.signal),
          `HNCB ${account}`,
          page.mainFrame(),
          context,
          validate,
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
        error: (error: unknown) => error instanceof ProviderResponseCheckError && error.check === "response-status",
      },
      {
        label: "unexpected response type",
        status: 200,
        contentType: "application/json; charset=utf-8",
        disposition: 'attachment; filename="unexpected.json"',
        body: Buffer.from("{}"),
        error: (error: unknown) => error instanceof ProviderResponseCheckError && error.check === "response-content-type",
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
          frameScope(page, new AbortController().signal),
          account,
          page.mainFrame(),
          exportContext,
          unreported,
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

    // ADR 0106: an export reply the check refuses fails the product as a validation failure.
    responseBody = Buffer.from("<html><body><table><tr><td>partial", "ascii");
    responseStatus = 200;
    responseContentType = "application/vnd.ms-excel; charset=big5";
    responseDisposition = 'attachment; filename="incomplete.xls"';
    await openExportLink();
    const incompleteContext = runContext(financialCommit);
    await assert.rejects(
      runHncbStatements(page, { accountFilters: [] }, incompleteContext, {
        collectDeposit: oneAccount((validate) => downloadCurrentStatementInMemory(
          frameScope(page, incompleteContext.signal),
          `HNCB ${account}`,
          page.mainFrame(),
          incompleteContext,
          validate,
          5_000,
        )),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProductCollectionInterruptedError);
        assert.equal(error.errorCode, "source-validation-failed");
        return true;
      },
    );
    assert.equal(commitItems.length, 1);
  } finally {
    process.chdir(previousWorkingDirectory);
    await rm(workingDirectory, { recursive: true, force: true });
    await browser.close();
    for (const socket of tunnels) socket.destroy();
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => error ? reject(error) : resolve()),
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
  const baseInput = { accountFilters: [] };
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
        assert.equal(error.errorCode, "source-validation-failed");
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
  const run = downloadCurrentStatementInMemory(frameScope(page, new AbortController().signal), account, frame, exportContext, unreported, 20);
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

test("HNCB export that times out fails the product as a collection failure, not a validation failure", async () => {
  const popup = {
    async waitForLoadState() {},
    async route() {},
    async evaluate() { await new Promise(() => undefined); },
    async unroute() {},
    async close() {},
  };
  const page = { async waitForEvent() { return popup; } } as never;
  const frame = { locator() { return { first() { return { async click() {} }; } }; } } as never;
  const context = runContext({ async execute() { throw new Error("a failed read must not reach the commit"); } });
  await assert.rejects(
    runHncbStatements(page, { accountFilters: [] }, context, {
      collectDeposit: oneAccount((validate) =>
        downloadCurrentStatementInMemory(frameScope(page, context.signal), account, frame, context, validate, 20)),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "source-collection-failed");
      assert.match(String((error as Error & { cause?: unknown }).cause), /Timed out waiting for the HNCB export response/u);
      return true;
    },
  );
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
  const download = downloadCurrentStatementInMemory(frameScope(page, run.signal), account, frame, exportContext, unreported, 60_000);
  setTimeout(() => run.abort(reason), 10);
  await assert.rejects(download, (error: unknown) => error === reason);
  assert.equal(closed, true);
});

test("cancelling the run stops a pending export click in the browser and stages nothing", async () => {
  const browser = await launchCheckBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<iframe name="main" srcdoc="<script>function doSubmit() { top.exportClicked = true; }</script><p>查詢結果</p>"></iframe>`);
    const frame = page.frame({ name: "main" });
    assert.ok(frame);
    const cancellation = new Error("synthetic cancellation");
    const run = new AbortController();
    const commitItems: unknown[] = [];
    const financialCommit: WorkflowFinancialCommitPort = {
      async execute(items) {
        for await (const item of items) commitItems.push(item);
        throw new Error("a cancelled run must not reach the commit");
      },
    };
    let readError: unknown;
    const download = (validate: ProductCollectionHandle["validate"]) =>
      downloadCurrentStatementInMemory(frameScope(page, run.signal), account, frame, exportContext, validate)
      .catch((error: unknown) => { readError = error; throw error; });
    setTimeout(() => run.abort(cancellation), 300);
    // The export link appears only after the cancellation; an abandoned click would still land on it.
    setTimeout(() => void frame.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", `<a href="javascript:doSubmit('5')">下載</a>`);
    }).catch(() => undefined), 600);
    const started = Date.now();
    await assert.rejects(
      runHncbStatements(page, { accountFilters: [] }, runContext(financialCommit, { signal: run.signal }), {
        collectDeposit: oneAccount(download),
      }),
      (error: unknown) => error instanceof ProductCollectionInterruptedError && error.errorCode === "cancelled",
    );
    assert.equal(readError, cancellation);
    assert.ok(Date.now() - started < 2_000, "cancellation ends the export click wait well before its 30 s timeout");
    await page.waitForTimeout(1_000);
    assert.equal(await page.evaluate(() => (window as { exportClicked?: boolean }).exportClicked ?? false), false);
    assert.deepEqual(commitItems, []);
  } finally {
    await browser.close();
  }
});

test("cancelling the run stops the current-balance overview polling for its menu", async () => {
  const browser = await launchCheckBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<a href="#">帳務查詢</a>`);
    const cancellation = new Error("synthetic cancellation");
    const run = new AbortController();
    setTimeout(() => run.abort(cancellation), 300);
    const started = Date.now();
    await assert.rejects(
      readHncbCurrentDepositOverviewTable(hncbNetbankSite(page, { signal: run.signal })),
      (error: unknown) => error === cancellation,
    );
    assert.ok(Date.now() - started < 2_000, "cancellation ends the menu wait well before its 60 s timeout");
  } finally {
    await browser.close();
  }
});
