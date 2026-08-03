import { openLedgerDatabase, type LedgerDatabase } from "../../../ledger/db/client.ts";
import { secretBoundaryFailureMessage } from "../../automation/server/secret-boundary.ts";
import {
  createAgentSecretBoundaryGate,
  type AgentLineageEvent,
  type AgentRunRecord,
  type AgentRunStore,
  type SecretBoundaryDependencies,
  type SecretBoundaryGate,
} from "./harness.ts";

type AgentStoreOptions = {
  secretValues?: readonly string[];
  additionalSecretValues?: readonly string[];
  secretBoundaryDependencies?: Partial<SecretBoundaryDependencies>;
};

function protectRecord<T extends Record<string, unknown>>(
  gate: SecretBoundaryGate,
  schema: "agent-run" | "agent-lineage",
  record: T,
) {
  const protectedRecord = gate.protectRecord("sqlite-persistence", schema, record);
  if (protectedRecord.failure) {
    throw new Error(secretBoundaryFailureMessage(protectedRecord.failure));
  }
  return protectedRecord.value as T;
}

function rowToRun(row: Record<string, unknown>): AgentRunRecord {
  return {
    runId: String(row.run_id),
    analysisId: row.analysis_id === null || row.analysis_id === undefined
      ? null
      : String(row.analysis_id),
    phase: row.phase as AgentRunRecord["phase"],
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined
      ? null
      : String(row.finished_at),
  };
}

function rowToLineage(row: Record<string, unknown>): AgentLineageEvent {
  return {
    runId: String(row.run_id),
    analysisId: row.analysis_id === null || row.analysis_id === undefined
      ? null
      : String(row.analysis_id),
    seq: Number(row.seq),
    kind: row.kind as AgentLineageEvent["kind"],
    status: row.status as AgentLineageEvent["status"],
    occurredAt: String(row.occurred_at),
    dataClasses: JSON.parse(String(row.data_classes_json)) as string[],
    secretFields: [],
  };
}

export function createSqliteAgentRunStore(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  options: AgentStoreOptions = {},
): AgentRunStore & { close(): void } {
  const db = openLedgerDatabase(ledgerDir);
  const gate = createAgentSecretBoundaryGate({
    secretValues: options.secretValues,
    additionalSecretValues: options.additionalSecretValues,
    dependencies: options.secretBoundaryDependencies,
  });

  function requireRun(runId: string) {
    const row = db.prepare("SELECT * FROM agent_runs WHERE run_id = ?").get(runId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error("Agent run not found.");
    return row;
  }

  return {
    createRun(record) {
      const protectedRecord = protectRecord(
        gate,
        "agent-run",
        record as unknown as Record<string, unknown>,
      ) as unknown as AgentRunRecord;
      db.prepare(`
        INSERT INTO agent_runs (run_id, analysis_id, phase, started_at, finished_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        protectedRecord.runId,
        protectedRecord.analysisId,
        protectedRecord.phase,
        protectedRecord.startedAt,
        protectedRecord.finishedAt,
        JSON.stringify(protectedRecord),
      );
    },
    getRun(runId) {
      const row = db.prepare("SELECT * FROM agent_runs WHERE run_id = ?").get(runId) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToRun(row) : null;
    },
    updateRun(runId, update) {
      const current = rowToRun(requireRun(runId));
      const next = { ...current, ...update };
      const protectedRecord = protectRecord(
        gate,
        "agent-run",
        next as unknown as Record<string, unknown>,
      ) as unknown as AgentRunRecord;
      db.prepare(`
        UPDATE agent_runs
        SET analysis_id = ?, phase = ?, started_at = ?, finished_at = ?, record_json = ?
        WHERE run_id = ?
      `).run(
        protectedRecord.analysisId,
        protectedRecord.phase,
        protectedRecord.startedAt,
        protectedRecord.finishedAt,
        JSON.stringify(protectedRecord),
        protectedRecord.runId,
      );
    },
    appendLineage(event) {
      const protectedEvent = protectRecord(
        gate,
        "agent-lineage",
        event as unknown as Record<string, unknown>,
      ) as unknown as AgentLineageEvent;
      db.prepare(`
        INSERT INTO agent_run_lineage (
          run_id, analysis_id, seq, kind, status, occurred_at, data_classes_json,
          secret_fields_json, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        protectedEvent.runId,
        protectedEvent.analysisId,
        protectedEvent.seq,
        protectedEvent.kind,
        protectedEvent.status,
        protectedEvent.occurredAt,
        JSON.stringify(protectedEvent.dataClasses),
        JSON.stringify(protectedEvent.secretFields),
        JSON.stringify(protectedEvent),
      );
    },
    getLineage(runId) {
      const rows = db.prepare(`
        SELECT * FROM agent_run_lineage
        WHERE run_id = ?
        ORDER BY seq ASC
      `).all(runId) as Record<string, unknown>[];
      return rows.map(rowToLineage);
    },
    close() {
      db.close();
    },
  };
}

export type { AgentStoreOptions };
