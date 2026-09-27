import assert from "node:assert/strict";
import {
  EInvoiceDetailRequestNotSentError,
  retryEinvoiceMonthOnUnsentDetail,
} from "./einvoice-personal-invoices.ts";

let attempts = 0;
const result = await retryEinvoiceMonthOnUnsentDetail(async () => {
  attempts += 1;
  if (attempts === 1) throw new EInvoiceDetailRequestNotSentError();
  return "complete";
});
assert.equal(result, "complete");
assert.equal(attempts, 2);

attempts = 0;
await assert.rejects(retryEinvoiceMonthOnUnsentDetail(async () => {
  attempts += 1;
  throw new Error("detail request was sent but failed");
}), /detail request was sent but failed/u);
assert.equal(attempts, 1);

attempts = 0;
await assert.rejects(retryEinvoiceMonthOnUnsentDetail(async () => {
  attempts += 1;
  throw new EInvoiceDetailRequestNotSentError();
}), EInvoiceDetailRequestNotSentError);
assert.equal(attempts, 2);
