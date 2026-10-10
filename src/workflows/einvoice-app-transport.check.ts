import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import type { EInvoiceAppSession } from "./einvoice-app-protocol.ts";
import { queryEinvoiceDetail, queryEinvoiceHeaders } from "./einvoice-app-transport.ts";

const session: EInvoiceAppSession = {
  sid: "s",
  token: "t",
  appid: "a",
  ssme: "s",
  liat: 1,
  carrierCode: "/AB+123",
};

function pageAnswering(body: unknown): Page {
  return {
    evaluate: async () => ({ status: 200, text: JSON.stringify(body) }),
  } as unknown as Page;
}

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
      pageAnswering({ carrierQueryList: { code: "903", msg: "查詢失敗", details: [] } }),
      session, "2026-09-01", "2026-09-30", 1,
    ),
    /header query rejected \(code 903: 查詢失敗\)/u,
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
