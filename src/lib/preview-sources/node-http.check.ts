import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { SourceUnavailableError } from "../automation/source-access.ts";
import { nodeHttp } from "./node-http.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const context = { signal: new AbortController().signal } as unknown as PreviewWorkflowContext;

test("the Node transport keeps a per-session cookie jar and classifies server failures", async () => {
  const seen: IncomingMessage["headers"][] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers);
    if (request.url === "/set") response.setHeader("Set-Cookie", ["session=abc; Path=/; HttpOnly", "other=1"]);
    if (request.url === "/clear") response.setHeader("Set-Cookie", "other=; Max-Age=0");
    if (request.url === "/down") { response.statusCode = 503; response.end("down"); return; }
    if (request.url === "/moved") { response.statusCode = 302; response.setHeader("Location", "/set"); response.end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await nodeHttp(context, { pageUrl: base }, async (http) => {
      const first = await http({ method: "GET", url: `${base}/set` });
      assert.equal(first.status, 200);
      assert.equal(first.text, '{"ok":true}');
      assert.ok(first.headers.date, "the Date header is readable");
      await http({ method: "POST", url: `${base}/clear`, headers: { "Content-Type": "application/json" }, body: "{}" });
      await http({ method: "GET", url: `${base}/after` });
      await assert.rejects(http({ method: "GET", url: `${base}/down` }), SourceUnavailableError);
      await assert.rejects(http({ method: "GET", url: `${base}/moved` }), SourceUnavailableError, "a redirect is not followed");
    });
    await nodeHttp(context, { pageUrl: base }, (http) => http({ method: "GET", url: `${base}/fresh` }));
  } finally {
    server.close();
  }
  assert.equal(seen[0]!.cookie, undefined);
  assert.equal(seen[1]!.cookie, "session=abc; other=1");
  assert.equal(seen[2]!.cookie, "session=abc", "an emptied cookie is dropped");
  assert.equal(seen[5]!.cookie, undefined, "a new session starts without cookies");
});
