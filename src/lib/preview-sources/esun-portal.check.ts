import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { SourceTextIntegrityError, strictSourceText } from "../automation/source-text.ts";
import { createEsunPortalTransport, type EsunPortalPageReply } from "./esun-portal.ts";

const DATE = "Thu, 15 Oct 2026 01:59:00 GMT";

function transportAnswering(bytes: Uint8Array) {
  const reply: EsunPortalPageReply = {
    kind: "body",
    httpStatus: 200,
    base64: Buffer.from(bytes).toString("base64"),
    date: DATE,
  };
  const page = {
    url: () => "https://ebank.esunbank.com.tw/index.jsp",
    evaluate: async () => reply,
  } as unknown as Page;
  return createEsunPortalTransport(page, { signal: new AbortController().signal, text: strictSourceText });
}

test("a portal reply is decoded strictly as UTF-8 outside the page", async () => {
  const body = JSON.stringify({ resultCode: "0000", resultBody: { accountAlias: "薪轉戶" } });
  assert.deepEqual(
    await transportAnswering(Buffer.from(body, "utf8"))("path", {}, false),
    { kind: "json", httpStatus: 200, text: body, date: DATE },
  );
});

test("a portal reply with a malformed UTF-8 byte fails integrity instead of reading a replacement character", async () => {
  const valid = Buffer.from("{\"resultCode\":\"0000\",\"resultBody\":{\"accountAlias\":\"", "utf8");
  const malformed = Buffer.concat([valid, Buffer.from([0xe8, 0x96]), Buffer.from("\"}}", "utf8")]);
  await assert.rejects(transportAnswering(malformed)("path", {}, false), SourceTextIntegrityError);
});

test("a portal reply that decodes but is not JSON is non-json", async () => {
  assert.deepEqual(
    await transportAnswering(Buffer.from("<html>maintenance</html>", "utf8"))("path", {}, false),
    { kind: "non-json", httpStatus: 200 },
  );
});

test("a page that left the portal host is a missing portal session", async () => {
  const page = { url: () => "https://example.test/", evaluate: async () => assert.fail("must not post") } as unknown as Page;
  const transport = createEsunPortalTransport(page, { signal: new AbortController().signal, text: strictSourceText });
  assert.deepEqual(await transport("path", {}, false), { kind: "portal-session-missing" });
});
