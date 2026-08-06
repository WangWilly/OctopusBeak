import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { hashBytes, stableStringify } from "../../../ledger/content-hash.ts";
import { createSqliteAgentRunStore } from "./store.ts";
import { createReadFinancialOverviewProposal, type AgentToolExecutionRecord } from "./tool-gateway.ts";

type RunRowOverrides = {
  analysisId?: string | null;
  phase?: string;
  startedAt?: string;
  finishedAt?: string | null;
};

function insertRun(
  root: string,
  runId: string,
  record: Record<string, unknown>,
  row: RunRowOverrides = {},
) {
  const db = openLedgerDatabase(root);
  db.prepare(`
    INSERT INTO agent_runs (run_id, analysis_id, phase, started_at, finished_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    row.analysisId ?? null,
    row.phase ?? "completed",
    row.startedAt ?? "2026-08-03T00:00:00.000Z",
    Object.hasOwn(row, "finishedAt")
      ? row.finishedAt ?? null
      : "2026-08-03T00:00:01.000Z",
    JSON.stringify(record),
  );
  db.close();
}

function insertLineage(
  root: string,
  runId: string,
  record: Record<string, unknown>,
  row: {
    seq?: number;
    kind?: string;
    status?: string;
    occurredAt?: string;
  } = {},
) {
  const db = openLedgerDatabase(root);
  db.prepare(`
    INSERT INTO agent_run_lineage (
      run_id, analysis_id, seq, kind, status, occurred_at, data_classes_json,
      secret_fields_json, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    null,
    row.seq ?? 1,
    row.kind ?? "run.completed",
    row.status ?? "observed",
    row.occurredAt ?? "2026-08-03T00:00:01.000Z",
    JSON.stringify(["prompt", "model-output"]),
    JSON.stringify([]),
    JSON.stringify(record),
  );
  db.close();
}

test("SQLite Agent records persist an explicit versioned envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-versioned-"));
  try {
    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    store.createRun({
      runId: "run-versioned",
      analysisId: null,
      phase: "running",
      startedAt: "2026-08-03T00:00:00.000Z",
      finishedAt: null,
      output: "",
      failureReason: null,
    });
    store.close();

    const db = openLedgerDatabase(root);
    const row = db.prepare(
      "SELECT record_json FROM agent_runs WHERE run_id = ?",
    ).get("run-versioned") as { record_json: string };
    db.close();
    const persisted = JSON.parse(row.record_json);
    assert.deepEqual(Object.keys(persisted).sort(), ["record", "recordVersion"]);
    assert.equal(persisted.recordVersion, 1);
    assert.equal(persisted.record.runId, "run-versioned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite Agent store decodes an explicit legacy record and rejects unknown versions", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-legacy-"));
  try {
    insertRun(root, "run-legacy", {
      runId: "run-legacy",
      analysisId: null,
      phase: "completed",
      startedAt: "2026-08-03T00:00:00.000Z",
      finishedAt: "2026-08-03T00:00:01.000Z",
    });
    insertRun(root, "run-future", {
      recordVersion: 2,
      record: {
        runId: "run-future",
      },
    });

    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    assert.deepEqual(store.getRun("run-legacy"), {
      runId: "run-legacy",
      analysisId: null,
      phase: "completed",
      startedAt: "2026-08-03T00:00:00.000Z",
      finishedAt: "2026-08-03T00:00:01.000Z",
      output: "",
      failureReason: null,
    });
    assert.throws(
      () => store.getRun("run-future"),
      /Unsupported Agent run record version/,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite Agent store rejects invalid values in a versioned record", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-invalid-"));
  try {
    insertRun(root, "run-invalid", {
      recordVersion: 1,
      record: {
        runId: "run-invalid",
        analysisId: null,
        phase: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:00:01.000Z",
        output: "",
        failureReason: "arbitrary-unbounded-reason",
      },
    });

    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    assert.throws(
      () => store.getRun("run-invalid"),
      /Invalid Agent run record/,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite Agent store rejects impossible v1 run states", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-invalid-run-state-"));
  try {
    insertRun(root, "run-completed-unfinished", {
      recordVersion: 1,
      record: {
        runId: "run-completed-unfinished",
        analysisId: null,
        phase: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: null,
        output: "",
        failureReason: null,
      },
    }, { finishedAt: null });
    insertRun(root, "run-failed-without-reason", {
      recordVersion: 1,
      record: {
        runId: "run-failed-without-reason",
        analysisId: null,
        phase: "failed",
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:00:01.000Z",
        output: "",
        failureReason: null,
      },
    }, { phase: "failed" });

    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    assert.throws(
      () => store.getRun("run-completed-unfinished"),
      /Invalid Agent run record/,
    );
    assert.throws(
      () => store.getRun("run-failed-without-reason"),
      /Invalid Agent run record/,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite Agent lineage persists a versioned envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-lineage-versioned-"));
  try {
    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    store.createRun({
      runId: "run-lineage-versioned",
      analysisId: null,
      phase: "completed",
      startedAt: "2026-08-03T00:00:00.000Z",
      finishedAt: "2026-08-03T00:00:01.000Z",
      output: "Done",
      failureReason: null,
    });
    store.appendLineage({
      runId: "run-lineage-versioned",
      analysisId: null,
      seq: 1,
      kind: "run.completed",
      status: "observed",
      occurredAt: "2026-08-03T00:00:01.000Z",
      dataClasses: ["prompt", "model-output"],
      providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
      osBuild: "25C56",
      providerAssurance: "verified-build",
      transitionReason: null,
      secretFields: [],
    });
    store.close();

    const db = openLedgerDatabase(root);
    const row = db.prepare(
      "SELECT record_json FROM agent_run_lineage WHERE run_id = ?",
    ).get("run-lineage-versioned") as { record_json: string };
    db.close();
    const persisted = JSON.parse(row.record_json);
    assert.deepEqual(Object.keys(persisted).sort(), ["record", "recordVersion"]);
    assert.equal(persisted.recordVersion, 1);
    assert.equal(persisted.record.runId, "run-lineage-versioned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite Agent store explicitly decodes legacy lineage and rejects future lineage versions", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-lineage-legacy-"));
  try {
    insertRun(root, "run-lineage-legacy", {
      runId: "run-lineage-legacy",
      analysisId: null,
      phase: "completed",
      startedAt: "2026-08-03T00:00:00.000Z",
      finishedAt: "2026-08-03T00:00:01.000Z",
    });
    insertLineage(root, "run-lineage-legacy", {
      runId: "run-lineage-legacy",
      analysisId: null,
      seq: 1,
      kind: "run.completed",
      status: "observed",
      occurredAt: "2026-08-03T00:00:01.000Z",
      dataClasses: ["prompt", "model-output"],
      secretFields: [],
    });
    insertRun(root, "run-lineage-future", {
      runId: "run-lineage-future",
      analysisId: null,
      phase: "completed",
      startedAt: "2026-08-03T00:00:00.000Z",
      finishedAt: "2026-08-03T00:00:01.000Z",
    });
    insertLineage(root, "run-lineage-future", {
      recordVersion: 2,
      record: {
        runId: "run-lineage-future",
      },
    });

    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    assert.deepEqual(store.getLineage("run-lineage-legacy"), [{
      runId: "run-lineage-legacy",
      analysisId: null,
      seq: 1,
      kind: "run.completed",
      status: "observed",
      occurredAt: "2026-08-03T00:00:01.000Z",
      dataClasses: ["prompt", "model-output"],
      providerIdentity: "unknown",
      osBuild: "unknown",
      providerAssurance: "unverified-build",
      transitionReason: null,
      secretFields: [],
    }]);
    assert.throws(
      () => store.getLineage("run-lineage-future"),
      /Unsupported Agent lineage record version/,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite Agent store rejects impossible v1 lineage states", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-invalid-lineage-state-"));
  try {
    for (const runId of ["run-completed-cancelled", "run-started-observed"]) {
      insertRun(root, runId, {
        runId,
        analysisId: null,
        phase: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:00:01.000Z",
      });
    }
    insertLineage(root, "run-completed-cancelled", {
      recordVersion: 1,
      record: {
        runId: "run-completed-cancelled",
        analysisId: null,
        seq: 1,
        kind: "run.completed",
        status: "observed",
        occurredAt: "2026-08-03T00:00:01.000Z",
        dataClasses: ["prompt", "model-output"],
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
        providerAssurance: "verified-build",
        transitionReason: "user-cancelled",
        secretFields: [],
      },
    });
    insertLineage(root, "run-started-observed", {
      recordVersion: 1,
      record: {
        runId: "run-started-observed",
        analysisId: null,
        seq: 1,
        kind: "run.started",
        status: "observed",
        occurredAt: "2026-08-03T00:00:01.000Z",
        dataClasses: ["prompt", "model-output"],
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
        providerAssurance: "verified-build",
        transitionReason: null,
        secretFields: [],
      },
    }, { kind: "run.started" });

    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    assert.throws(
      () => store.getLineage("run-completed-cancelled"),
      /Invalid Agent lineage record/,
    );
    assert.throws(
      () => store.getLineage("run-started-observed"),
      /Invalid Agent lineage record/,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite Agent store rejects whitespace-only v1 and present legacy lineage identity", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-blank-lineage-identity-"));
  try {
    for (const runId of ["run-blank-v1-provider", "run-blank-legacy-build"]) {
      insertRun(root, runId, {
        runId,
        analysisId: null,
        phase: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:00:01.000Z",
      });
    }
    insertLineage(root, "run-blank-v1-provider", {
      recordVersion: 1,
      record: {
        runId: "run-blank-v1-provider",
        analysisId: null,
        seq: 1,
        kind: "run.completed",
        status: "observed",
        occurredAt: "2026-08-03T00:00:01.000Z",
        dataClasses: ["prompt", "model-output"],
        providerIdentity: "   ",
        osBuild: "25C56",
        providerAssurance: "verified-build",
        transitionReason: null,
        secretFields: [],
      },
    });
    insertLineage(root, "run-blank-legacy-build", {
      runId: "run-blank-legacy-build",
      analysisId: null,
      seq: 1,
      kind: "run.completed",
      status: "observed",
      occurredAt: "2026-08-03T00:00:01.000Z",
      dataClasses: ["prompt", "model-output"],
      providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
      osBuild: " \t ",
      secretFields: [],
    });

    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    assert.throws(
      () => store.getLineage("run-blank-v1-provider"),
      /Invalid Agent lineage record/,
    );
    assert.throws(
      () => store.getLineage("run-blank-legacy-build"),
      /Invalid Agent lineage record/,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite Agent store persists durable Authorized tool outcomes and replays validated results", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-tool-outcomes-"));
  try {
    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    store.createRun({
      runId: "run-tool-store",
      analysisId: null,
      phase: "running",
      startedAt: "2026-08-04T00:00:00.000Z",
      finishedAt: null,
      output: "",
      failureReason: null,
    });
    const proposal = createReadFinancialOverviewProposal("run-tool-store", "request-store");
    const resultData: NonNullable<AgentToolExecutionRecord["result"]> = {
      resultVersion: "agent-tool-result.v1",
      toolName: "read_financial_overview",
      data: {
        aggregateVersion: "financial-overview.aggregate.v1",
        snapshot: { snapshotId: "snapshot", importedAt: null, snapshotDate: null },
        totalsByCurrency: {},
        overview: {
          cashAssets: {}, foreignAssets: {}, investmentAssets: {},
          unbilledCreditCard: {}, loans: {}, netAssets: {},
        },
        counts: { normalizedTransactions: 0, assetPositions: 0, includedPositions: 0, assetSnapshots: 0 },
        quality: { status: "pass", issueCount: 0 },
      },
      reference: { referenceVersion: "immutable-result-ref.v1", value: "" },
      secretFields: [],
    };
    resultData.reference.value = `immutable-result-ref.v1:${hashBytes(stableStringify(resultData.data))}`;
    const record: AgentToolExecutionRecord = {
      runId: "run-tool-store",
      requestId: "request-store",
      proposal,
      decision: {
        decisionVersion: "agent-tool-decision.v1",
        allowed: true,
        reason: "allowed",
      },
      outcome: "completed",
      result: resultData,
    resultReference: resultData.reference,
      occurredAt: "2026-08-04T00:00:01.000Z",
    };
    store.recordToolRequest?.(record);
    store.appendLineage({
      runId: "run-tool-store",
      analysisId: null,
      seq: 1,
      kind: "tool.proposal",
      status: "proposed",
      occurredAt: "2026-08-04T00:00:01.000Z",
      dataClasses: ["financial.derived"],
      providerIdentity: "test-provider",
      osBuild: "test",
      providerAssurance: "unverified-build",
      transitionReason: null,
      secretFields: [],
      tool: { requestId: "request-store", toolName: "read_financial_overview", proposal },
    });
    store.close();

    const reopened = createSqliteAgentRunStore(root, { secretValues: [] });
    assert.deepEqual(reopened.getToolRequest?.("run-tool-store", "request-store"), record);
    assert.deepEqual(reopened.listToolRequests?.("run-tool-store"), [record]);
    assert.deepEqual(reopened.getLineage("run-tool-store")[0]?.tool, {
      requestId: "request-store",
      toolName: "read_financial_overview",
      proposal,
    });
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite Agent lineage rejects a malformed tool payload at the existing invalid-record boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-lineage-invalid-tool-"));
  try {
    insertRun(root, "run-lineage-invalid-tool", {
      recordVersion: 1,
      record: {
        runId: "run-lineage-invalid-tool",
        analysisId: null,
        phase: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:00:01.000Z",
        output: "",
        failureReason: null,
      },
    });
    insertLineage(root, "run-lineage-invalid-tool", {
      recordVersion: 1,
      record: {
        runId: "run-lineage-invalid-tool",
        analysisId: null,
        seq: 1,
        kind: "tool.proposal",
        status: "proposed",
        occurredAt: "2026-08-03T00:00:01.000Z",
        dataClasses: ["financial.derived"],
        providerIdentity: "test-provider",
        osBuild: "test",
        providerAssurance: "unverified-build",
        transitionReason: null,
        secretFields: [],
        tool: {
          requestId: "request-lineage-invalid-tool",
          toolName: "",
        },
      },
    });

    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    assert.throws(
      () => store.getLineage("run-lineage-invalid-tool"),
      /Invalid Agent lineage record/,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite tool outcomes are monotonic and never regress a terminal result", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-tool-monotonic-"));
  try {
    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    store.createRun({
      runId: "run-tool-monotonic",
      analysisId: null,
      phase: "running",
      startedAt: "2026-08-04T00:00:00.000Z",
      finishedAt: null,
      output: "",
      failureReason: null,
    });
    const proposal = createReadFinancialOverviewProposal("run-tool-monotonic", "request-monotonic");
    const data: NonNullable<AgentToolExecutionRecord["result"]>["data"] = {
      aggregateVersion: "financial-overview.aggregate.v1",
      snapshot: { snapshotId: "snapshot", importedAt: null, snapshotDate: null },
      totalsByCurrency: {},
      overview: {
        cashAssets: {}, foreignAssets: {}, investmentAssets: {},
        unbilledCreditCard: {}, loans: {}, netAssets: {},
      },
      counts: { normalizedTransactions: 0, assetPositions: 0, includedPositions: 0, assetSnapshots: 0 },
      quality: { status: "pass", issueCount: 0 },
    };
    const completedResult: NonNullable<AgentToolExecutionRecord["result"]> = {
      resultVersion: "agent-tool-result.v1",
      toolName: "read_financial_overview",
      data,
      reference: {
        referenceVersion: "immutable-result-ref.v1",
        value: `immutable-result-ref.v1:${hashBytes(stableStringify(data))}`,
      },
      secretFields: [],
    };
    const base: AgentToolExecutionRecord = {
      runId: "run-tool-monotonic",
      requestId: "request-monotonic",
      proposal,
      decision: { decisionVersion: "agent-tool-decision.v1", allowed: true, reason: "allowed" },
      outcome: "outcome-unknown",
      result: null,
      resultReference: null,
      occurredAt: "2026-08-04T00:00:01.000Z",
    };
    store.recordToolRequest?.(base);
    store.recordToolRequest?.({
      ...base,
      outcome: "completed",
      result: completedResult,
      resultReference: completedResult.reference,
      occurredAt: "2026-08-04T00:00:02.000Z",
    });
    store.recordToolRequest?.({
      ...base,
      decision: { decisionVersion: "agent-tool-decision.v1", allowed: false, reason: "run-authority-denied" },
      outcome: "not-dispatched",
      occurredAt: "2026-08-04T00:00:03.000Z",
    });
    const persisted = store.getToolRequest?.("run-tool-monotonic", "request-monotonic");
    assert.equal(persisted?.outcome, "outcome-unknown");
    assert.equal(persisted?.result, null);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite tool outcome upgrades synchronize denormalized proposal and decision columns", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-tool-denormalized-update-"));
  try {
    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    store.createRun({
      runId: "run-tool-denormalized-update",
      analysisId: null,
      phase: "running",
      startedAt: "2026-08-04T00:00:00.000Z",
      finishedAt: null,
      output: "",
      failureReason: null,
    });
    const requestId = "request-denormalized-update";
    const proposalA = {
      ...createReadFinancialOverviewProposal("run-tool-denormalized-update", requestId),
      runAuthority: "other-run",
    };
    const proposalB = createReadFinancialOverviewProposal("run-tool-denormalized-update", requestId);
    const decisionA = {
      decisionVersion: "agent-tool-decision.v1" as const,
      allowed: false,
      reason: "run-authority-denied" as const,
    };
    const decisionB = {
      decisionVersion: "agent-tool-decision.v1" as const,
      allowed: true,
      reason: "allowed" as const,
    };
    const initial: AgentToolExecutionRecord = {
      runId: "run-tool-denormalized-update",
      requestId,
      proposal: proposalA,
      decision: decisionA,
      outcome: "not-dispatched",
      result: null,
      resultReference: null,
      occurredAt: "2026-08-04T00:00:01.000Z",
    };
    const stable = {
      ...initial,
      requestId: "request-stable",
      proposal: {
        ...createReadFinancialOverviewProposal("run-tool-denormalized-update", "request-stable"),
        runAuthority: "other-run",
      },
      occurredAt: "2026-08-04T00:00:02.000Z",
    } satisfies AgentToolExecutionRecord;
    store.recordToolRequest?.(initial);
    store.recordToolRequest?.(stable);
    store.recordToolRequest?.({
      ...initial,
      proposal: proposalB,
      decision: decisionB,
      outcome: "outcome-unknown",
      occurredAt: "2026-08-04T00:00:03.000Z",
    });
    store.close();

    const db = openLedgerDatabase(root);
    const rows = db.prepare(`
      SELECT request_id, outcome, result_json, proposal_json, decision_json, occurred_at, record_json
      FROM agent_tool_outcomes
      WHERE run_id = ?
      ORDER BY occurred_at, request_id
    `).all("run-tool-denormalized-update") as Array<{
      request_id: string;
      outcome: string;
      result_json: string | null;
      proposal_json: string;
      decision_json: string;
      occurred_at: string;
      record_json: string;
    }>;
    assert.deepEqual(rows.map((row) => row.request_id), ["request-stable", requestId]);
    const updated = rows.find((row) => row.request_id === requestId);
    assert.ok(updated);
    const persisted = JSON.parse(updated.record_json) as {
      record: AgentToolExecutionRecord;
    };
    assert.equal(updated.proposal_json, JSON.stringify(persisted.record.proposal));
    assert.equal(updated.decision_json, JSON.stringify(persisted.record.decision));
    assert.deepEqual(persisted.record.proposal, proposalB);
    assert.deepEqual(persisted.record.decision, decisionB);
    assert.equal(updated.outcome, "outcome-unknown");
    assert.equal(updated.result_json, null);
    assert.equal(updated.occurred_at, "2026-08-04T00:00:03.000Z");
    db.close();

    const reopened = createSqliteAgentRunStore(root, { secretValues: [] });
    assert.deepEqual(reopened.getToolRequest?.("run-tool-denormalized-update", requestId), {
      ...initial,
      proposal: proposalB,
      decision: decisionB,
      outcome: "outcome-unknown",
      occurredAt: "2026-08-04T00:00:03.000Z",
    });
    assert.deepEqual(
      reopened.listToolRequests?.("run-tool-denormalized-update").map((item) => [
        item.requestId,
        item.outcome,
        item.occurredAt,
        item.result,
      ]),
      [
        ["request-stable", "not-dispatched", "2026-08-04T00:00:02.000Z", null],
        [requestId, "outcome-unknown", "2026-08-04T00:00:03.000Z", null],
      ],
    );
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite tool outcome upgrades update occurred_at for durable ordering and record replay", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-store-tool-ordering-"));
  try {
    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    store.createRun({
      runId: "run-tool-ordering",
      analysisId: null,
      phase: "running",
      startedAt: "2026-08-04T00:00:00.000Z",
      finishedAt: null,
      output: "",
      failureReason: null,
    });
    const record = (requestId: string, outcome: AgentToolExecutionRecord["outcome"], occurredAt: string): AgentToolExecutionRecord => ({
      runId: "run-tool-ordering",
      requestId,
      proposal: createReadFinancialOverviewProposal("run-tool-ordering", requestId),
      decision: {
        decisionVersion: "agent-tool-decision.v1",
        allowed: outcome !== "not-dispatched",
        reason: outcome === "not-dispatched" ? "run-authority-denied" : "allowed",
      },
      outcome,
      result: null,
      resultReference: null,
      occurredAt,
    });
    const first = record("request-first", "not-dispatched", "2026-08-04T00:00:01.000Z");
    const second = record("request-second", "not-dispatched", "2026-08-04T00:00:02.000Z");
    store.recordToolRequest?.(first);
    store.recordToolRequest?.(second);
    const upgraded = record("request-first", "outcome-unknown", "2026-08-04T00:00:03.000Z");
    store.recordToolRequest?.(upgraded);
    store.close();

    const db = openLedgerDatabase(root);
    const rows = db.prepare(`
      SELECT request_id, occurred_at, record_json
      FROM agent_tool_outcomes
      WHERE run_id = ?
      ORDER BY occurred_at, request_id
    `).all("run-tool-ordering") as Array<{
      request_id: string;
      occurred_at: string;
      record_json: string;
    }>;
    assert.deepEqual(rows.map((row) => row.request_id), ["request-second", "request-first"]);
    assert.deepEqual(
      rows.map((row) => [row.request_id, row.occurred_at, JSON.parse(row.record_json).record.occurredAt]),
      [
        ["request-second", "2026-08-04T00:00:02.000Z", "2026-08-04T00:00:02.000Z"],
        ["request-first", "2026-08-04T00:00:03.000Z", "2026-08-04T00:00:03.000Z"],
      ],
    );
    db.close();

    const reopened = createSqliteAgentRunStore(root, { secretValues: [] });
    assert.deepEqual(
      reopened.listToolRequests?.("run-tool-ordering").map((item) => [item.requestId, item.outcome, item.occurredAt]),
      [
        ["request-second", "not-dispatched", "2026-08-04T00:00:02.000Z"],
        ["request-first", "outcome-unknown", "2026-08-04T00:00:03.000Z"],
      ],
    );
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
