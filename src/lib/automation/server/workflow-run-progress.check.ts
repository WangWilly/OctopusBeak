import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationTaskProgress } from "../types.ts";
import type { WorkflowRunEvent } from "../workflow-executor.ts";
import { projectWorkflowRunProgress } from "./workflow-run-progress.ts";

const selectedTypes = ["domestic", "foreign_currency"] as const;

function progress(overrides: Partial<AutomationTaskProgress> = {}): AutomationTaskProgress {
  return {
    phaseCode: null,
    completed: null,
    total: null,
    percent: 0,
    attempt: 2,
    ...overrides,
  };
}

function event(overrides: Partial<WorkflowRunEvent> = {}): WorkflowRunEvent {
  return {
    runId: "run-progress-test",
    stage: "collection",
    code: "statement-query-started",
    occurredAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

test("selected products receive separate query/download slices and unscoped inner events stay in the current slice", () => {
  const domesticQuery = projectWorkflowRunProgress(event({
    statementType: "domestic",
    activity: "query",
  }), progress(), selectedTypes);
  assert.ok(domesticQuery);
  assert.equal(domesticQuery.params?.statementType, "domestic");

  const domesticDownload = projectWorkflowRunProgress(event({
    statementType: "domestic",
    activity: "download",
    code: "statement-download-started",
  }), domesticQuery, selectedTypes);
  assert.ok(domesticDownload);
  assert.ok((domesticDownload.percent ?? 0) > (domesticQuery.percent ?? 0));

  const domesticCommit = projectWorkflowRunProgress(event({
    stage: "commit",
    code: "canonical-commit-completed",
    statementType: "domestic",
  }), domesticDownload, selectedTypes);
  assert.ok(domesticCommit);

  const unscopedDecoding = projectWorkflowRunProgress(event({
    stage: "decoding",
    code: "source-decoding-completed",
  }), domesticCommit, selectedTypes);
  assert.ok(unscopedDecoding);
  assert.equal(unscopedDecoding.params?.statementType, "domestic");
  assert.ok((unscopedDecoding.percent ?? 0) <= (domesticCommit.percent ?? 0));

  const foreignQuery = projectWorkflowRunProgress(event({
    statementType: "foreign_currency",
    activity: "query",
  }), unscopedDecoding, selectedTypes);
  assert.ok(foreignQuery);
  assert.ok((foreignQuery.percent ?? 0) > (domesticCommit.percent ?? 0));

  const foreignDownload = projectWorkflowRunProgress(event({
    statementType: "foreign_currency",
    activity: "download",
    code: "statement-download-started",
  }), foreignQuery, selectedTypes);
  assert.ok(foreignDownload);
  assert.ok((foreignDownload.percent ?? 0) > (foreignQuery.percent ?? 0));
});

test("failed and terminal stage events preserve the last advisory percent", () => {
  const prior = progress({
    phaseCode: "workflow-validation",
    percent: 71,
    params: { statementType: "foreign_currency" },
  });
  assert.equal(projectWorkflowRunProgress(event({
    stage: "validation",
    code: "source-validation-rejected",
    statementType: "foreign_currency",
  }), prior, selectedTypes), null);
  assert.equal(projectWorkflowRunProgress(event({
    stage: "finalization",
    code: "run-completed",
  }), prior, selectedTypes), null);
});

test("generic inner events in a multi-product workflow are bounded to its first selected slice", () => {
  const genericCommit = projectWorkflowRunProgress(event({
    stage: "commit",
    code: "canonical-commit-completed",
  }), progress(), selectedTypes);
  assert.ok(genericCommit);
  assert.equal(genericCommit.params?.statementType, "domestic");
  assert.ok((genericCommit.percent ?? 100) < 60);
});
