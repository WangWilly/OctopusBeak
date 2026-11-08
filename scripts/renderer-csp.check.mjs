import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { rendererCsp, withRendererCsp } from "./renderer-csp.mjs";

const sha = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <script type="module" src="./_app/entry.js"></script>
  </head>
  <body><div><script>
  import("./_app/immutable/entry/start.js");
</script></div></body>
</html>`;

test("the policy hashes the final inline bootstrap, not an earlier rewrite of it", () => {
  const html = withRendererCsp(page);
  const policy = /content="([^"]+)"/.exec(html)?.[1] ?? "";
  assert.match(policy, /script-src 'self' 'sha256-/);
  assert.ok(policy.includes(sha('\n  import("./_app/immutable/entry/start.js");\n')));
  assert.ok(!policy.includes(sha('\n  import("/_app/immutable/entry/start.js");\n')));
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script"), "the policy precedes every script");
});

test("the policy refuses everything the renderer does not need", () => {
  const policy = rendererCsp([]);
  for (const directive of ["default-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(policy.includes(directive), directive);
  }
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(policy, /https?:/);
});

test("an inline script with attributes is hashed too, a script with src is not", () => {
  const html = withRendererCsp(`<!doctype html><html><head></head><body>
<script type="module" data-sveltekit-hydrate="x">start();</script>
<script src="./_app/entry.js"></script>
<script>boot();</script>
</body></html>`);
  const policy = /content="([^"]+)"/.exec(html)?.[1] ?? "";
  assert.ok(policy.includes(sha("start();")), "a bootstrap with attributes still runs under the policy");
  assert.ok(policy.includes(sha("boot();")));
  assert.ok(!policy.includes(sha("")), "an external script contributes no hash");
});

test("a page that already declares a policy or has no head is refused", () => {
  assert.throws(() => withRendererCsp(withRendererCsp(page)), /already declares/);
  assert.throws(() => withRendererCsp("<html><body></body></html>"), /no <head>/);
});
