import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalEInvoiceCaptureInput } from "../ledger/canonical/einvoice-contract.ts";
import { commitCanonicalCapture } from "./einvoice-personal-invoices.ts";

test("E-Invoice commit uses the injected Canonical Financial Commit port", async () => {
  const capture = { captureId: "injected-capture" } as CanonicalEInvoiceCaptureInput;
  let received: unknown;
  const result = await commitCanonicalCapture(capture, {
    async execute(items) {
      for await (const item of items) {
        received = item;
        break;
      }
      return {
        status: "completed",
        items: [{
          itemKey: capture.captureId,
          provider: "einvoice",
          product: "personal-invoice",
          status: "committed",
          admissionSummaries: [],
          value: { captureId: capture.captureId },
          relationWarnings: [],
        }],
        diagnostics: [],
        committedCount: 1,
        failedCount: 0,
      };
    },
  });
  assert.equal(result.captureId, capture.captureId);
  assert.equal((received as { command: { request: unknown } }).command.request, capture);
});
