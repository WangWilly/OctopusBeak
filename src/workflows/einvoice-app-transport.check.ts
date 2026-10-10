import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import {
  ProviderProtocolOutdatedError,
  SourceAccessChallengeError,
  SourceUnavailableError,
} from "../lib/automation/source-access.ts";
import { BrowserRuntimeConfigurationError } from "../lib/automation/server/browser-runtime.ts";
import type { EInvoiceAppSession } from "./einvoice-app-protocol.ts";
import {
  loginEinvoiceApp,
  queryEinvoiceDetail,
  queryEinvoiceHeaders,
  stripOriginOnPausedRequests,
} from "./einvoice-app-transport.ts";

const session: EInvoiceAppSession = {
  sid: "s",
  token: "t",
  appid: "a",
  ssme: "s",
  liat: 1,
  carrierCode: "/AB+123",
};

function pageAnswering(body: unknown, status = 200): Page {
  return {
    evaluate: async () => ({ status, text: typeof body === "string" ? body : JSON.stringify(body) }),
  } as unknown as Page;
}

const query = (page: Page) => queryEinvoiceHeaders(page, session, "2026/09/01", "2026/09/30", 1);

test("a header page with a success code returns its rows", async () => {
  const result = await queryEinvoiceHeaders(
    pageAnswering({ carrierQueryList: { code: "200", msg: "執行成功", details: [{ invNum: "AB12345678" }] } }),
    session, "2026-09-01", "2026-09-30", 1,
  );
  assert.deepEqual(result.details.map((row) => row.invNum), ["AB12345678"]);
});

test("a header page with an error code is rejected, not read as an empty terminal page", async () => {
  await assert.rejects(
    queryEinvoiceHeaders(
      pageAnswering({ carrierQueryList: { code: "999", msg: "查詢失敗", details: [] } }),
      session, "2026-09-01", "2026-09-30", 1,
    ),
    /header query rejected \(code 999: 查詢失敗\)/u,
  );
});

test("a header response without carrierQueryList is rejected", async () => {
  await assert.rejects(
    queryEinvoiceHeaders(pageAnswering({ message: "Unauthorized" }), session, "2026-09-01", "2026-09-30", 1),
    /header query rejected \(code \(missing\)/u,
  );
});

test("a detail response with an error code is rejected, not read as an invoice with no items", async () => {
  await assert.rejects(
    queryEinvoiceDetail(
      pageAnswering({ code: "919", msg: "session 逾時", details: [] }),
      session, "AB12345678", "2026/09/15",
    ),
    /detail query rejected \(code 919: session 逾時\)/u,
  );
});

test("a detail response with a success code returns its items", async () => {
  const result = await queryEinvoiceDetail(
    pageAnswering({ code: 200, msg: "執行成功", details: [{ description: "咖啡", amount: "60" }] }),
    session, "AB12345678", "2026/09/15",
  );
  assert.deepEqual(result.details.map((item) => item.description), ["咖啡"]);
});

test("a Cloudflare challenge page is a source access challenge", async () => {
  await assert.rejects(
    query(pageAnswering("<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>", 403)),
    SourceAccessChallengeError,
  );
});

test("a server error or an unreachable host is a temporarily unavailable source", async () => {
  await assert.rejects(query(pageAnswering("upstream down", 503)), SourceUnavailableError);
  await assert.rejects(query(pageAnswering("TypeError: Failed to fetch", 0)), SourceUnavailableError);
});

// The live server answered dashed dates with a top-level 903 參數錯誤: the
// request no longer matches what the server accepts.
test("a top-level parameter rejection means the App protocol is outdated", async () => {
  await assert.rejects(
    query(pageAnswering({ code: "903", msg: "參數錯誤", version: "1.0" })),
    ProviderProtocolOutdatedError,
  );
});

test("a successful login whose payload cannot be opened means the App protocol is outdated", async () => {
  await assert.rejects(
    loginEinvoiceApp(pageAnswering({ result: 0, payload: "not-a-sealed-session" }), "0900000000", "pw", "device"),
    ProviderProtocolOutdatedError,
  );
});

test("a rejected login stays an untyped sign-in failure", async () => {
  const rejection = await loginEinvoiceApp(
    pageAnswering({ result: -151, payload: "8R7CNOuc7QK2bjOd3unyaRiU" }), "0900000000", "pw", "device",
  ).then(() => null, (error: unknown) => error);
  assert.ok(rejection instanceof Error);
  assert.match(rejection.message, /login rejected \(result -151\)/u);
  for (const typed of [ProviderProtocolOutdatedError, SourceAccessChallengeError, SourceUnavailableError]) {
    assert.ok(!(rejection instanceof typed));
  }
});

// The query host answers a request that still carries Origin with this 403.
// It means the header rewrite was not in effect, not that the source refused.
test("an Invalid CORS rejection means the Origin rewrite is not in effect", async () => {
  const rejection = await query(pageAnswering("Invalid CORS request", 403)).then(() => null, (error: unknown) => error);
  assert.ok(rejection instanceof BrowserRuntimeConfigurationError);
  assert.equal(rejection.code, "request-header-rewrite-failed");
});

type Sent = { method: string; params: Record<string, unknown> };

function fakeCdp(failContinueWithHeaders: boolean) {
  const sent: Sent[] = [];
  let paused: ((event: unknown) => Promise<void>) | undefined;
  const cdp = {
    on: (_event: string, handler: (event: unknown) => Promise<void>) => { paused = handler; },
    send: async (method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params });
      if (failContinueWithHeaders && method === "Fetch.continueRequest" && params.headers) throw new Error("Invalid InterceptionId");
      return {};
    },
  };
  return { cdp, sent, pause: (event: unknown) => paused!(event) };
}

const pausedRequest = {
  requestId: "r1",
  request: { headers: { Origin: "https://upi.einvoice.nat.gov.tw", Referer: "https://upi.einvoice.nat.gov.tw/", "Content-Type": "x" } },
};

test("a paused request continues without Origin and Referer", async () => {
  const { cdp, sent, pause } = fakeCdp(false);
  let failures = 0;
  stripOriginOnPausedRequests(cdp, () => { failures += 1; });
  await pause(pausedRequest);
  assert.deepEqual(sent, [{
    method: "Fetch.continueRequest",
    params: { requestId: "r1", headers: [{ name: "Content-Type", value: "x" }] },
  }]);
  assert.equal(failures, 0);
});

test("a request whose headers cannot be rewritten is failed, never sent with Origin", async () => {
  const { cdp, sent, pause } = fakeCdp(true);
  let failures = 0;
  stripOriginOnPausedRequests(cdp, () => { failures += 1; });
  await pause(pausedRequest);
  assert.ok(!sent.some((call) => call.method === "Fetch.continueRequest" && !call.params.headers));
  assert.ok(sent.some((call) => call.method === "Fetch.failRequest"));
  assert.equal(failures, 1);
});
