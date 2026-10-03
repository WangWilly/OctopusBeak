import { SinopacCaptchaRejectedError } from "../sinopac-captcha.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceTextIntegrityError } from "../source-text.ts";
import { SourceAccessChallengeError, SourceUnavailableError } from "../source-access.ts";
import { BrowserRuntimeConfigurationError } from "./browser-runtime.ts";
import {
  classifyTypedWorkflowFailure,
  isTypedWorkflowOutcomeSummary,
  sanitizeTypedWorkflowOutcome,
  summarizeInterruptedProductCollection,
  summarizeTypedWorkflowOutput,
} from "./typed-workflow-outcome.ts";
import { workflowFailureExplanation } from "../workflow-failures.ts";
import type { WorkflowRunEvent } from "../workflow-executor.ts";
import { ProductCollectionInterruptedError } from "../product-collection.ts";

test("typed workflow summary keeps only bounded status and aggregate counts", () => {
  const privateAccountNumber = ["12345", "67890"].join("");
  const summary = summarizeTypedWorkflowOutput({
    status: "financial-admitted",
    accountCount: 4,
    rowCount: 22,
    itemCount: 17,
    captureId: "account-identifier-must-not-survive",
    accountNumber: privateAccountNumber,
    response: { authorization: "secret-token" },
    items: [{ amount: 2500 }],
  });

  assert.deepEqual(summary, {
    status: "financial-admitted",
    counts: { accountCount: 4, rowCount: 22, itemCount: 17 },
  });
  assert.ok(JSON.stringify(summary).length <= 512);
  assert.ok(!JSON.stringify(summary).includes(privateAccountNumber));
  assert.doesNotMatch(JSON.stringify(summary), /account-identifier|secret-token|2500/u);
});

test("typed workflow summary ignores unsupported and invalid count fields", () => {
  assert.equal(summarizeTypedWorkflowOutput({
    status: "untrusted free-form status",
    rowCount: 1.5,
    itemCount: -1,
    accountCount: Number.MAX_SAFE_INTEGER + 1,
    credentialCount: 10,
  }), null);
  assert.equal(summarizeTypedWorkflowOutput("raw provider output"), null);
});

test("product outcomes survive typed sanitization and persisted outcome round-trip", () => {
  const products = [
    { typeId: "deposit", status: "success", itemCount: 2, committedCount: 2 },
    { typeId: "credit_card", status: "failed", itemCount: 1, committedCount: 1, errorCode: "canonical-commit-failed" },
  ] as const;
  const summary = summarizeTypedWorkflowOutput({
    status: "partial",
    itemCount: 3,
    committedCount: 3,
    products,
    providerMessage: "private provider response",
  });
  assert.deepEqual(summary, {
    status: "partial",
    counts: { itemCount: 3, committedCount: 3 },
    products,
  });
  assert.equal(isTypedWorkflowOutcomeSummary(summary), true);
  assert.deepEqual(sanitizeTypedWorkflowOutcome({ errorCode: "cancelled", summary }), {
    errorCode: "cancelled",
    summary,
  });
  assert.equal(JSON.stringify(summary).includes("private provider response"), false);

  const interrupted = summarizeInterruptedProductCollection(new ProductCollectionInterruptedError("cancelled", {
    status: "partial",
    sourceCaptureCount: 2,
    rowCount: 5,
    itemCount: 3,
    committedCount: 3,
    products,
  }));
  assert.deepEqual(interrupted?.products, products);
  assert.deepEqual(interrupted?.counts, {
    sourceCaptureCount: 2,
    rowCount: 5,
    itemCount: 3,
    committedCount: 3,
  });

  assert.equal(summarizeTypedWorkflowOutput({
    status: "partial",
    products: [{ ...products[0], extra: "rejected" }],
  }), null);
  assert.equal(summarizeTypedWorkflowOutput({
    status: "partial",
    products: [products[0], products[0]],
  }), null);
});

