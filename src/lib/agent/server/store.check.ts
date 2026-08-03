import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { createSqliteAgentRunStore } from "./store.ts";

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
