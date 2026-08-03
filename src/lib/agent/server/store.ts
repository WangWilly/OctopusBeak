import { openLedgerDatabase, type LedgerDatabase } from "../../../ledger/db/client.ts";
import { secretBoundaryFailureMessage } from "../../automation/server/secret-boundary.ts";
import {
  AGENT_FAILURE_REASONS,
  createAgentSecretBoundaryGate,
  isAgentFailureReason,
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

const AGENT_RECORD_VERSION = 1 as const;
const AGENT_RUN_PHASES: readonly AgentRunRecord["phase"][] = [
  "running",
  "completed",
  "cancelled",
  "failed",
];
const AGENT_LINEAGE_KINDS: readonly AgentLineageEvent["kind"][] = [
  "run.started",
  "run.completed",
  "run.cancelled",
  "run.failed",
];
const AGENT_LINEAGE_STATUSES: readonly AgentLineageEvent["status"][] = [
  "allowed",
  "observed",
];
const AGENT_PROVIDER_ASSURANCES: readonly AgentLineageEvent["providerAssurance"][] = [
  "verified-build",
  "unverified-build",
];
const AGENT_TRANSITION_REASONS: readonly Exclude<
  AgentLineageEvent["transitionReason"],
  null
>[] = [...AGENT_FAILURE_REASONS, "user-cancelled"];

const RUN_RECORD_KEYS = [
  "runId",
  "analysisId",
  "phase",
  "startedAt",
  "finishedAt",
  "output",
  "failureReason",
] as const;
const LEGACY_RUN_REQUIRED_KEYS = RUN_RECORD_KEYS.slice(0, 5);
const LINEAGE_RECORD_KEYS = [
  "runId",
  "analysisId",
  "seq",
  "kind",
  "status",
  "occurredAt",
  "dataClasses",
  "providerIdentity",
  "osBuild",
  "providerAssurance",
  "transitionReason",
  "secretFields",
] as const;
const LEGACY_LINEAGE_REQUIRED_KEYS = [
  "runId",
  "analysisId",
  "seq",
  "kind",
  "status",
  "occurredAt",
  "dataClasses",
  "secretFields",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyExpectedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
) {
  return Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseJsonRecord(raw: unknown, message: string): Record<string, unknown> {
  try {
    const value = JSON.parse(String(raw)) as unknown;
    if (!isRecord(value)) throw new Error(message);
    return value;
  } catch {
    throw new Error(message);
  }
}

function isValidV1RunState(value: Record<string, unknown>) {
  switch (value.phase) {
    case "running":
      return value.finishedAt === null && value.failureReason === null;
    case "completed":
    case "cancelled":
      return typeof value.finishedAt === "string"
        && value.finishedAt.length > 0
        && value.failureReason === null;
    case "failed":
      return typeof value.finishedAt === "string"
        && value.finishedAt.length > 0
        && isAgentFailureReason(value.failureReason);
    default:
      return false;
  }
}

function decodeRunRecord(
  value: unknown,
  legacy: boolean,
): AgentRunRecord {
  if (!isRecord(value)
    || !hasOnlyExpectedKeys(
      value,
      RUN_RECORD_KEYS,
      legacy ? LEGACY_RUN_REQUIRED_KEYS : RUN_RECORD_KEYS,
    )
    || typeof value.runId !== "string"
    || value.runId.length === 0
    || !isNullableString(value.analysisId)
    || !AGENT_RUN_PHASES.includes(value.phase as AgentRunRecord["phase"])
    || typeof value.startedAt !== "string"
    || value.startedAt.length === 0
    || !isNullableString(value.finishedAt)
    || (!legacy && typeof value.output !== "string")
    || (value.output !== undefined && typeof value.output !== "string")
    || (!legacy && !Object.hasOwn(value, "failureReason"))
    || (value.failureReason !== undefined
      && value.failureReason !== null
      && !AGENT_FAILURE_REASONS.includes(
        value.failureReason as (typeof AGENT_FAILURE_REASONS)[number],
      ))
    || (!legacy && !isValidV1RunState(value))) {
    throw new Error("Invalid Agent run record.");
  }
  return {
    runId: value.runId,
    analysisId: value.analysisId,
    phase: value.phase as AgentRunRecord["phase"],
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    output: typeof value.output === "string" ? value.output : "",
    failureReason: value.failureReason === undefined
      ? null
      : value.failureReason as AgentRunRecord["failureReason"],
  };
}

function decodeLegacyRunRecord(value: unknown): AgentRunRecord {
  return decodeRunRecord(value, true);
}

function decodePersistedRunRecord(raw: unknown): AgentRunRecord {
  const value = parseJsonRecord(raw, "Invalid Agent run record.");
  if (!Object.hasOwn(value, "recordVersion")) {
    return decodeLegacyRunRecord(value);
  }
  if (value.recordVersion !== AGENT_RECORD_VERSION) {
    throw new Error("Unsupported Agent run record version.");
  }
  if (!hasOnlyExpectedKeys(value, ["recordVersion", "record"], ["recordVersion", "record"])) {
    throw new Error("Invalid Agent run record.");
  }
  return decodeRunRecord(value.record, false);
}

function isValidV1LineageState(value: Record<string, unknown>) {
  switch (value.kind) {
    case "run.started":
      return value.status === "allowed" && value.transitionReason === null;
    case "run.completed":
      return value.status === "observed" && value.transitionReason === null;
    case "run.cancelled":
      return value.status === "observed" && value.transitionReason === "user-cancelled";
    case "run.failed":
      return value.status === "observed" && isAgentFailureReason(value.transitionReason);
    default:
      return false;
  }
}

function decodeLineageRecord(
  value: unknown,
  legacy: boolean,
): AgentLineageEvent {
  if (!isRecord(value)
    || !hasOnlyExpectedKeys(
      value,
      LINEAGE_RECORD_KEYS,
      legacy ? LEGACY_LINEAGE_REQUIRED_KEYS : LINEAGE_RECORD_KEYS,
    )
    || typeof value.runId !== "string"
    || value.runId.length === 0
    || !isNullableString(value.analysisId)
    || !Number.isSafeInteger(value.seq)
    || (value.seq as number) < 1
    || !AGENT_LINEAGE_KINDS.includes(value.kind as AgentLineageEvent["kind"])
    || !AGENT_LINEAGE_STATUSES.includes(value.status as AgentLineageEvent["status"])
    || typeof value.occurredAt !== "string"
    || value.occurredAt.length === 0
    || !isStringArray(value.dataClasses)
    || (!legacy && (typeof value.providerIdentity !== "string"
      || value.providerIdentity.trim().length === 0))
    || (value.providerIdentity !== undefined
      && (typeof value.providerIdentity !== "string"
        || value.providerIdentity.trim().length === 0))
    || (!legacy && (typeof value.osBuild !== "string"
      || value.osBuild.trim().length === 0))
    || (value.osBuild !== undefined
      && (typeof value.osBuild !== "string" || value.osBuild.trim().length === 0))
    || (!legacy && !AGENT_PROVIDER_ASSURANCES.includes(
      value.providerAssurance as AgentLineageEvent["providerAssurance"],
    ))
    || (value.providerAssurance !== undefined
      && !AGENT_PROVIDER_ASSURANCES.includes(
        value.providerAssurance as AgentLineageEvent["providerAssurance"],
      ))
    || (!legacy && !Object.hasOwn(value, "transitionReason"))
    || (value.transitionReason !== undefined
      && value.transitionReason !== null
      && !AGENT_TRANSITION_REASONS.includes(
        value.transitionReason as Exclude<AgentLineageEvent["transitionReason"], null>,
      ))
    || !Array.isArray(value.secretFields)
    || value.secretFields.length !== 0
    || (!legacy && !isValidV1LineageState(value))) {
    throw new Error("Invalid Agent lineage record.");
  }
  return {
    runId: value.runId,
    analysisId: value.analysisId,
    seq: value.seq as number,
    kind: value.kind as AgentLineageEvent["kind"],
    status: value.status as AgentLineageEvent["status"],
    occurredAt: value.occurredAt,
    dataClasses: value.dataClasses,
    providerIdentity: typeof value.providerIdentity === "string"
      ? value.providerIdentity
      : "unknown",
    osBuild: typeof value.osBuild === "string" ? value.osBuild : "unknown",
    providerAssurance: value.providerAssurance === "verified-build"
      ? "verified-build"
      : "unverified-build",
    transitionReason: value.transitionReason === undefined
      ? null
      : value.transitionReason as AgentLineageEvent["transitionReason"],
    secretFields: [],
  };
}

function decodeLegacyLineageRecord(value: unknown): AgentLineageEvent {
  return decodeLineageRecord(value, true);
}

function decodePersistedLineageRecord(raw: unknown): AgentLineageEvent {
  const value = parseJsonRecord(raw, "Invalid Agent lineage record.");
  if (!Object.hasOwn(value, "recordVersion")) {
    return decodeLegacyLineageRecord(value);
  }
  if (value.recordVersion !== AGENT_RECORD_VERSION) {
    throw new Error("Unsupported Agent lineage record version.");
  }
  if (!hasOnlyExpectedKeys(value, ["recordVersion", "record"], ["recordVersion", "record"])) {
    throw new Error("Invalid Agent lineage record.");
  }
  return decodeLineageRecord(value.record, false);
}

function encodeRecord(
  record: AgentRunRecord | AgentLineageEvent,
) {
  return JSON.stringify({
    recordVersion: AGENT_RECORD_VERSION,
    record,
  });
}

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
  const record = decodePersistedRunRecord(row.record_json);
  if (row.run_id !== record.runId
    || row.analysis_id !== record.analysisId
    || row.phase !== record.phase
    || row.started_at !== record.startedAt
    || row.finished_at !== record.finishedAt) {
    throw new Error("Invalid Agent run record.");
  }
  return record;
}

function rowToLineage(row: Record<string, unknown>): AgentLineageEvent {
  const record = decodePersistedLineageRecord(row.record_json);
  const dataClasses = (() => {
    try {
      const value = JSON.parse(String(row.data_classes_json)) as unknown;
      if (!isStringArray(value)) throw new Error();
      return value;
    } catch {
      throw new Error("Invalid Agent lineage record.");
    }
  })();
  const secretFields = (() => {
    try {
      const value = JSON.parse(String(row.secret_fields_json)) as unknown;
      if (!Array.isArray(value) || value.length !== 0) throw new Error();
      return value;
    } catch {
      throw new Error("Invalid Agent lineage record.");
    }
  })();
  if (row.run_id !== record.runId
    || row.analysis_id !== record.analysisId
    || row.seq !== record.seq
    || row.kind !== record.kind
    || row.status !== record.status
    || row.occurred_at !== record.occurredAt
    || dataClasses.length !== record.dataClasses.length
    || dataClasses.some((value, index) => value !== record.dataClasses[index])
    || secretFields.length !== record.secretFields.length) {
    throw new Error("Invalid Agent lineage record.");
  }
  return record;
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
        encodeRecord(protectedRecord),
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
        encodeRecord(protectedRecord),
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
        encodeRecord(protectedEvent),
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
