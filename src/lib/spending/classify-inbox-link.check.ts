import assert from "node:assert/strict";
import test from "node:test";
import { CLASSIFY_INBOX_HREF, classifyInboxRequested } from "./classify-inbox-link.ts";

test("the link's own hash asks the Spending route for the inbox", () => {
  assert.equal(classifyInboxRequested(false, "spending", CLASSIFY_INBOX_HREF), true);
});

test("a plain Spending visit, a refresh or a forward step does not ask for the inbox", () => {
  assert.equal(classifyInboxRequested(false, "spending", "#/spending"), false);
  assert.equal(classifyInboxRequested(false, "spending", "#/spending/classify/extra"), false);
});

test("the request survives a second read after the hash was rewritten", () => {
  const arrived = classifyInboxRequested(false, "spending", CLASSIFY_INBOX_HREF);
  assert.equal(classifyInboxRequested(arrived, "spending", "#/spending"), true);
});

test("a route that is not Spending holds no request, even with the inbox segment", () => {
  assert.equal(classifyInboxRequested(true, "cash-flow", "#/cash-flow"), false);
  assert.equal(classifyInboxRequested(false, "overview", CLASSIFY_INBOX_HREF), false);
  assert.equal(classifyInboxRequested(false, "cash-flow", "#/cash-flow/classify"), false);
});
