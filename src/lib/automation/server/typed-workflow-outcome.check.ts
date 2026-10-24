import { SinopacCaptchaRejectedError } from "../sinopac-captcha.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceTextIntegrityError } from "../source-text.ts";
import { ProviderProtocolOutdatedError, SourceAccessChallengeError, SourceUnavailableError } from "../source-access.ts";
import { BrowserRuntimeConfigurationError } from "./browser-runtime.ts";
import {
  classifyTypedWorkflowFailure,
  sanitizeTypedWorkflowOutcome,
  summarizeInterruptedProductCollection,
} from "./typed-workflow-outcome.ts";
import { isWorkflowRunResult, WORKFLOW_RUN_COUNT_NAMES } from "../workflow-run-result.ts";
import { workflowFailureExplanation } from "../workflow-failures.ts";
import type { RunEventOutcome, WorkflowRunEvent } from "../run-event.ts";
import { ProductCollectionInterruptedError } from "../product-collection.ts";
import { TDCC_EXCLUSION_COUNT_NAMES } from "../tdcc-collection-summary.ts";

/**
 * The run result a workflow would build from these fields: count names go
 * under `counts`, anything else stays beside them, where the worker refuses it.
 */
function runResult(fields: unknown) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return isWorkflowRunResult(fields) ? fields : null;
  const { status, products, ...rest } = fields as Record<string, unknown>;
  const counts = Object.fromEntries(Object.entries(rest).filter(([name]) => (WORKFLOW_RUN_COUNT_NAMES as readonly string[]).includes(name)));
  const extra = Object.fromEntries(Object.entries(rest).filter(([name]) => !(WORKFLOW_RUN_COUNT_NAMES as readonly string[]).includes(name)));
  const candidate = {
    ...(status === undefined ? {} : { status }),
    counts,
    ...(products === undefined ? {} : { products }),
    ...extra,
  };
  return isWorkflowRunResult(candidate) ? candidate : null;
}

test("a run result carrying provider fields is refused", () => {
  const privateAccountNumber = ["12345", "67890"].join("");
  const counts = { accountCount: 4, rowCount: 22, itemCount: 17 };
  assert.equal(isWorkflowRunResult({ status: "financial-admitted", counts }), true);
  for (const leak of [
    { captureId: "account-identifier-must-not-survive" },
    { accountNumber: privateAccountNumber },
    { response: { authorization: "secret-token" } },
    { items: [{ amount: 2500 }] },
  ]) {
    assert.equal(isWorkflowRunResult({ status: "financial-admitted", counts, ...leak }), false, JSON.stringify(Object.keys(leak)));
  }
  assert.equal(isWorkflowRunResult({ status: "financial-admitted", counts: { ...counts, accountNumber: 1 } }), false,
    "only known count names may appear under counts");
});

test("typed workflow summary ignores unsupported and invalid count fields", () => {
  assert.equal(runResult({
    status: "untrusted free-form status",
    rowCount: 1.5,
    itemCount: -1,
    accountCount: Number.MAX_SAFE_INTEGER + 1,
    credentialCount: 10,
  }), null);
  assert.equal(runResult("raw provider output"), null);
});

test("product outcomes survive typed sanitization and persisted outcome round-trip", () => {
  const products = [
    { typeId: "deposit", status: "success", itemCount: 2, committedCount: 2 },
    { typeId: "credit_card", status: "failed", itemCount: 1, committedCount: 1, errorCode: "canonical-commit-failed" },
  ] as const;
  assert.equal(runResult({ status: "partial", itemCount: 3, committedCount: 3, products, providerMessage: "private provider response" }), null);
  const summary = runResult({
    status: "partial",
    itemCount: 3,
    committedCount: 3,
    products,
  });
  assert.deepEqual(summary, {
    status: "partial",
    counts: { itemCount: 3, committedCount: 3 },
    products,
  });
  assert.equal(isWorkflowRunResult(summary), true);
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

  assert.equal(runResult({
    status: "partial",
    products: [{ ...products[0], extra: "rejected" }],
  }), null);
  assert.equal(runResult({
    status: "partial",
    products: [products[0], products[0]],
  }), null);
});

