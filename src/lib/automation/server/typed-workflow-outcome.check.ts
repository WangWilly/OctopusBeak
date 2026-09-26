import assert from "node:assert/strict";
import test from "node:test";
import { SourceTextIntegrityError } from "../source-text.ts";
import { SourceAccessChallengeError } from "../source-access.ts";
import {
  classifyTypedWorkflowFailure,
  summarizeTypedWorkflowOutput,
} from "./typed-workflow-outcome.ts";

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

test("typed failures use stable privacy-safe categories", () => {
  assert.equal(
    classifyTypedWorkflowFailure(new SourceTextIntegrityError("invalid-encoding"), []),
    "source-integrity-failed",
  );
  assert.equal(
    classifyTypedWorkflowFailure(new SourceAccessChallengeError(), []),
    "source-access-challenged",
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
