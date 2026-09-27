import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { errors, type Page } from "playwright";
import { retryEinvoiceReadQueryWithoutRequest } from "./einvoice-personal-invoices.ts";

const events = new EventEmitter();
const page = events as unknown as Page;
let preparations = 0;
let executions = 0;
const value = await retryEinvoiceReadQueryWithoutRequest(
  page,
  () => { preparations += 1; return Promise.resolve(); },
  async () => {
    executions += 1;
    if (executions === 1) throw new errors.TimeoutError("missing list response");
    events.emit("request", { url: () => "/api/invoice-list", method: () => "POST" });
    return "complete";
  },
  (request) => request.url().includes("invoice-list") && request.method() === "POST",
);
assert.equal(value, "complete");
assert.equal(preparations, 2, "a fresh read-only query is prepared after no request was sent");
assert.equal(executions, 2);

preparations = 0;
executions = 0;
await assert.rejects(
  retryEinvoiceReadQueryWithoutRequest(
    page,
    () => { preparations += 1; return Promise.resolve(); },
    async () => {
      executions += 1;
      events.emit("request", { url: () => "/api/invoice-list", method: () => "POST" });
      throw new errors.TimeoutError("request was sent but no response arrived");
    },
    (request) => request.url().includes("invoice-list") && request.method() === "POST",
  ),
  /request was sent but no response arrived/u,
);
assert.equal(preparations, 1, "an unanswered provider request is not silently repeated");
assert.equal(executions, 1);