test("TDCC collection evidence is bounded, consistent, private, and round-trips", () => {
  const products = [{
    typeId: "settlement",
    status: "success",
    itemCount: 2,
    committedCount: 2,
    collection: {
      status: "incomplete",
      exclusionCounts: { excludedUnknownInstitutionCount: 1 },
    },
  }] as const;
  const summary = runResult({
    status: "partial",
    committedCount: 2,
    itemCount: 2,
    excludedUnknownInstitutionCount: 1,
    products,
  });
  assert.deepEqual(summary, {
    status: "partial",
    counts: { committedCount: 2, excludedUnknownInstitutionCount: 1, itemCount: 2 },
    products,
  });
  assert.equal(isWorkflowRunResult(summary), true);
  assert.deepEqual(sanitizeTypedWorkflowOutcome({ errorCode: "source-unavailable", summary }), {
    errorCode: "source-unavailable",
    summary,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") <= 4_096);
  assert.equal(JSON.stringify(summary).includes("account"), false);

  assert.equal(runResult({
    status: "partial",
    committedCount: 0,
    excludedUnknownInstitutionCount: 1,
    products,
  }), null, "aggregate receipts must match product receipts");
  assert.equal(isWorkflowRunResult({
    status: "partial",
    counts: { committedCount: 0, excludedUnknownInstitutionCount: 1 },
    products,
  }), false, "worker frames reject contradictory receipts");
  assert.equal(runResult({
    status: "partial",
    committedCount: 2,
    excludedUnknownInstitutionCount: 1_000_000_001,
    products,
  }), null, "collection totals reject overflow instead of clamping");
  assert.equal(runResult({
    status: "partial",
    committedCount: 2,
    excludedUnknownInstitutionCount: 1,
    products: [{ ...products[0], collection: { status: "complete", exclusionCounts: { excludedUnknownInstitutionCount: 1 } } }],
  }), null, "complete evidence cannot carry exclusion counts");
});

test("TDCC top-level statuses agree with collection coverage and durable receipts", () => {
  const intentionalOnly = [{
    typeId: "settlement",
    status: "success",
    itemCount: 0,
    committedCount: 0,
    collection: { status: "complete_with_exclusions", exclusionCounts: { excludedTimeDepositCount: 1 } },
  }] as const;
  const incompleteWithoutReceipts = [{
    typeId: "settlement",
    status: "failed",
    itemCount: 0,
    committedCount: 0,
    errorCode: "source-collection-failed",
    collection: { status: "incomplete", exclusionCounts: { excludedUnknownInstitutionCount: 1 } },
  }] as const;
  const explicitAbsence = [{
    typeId: "settlement",
    status: "not_held",
    itemCount: 0,
    committedCount: 0,
    collection: { status: "complete", exclusionCounts: {} },
  }] as const;

  assert.equal(runResult({
    status: "no-data",
    excludedTimeDepositCount: 1,
    products: intentionalOnly,
  }), null, "intentional exclusions cannot be labeled as provider absence");
  assert.equal(runResult({
    status: "partial",
    excludedUnknownInstitutionCount: 1,
    products: incompleteWithoutReceipts,
  }), null, "a partial run requires at least one durable receipt");
  assert.equal(isWorkflowRunResult({
    status: "partial",
    counts: { excludedUnknownInstitutionCount: 1 },
    products: incompleteWithoutReceipts,
  }), false, "worker frames enforce the same status/evidence invariant");
  assert.equal(sanitizeTypedWorkflowOutcome({
    errorCode: "source-collection-failed",
    summary: {
      status: "no-data",
      counts: { excludedTimeDepositCount: 1 },
      products: intentionalOnly,
    },
  })?.summary, null, "persisted outcomes discard contradictory summaries");

  const failed = runResult({
    status: "failed",
    excludedUnknownInstitutionCount: 1,
    products: incompleteWithoutReceipts,
  });
  assert.ok(failed, "incomplete collection with no receipts remains a valid failure summary");
  assert.deepEqual(sanitizeTypedWorkflowOutcome({ errorCode: "cancelled", summary: failed }), {
    errorCode: "cancelled",
    summary: failed,
  }, "cancellation keeps its terminal code while preserving a failed zero-receipt snapshot");

  assert.ok(runResult({
    status: "completed",
    excludedTimeDepositCount: 1,
    products: intentionalOnly,
  }), "intentional exclusions with zero receipts are completed");
  assert.ok(runResult({
    status: "financial-admitted",
    committedCount: 1,
    itemCount: 1,
    hiddenAccountCount: 1,
    products: [{
      typeId: "settlement",
      status: "success",
      itemCount: 1,
      committedCount: 1,
      collection: { status: "complete_with_exclusions", exclusionCounts: { hiddenAccountCount: 1 } },
    }],
  }), "intentional exclusions remain compatible with durable financial receipts");
  assert.ok(runResult({
    status: "no-data",
    products: explicitAbsence,
  }), "explicit provider absence retains the no-data label");

  const completedLateCancellation = runResult({
    status: "completed",
    committedCount: 1,
    itemCount: 1,
    products: [{
      typeId: "settlement",
      status: "success",
      itemCount: 1,
      committedCount: 1,
      collection: { status: "complete", exclusionCounts: {} },
    }],
  });
  assert.ok(completedLateCancellation, "late cancellation may retain a complete snapshot with receipts");
  assert.deepEqual(sanitizeTypedWorkflowOutcome({ errorCode: "cancelled", summary: completedLateCancellation }), {
    errorCode: "cancelled",
    summary: completedLateCancellation,
  });

  const unknownCommit = runResult({
    status: "partial",
    committedCount: 1,
    itemCount: 1,
    excludedUnknownInstitutionCount: 1,
    products: [{
      typeId: "settlement",
      status: "failed",
      itemCount: 1,
      committedCount: 1,
      errorCode: "commit-outcome-unknown",
      collection: { status: "incomplete", exclusionCounts: { excludedUnknownInstitutionCount: 1 } },
    }],
  });
  assert.ok(unknownCommit, "a summary can retain known receipts and collection evidence despite an uncertain commit");
  assert.deepEqual(sanitizeTypedWorkflowOutcome({ errorCode: "commit-outcome-unknown", summary: unknownCommit }), {
    errorCode: "commit-outcome-unknown",
    summary: unknownCommit,
  });
});

test("three-product TDCC exclusion aggregates stay bounded through normal and interrupted summaries", () => {
  const perProductCounts = Object.fromEntries(
    TDCC_EXCLUSION_COUNT_NAMES.map((name) => [name, 333_333_333]),
  );
  const products = ["securities", "fund", "settlement"].map((typeId) => ({
    typeId,
    status: "success",
    itemCount: 1,
    committedCount: 1,
    collection: { status: "incomplete", exclusionCounts: perProductCounts },
  }));
  const aggregateCounts = Object.fromEntries(
    TDCC_EXCLUSION_COUNT_NAMES.map((name) => [name, 999_999_999]),
  );
  const normal = runResult({
    status: "partial",
    sourceCaptureCount: 3,
    rowCount: 0,
    itemCount: 3,
    committedCount: 3,
    ...aggregateCounts,
    products,
  });
  assert.ok(normal);
  assert.ok(Buffer.byteLength(JSON.stringify(normal), "utf8") <= 4_096);
  assert.equal(isWorkflowRunResult(normal), true);
  assert.deepEqual(sanitizeTypedWorkflowOutcome({ errorCode: "source-unavailable", summary: normal }), {
    errorCode: "source-unavailable",
    summary: normal,
  });

  const interrupted = summarizeInterruptedProductCollection(new ProductCollectionInterruptedError("source-unavailable", {
    products: normal.products!,
    sourceCaptureCount: 3,
    rowCount: 0,
    itemCount: 3,
    committedCount: 3,
    status: "partial",
  }));
  assert.ok(interrupted);
  assert.deepEqual(interrupted.counts, normal.counts);
  assert.deepEqual(interrupted.products, normal.products);
  assert.ok(Buffer.byteLength(JSON.stringify(interrupted), "utf8") <= 4_096);

  const overfullReceipts = ["securities", "fund", "settlement"].map((typeId) => ({
    typeId,
    status: "success",
    itemCount: 500_000_000,
    committedCount: 500_000_000,
    collection: { status: "incomplete", exclusionCounts: {} },
  }));
  assert.equal(runResult({ status: "partial", products: overfullReceipts }), null,
    "product receipt totals over the summary bound cannot pass when aggregate committedCount is omitted");
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
  assert.equal(
    classifyTypedWorkflowFailure(new ProviderProtocolOutdatedError(), [{
      runId: "run-1",
      stage: "authentication",
      outcome: "started", code: "authentication-started",
      occurredAt: "2026-10-10T00:00:00.000Z",
    }]),
    "provider-protocol-outdated",
  );
  assert.equal(classifyTypedWorkflowFailure(new Error("contains private account 123"), [{
    runId: "run-1",
    stage: "validation",
    outcome: "failed", code: "source-validation-rejected",
    occurredAt: "2026-09-25T00:00:00.000Z",
  }]), "source-validation-failed");
  // ADR 0056: commit stage events report progress; only Commit attempts decide the commit outcome.
  for (const [outcome, code] of [["failed", "canonical-commit-failed"], ["started", "canonical-commit-started"]] as const) {
    assert.equal(classifyTypedWorkflowFailure(new Error("provider disconnected"), [{
      runId: "run-1",
      stage: "commit",
      outcome,
      code,
      occurredAt: "2026-09-25T00:00:00.000Z",
    }]), "workflow-failed");
  }
  assert.equal(classifyTypedWorkflowFailure(new Error("user stopped"), [], true), "cancelled");
  assert.equal(classifyTypedWorkflowFailure(new Error("provider details"), [{
    runId: "run-1",
    stage: "authentication",
    outcome: "failed", signal: "verification-solver-exhausted", code: "verification-solver-exhausted",
    occurredAt: "2026-10-03T00:00:00.000Z",
  }]), "verification-failed");
  assert.equal(classifyTypedWorkflowFailure(new Error("private details"), [{
    runId: "run-1",
    stage: "authentication",
    outcome: "failed", signal: "solver-route-unavailable", code: "solver-route-unavailable",
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
    "verification-failed", "source-collection-failed", "browser-runtime-config-failed",
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

test("fallback stage diagnostics preserve cancellation and ignore commit events", () => {
  const event = (stage: WorkflowRunEvent["stage"], outcome: RunEventOutcome, code: string): WorkflowRunEvent => ({
    runId: "run-1", stage, outcome, code, occurredAt: "2026-09-29T12:00:00.000Z",
  });
  const error = new Error("private exception text");
  error.name = "TimeoutError";
  const auth = event("authentication", "started", "authentication-started");
  const finalized = event("finalization", "failed", "run-failed");
  assert.equal(classifyTypedWorkflowFailure(error, [auth, finalized], true), "cancelled");
  assert.equal(classifyTypedWorkflowFailure(error, [event("commit", "started", "canonical-commit-started"), auth, finalized]), "authentication-timeout");
  assert.equal(classifyTypedWorkflowFailure(error, [event("collection", "started", "collection-started"), event("preparation", "started", "run-started"), auth, finalized]), "authentication-timeout");
  assert.equal(classifyTypedWorkflowFailure(error, [event("authentication", "started", "authentication-started"), event("preparation", "started", "run-started"), finalized]), "workflow-failed");
});
