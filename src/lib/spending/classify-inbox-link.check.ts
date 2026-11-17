import assert from "node:assert/strict";
import test from "node:test";
import { classifyPeriod } from "./classify-inbox.ts";
import { CLASSIFY_INBOX_HREF, classifyInboxRequested, overlapsClassifyWindow } from "./classify-inbox-link.ts";

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

const today = "2026-11-18";

test("the overlap is measured against the inbox's own window", () => {
  assert.deepEqual(classifyPeriod(today), { startDate: "2025-11-19", endDate: "2026-11-18" });
});

test("a period ending on the window's start date overlaps it by that one day", () => {
  assert.equal(overlapsClassifyWindow({ startDate: "2025-11-01", endDate: "2025-11-19" }, today), true);
});

test("a period ending the day before the window starts does not overlap it", () => {
  assert.equal(overlapsClassifyWindow({ startDate: "2025-11-01", endDate: "2025-11-18" }, today), false);
});

test("a period entirely before the window does not overlap it", () => {
  assert.equal(overlapsClassifyWindow({ startDate: "2024-01-01", endDate: "2024-12-31" }, today), false);
});

test("the current period overlaps the window, down to today alone", () => {
  assert.equal(overlapsClassifyWindow({ startDate: "2026-11-01", endDate: today }, today), true);
  assert.equal(overlapsClassifyWindow({ startDate: today, endDate: today }, today), true);
});
