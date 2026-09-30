import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalEInvoiceCaptureInput } from "../ledger/canonical/einvoice-contract.ts";
import { commitCanonicalCapture, EInvoiceCommitRejectedError } from "./einvoice-personal-invoices.ts";

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

test("a definitive E-Invoice commit conflict is distinguished from an unknown outcome", async () => {
  const capture = { captureId: "conflicting-capture" } as CanonicalEInvoiceCaptureInput;
  await assert.rejects(commitCanonicalCapture(capture, {
    async execute() {
      return {
        status: "failed",
        items: [{
          itemKey: capture.captureId,
          provider: "einvoice",
          product: "personal-invoice",
          status: "failed",
          failureKind: "item",
          diagnostics: [{ itemKey: capture.captureId, provider: "einvoice", product: "personal-invoice", stage: "commit", errorCode: "conflict", message: "conflict" }],
        }],
        diagnostics: [{ itemKey: capture.captureId, provider: "einvoice", product: "personal-invoice", stage: "commit", errorCode: "conflict", message: "conflict" }],
        committedCount: 0,
        failedCount: 1,
      };
    },
  }), EInvoiceCommitRejectedError);
});