test("typed failures use stable privacy-safe categories", () => {
  assert.equal(
    classifyTypedWorkflowFailure(new BrowserRuntimeConfigurationError("unsupported-profile"), []),
    "browser-runtime-config-failed",
  );
  assert.equal(
    classifyTypedWorkflowFailure(new SourceTextIntegrityError("invalid-encoding"), []),
    "source-integrity-failed",
  );
  assert.equal(
    classifyTypedWorkflowFailure(new SourceAccessChallengeError(), []),
    "source-access-challenged",
  );
  assert.equal(
    classifyTypedWorkflowFailure(new SourceUnavailableError(), []),
    "source-unavailable",
  );
  assert.equal(classifyTypedWorkflowFailure(new Error("contains private account 123"), [{
    runId: "run-1",
    stage: "validation",
    code: "source-validation-rejected",
    occurredAt: "2026-09-25T00:00:00.000Z",
  }]), "source-validation-failed");
  assert.equal(classifyTypedWorkflowFailure(new Error("commit/conflict"), [{
    runId: "run-1",
    stage: "commit",
    code: "canonical-commit-failed",
    occurredAt: "2026-09-25T00:00:00.000Z",
  }]), "canonical-commit-failed");
  assert.equal(classifyTypedWorkflowFailure(new Error("provider disconnected"), [{
    runId: "run-1",
    stage: "commit",
    code: "canonical-commit-started",
    occurredAt: "2026-09-25T00:00:00.000Z",
  }]), "commit-outcome-unknown");
  assert.equal(classifyTypedWorkflowFailure(new Error("user stopped"), [], true), "cancelled");
  assert.equal(classifyTypedWorkflowFailure(new Error("private details"), [{
    runId: "run-1",
    stage: "authentication",
    code: "solver-route-unavailable",
    occurredAt: "2026-09-25T00:00:00.000Z",
  }]), "verification-configuration-failed");
  assert.equal(classifyTypedWorkflowFailure(new Error("private response body"), []), "workflow-failed");
});

test("SinoPac rejection is typed without relying on operational events", () => {
  assert.equal(classifyTypedWorkflowFailure(new SinopacCaptchaRejectedError(), []), "captcha-provider-rejected");
  assert.equal(classifyTypedWorkflowFailure(new SinopacCaptchaRejectedError(), [], true), "cancelled");
  assert.equal(classifyTypedWorkflowFailure(new Error("CAPTCHA rejected"), []), "workflow-failed");
});

test("stage diagnostics survive storage sanitization without exception details", () => {
  const codes = [
    "authentication-timeout", "authentication-dialog-interrupted", "authentication-failed",
    "verification-failed", "source-collection-failed",
  ] as const;
  for (const errorCode of codes) {
    const outcome = sanitizeTypedWorkflowOutcome({
      errorCode,
      summary: null,
      exception: "private provider response",
      credentials: "private authentication data",
    });
    assert.deepEqual(outcome, { errorCode, summary: null });
    assert.ok(workflowFailureExplanation(errorCode, "zh-TW"));
    assert.ok(workflowFailureExplanation(errorCode, "en"));
    assert.doesNotMatch(JSON.stringify(outcome), /private/u);
  }
  assert.equal(sanitizeTypedWorkflowOutcome({ errorCode: "authentication-private-provider-text" })?.errorCode, "workflow-failed");
  assert.equal(workflowFailureExplanation("toString", "zh-TW"), null);
});

test("fallback stage diagnostics preserve cancellation and commit uncertainty", () => {
  const event = (stage: WorkflowRunEvent["stage"], code: string): WorkflowRunEvent => ({
    runId: "run-1", stage, code, occurredAt: "2026-09-29T12:00:00.000Z",
  });
  const error = new Error("private exception text");
  error.name = "TimeoutError";
  const auth = event("authentication", "authentication-started");
  const finalized = event("finalization", "run-failed");
  assert.equal(classifyTypedWorkflowFailure(error, [auth, finalized], true), "cancelled");
  assert.equal(classifyTypedWorkflowFailure(error, [event("commit", "canonical-commit-started"), auth, finalized]), "commit-outcome-unknown");
  assert.equal(classifyTypedWorkflowFailure(error, [event("collection", "collection-started"), event("preparation", "run-started"), auth, finalized]), "authentication-timeout");
  assert.equal(classifyTypedWorkflowFailure(error, [event("authentication", "authentication-started"), event("preparation", "run-started"), finalized]), "workflow-failed");
});
