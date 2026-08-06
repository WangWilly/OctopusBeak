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
import {
  AGENT_TOOL_DECISION_REASONS,
  AGENT_TOOL_OUTCOMES,
  AGENT_TOOL_PROPOSAL_VERSION,
  AGENT_TOOL_DECISION_VERSION,
  AGENT_TOOL_RESULT_VERSION,
  AGENT_TOOL_REFERENCE_VERSION,
  AGENT_TOOL_SETTLEMENTS,
  validateAgentToolResult,
  type AgentToolExecutionRecord,
} from "./tool-gateway.ts";

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
  "tool.proposal",
  "tool.decision",
  "tool.outcome",
];
const AGENT_LINEAGE_STATUSES: readonly AgentLineageEvent["status"][] = [
  "allowed",
  "observed",
  "proposed",
  "blocked",
];
const AGENT_PROVIDER_ASSURANCES: readonly AgentLineageEvent["providerAssurance"][] = [
  "verified-build",
  "unverified-build",
];
const AGENT_TRANSITION_REASONS: readonly Exclude<
  AgentLineageEvent["transitionReason"],
  null
>[] = [...AGENT_FAILURE_REASONS, "user-cancelled"];

const AGENT_TOOL_OUTCOME_RANK = {
  "not-dispatched": 1,
  "outcome-unknown": 2,
  completed: 3,
} as const;

/**
 * A durable unknown outcome is terminal. The one explicitly recorded
 * cancellation settlement is the only case where a later, already in-flight
 * completion may be retained; all other writes are monotonic no-ops.
 */
function canUpgradeAgentToolOutcome(
  next: AgentToolExecutionRecord,
  current: AgentToolExecutionRecord,
): boolean {
  if (AGENT_TOOL_OUTCOME_RANK[next.outcome] <= AGENT_TOOL_OUTCOME_RANK[current.outcome]) {
    return false;
  }
  if (current.outcome === "outcome-unknown") {
    return current.settlement === "cancelled-in-flight"
      && next.outcome === "completed"
      && next.settlement === "cancelled-in-flight";
  }
  return current.outcome === "not-dispatched";
}

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
const LINEAGE_ALLOWED_KEYS = [...LINEAGE_RECORD_KEYS, "tool"] as const;
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
    case "tool.proposal":
      return value.status === "proposed" && value.transitionReason === null;
    case "tool.decision":
      return (value.status === "allowed" || value.status === "blocked")
        && value.transitionReason === null;
    case "tool.outcome":
      return value.status === "observed" && value.transitionReason === null;
    default:
      return false;
  }
}

function decodeToolLineage(value: unknown): AgentLineageEvent["tool"] {
  if (!isRecord(value)
    || !hasOnlyExpectedKeys(
      value,
      ["requestId", "toolName", "proposal", "decision", "decisionReason", "outcome", "resultReference", "settlement"],
      ["requestId", "toolName"],
    )
    || typeof value.requestId !== "string"
    || value.requestId.length === 0
    || typeof value.toolName !== "string"
    || value.toolName.length === 0
    || (value.proposal !== undefined && !isRecord(value.proposal))
    || (value.decision !== undefined
      && (!isRecord(value.decision)
        || !hasOnlyExpectedKeys(value.decision, ["decisionVersion", "allowed", "reason"], ["decisionVersion", "allowed", "reason"])
        || value.decision.decisionVersion !== AGENT_TOOL_DECISION_VERSION
        || typeof value.decision.allowed !== "boolean"
        || !AGENT_TOOL_DECISION_REASONS.includes(value.decision.reason as never)))
    || (value.decisionReason !== undefined
      && !AGENT_TOOL_DECISION_REASONS.includes(value.decisionReason as never))
    || (value.outcome !== undefined
      && !AGENT_TOOL_OUTCOMES.includes(value.outcome as never))
    || (value.resultReference !== undefined
      && value.resultReference !== null
      && typeof value.resultReference !== "string")
    || (value.settlement !== undefined
      && !AGENT_TOOL_SETTLEMENTS.includes(value.settlement as never))) {
    throw new Error("Invalid Agent lineage record.");
  }
  return {
    requestId: value.requestId,
    toolName: value.toolName,
    ...(value.proposal ? { proposal: value.proposal } : {}),
    ...(value.decision ? {
      decision: {
        decisionVersion: value.decision.decisionVersion as string,
        allowed: value.decision.allowed as boolean,
        reason: value.decision.reason as string,
      },
    } : {}),
    ...(typeof value.decisionReason === "string" ? { decisionReason: value.decisionReason } : {}),
    ...(typeof value.outcome === "string"
      ? { outcome: value.outcome as "not-dispatched" | "completed" | "outcome-unknown" }
      : {}),
    ...(Object.hasOwn(value, "resultReference")
      ? { resultReference: value.resultReference as string | null }
      : {}),
    ...(typeof value.settlement === "string"
      ? { settlement: value.settlement as "normal" | "cancelled-in-flight" }
      : {}),
  };
}

function decodeLineageRecord(
  value: unknown,
  legacy: boolean,
): AgentLineageEvent {
  const hasTool = isRecord(value) && Object.hasOwn(value, "tool");
  const decodedTool = hasTool ? decodeToolLineage(value.tool) : undefined;
  if (!isRecord(value)
    || !hasOnlyExpectedKeys(
      value,
      LINEAGE_ALLOWED_KEYS,
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
    || (hasTool && !decodedTool)
    || (typeof value.kind === "string" && value.kind.startsWith("tool.") && !Object.hasOwn(value, "tool"))
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
    ...(decodedTool ? { tool: decodedTool } : {}),
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
  schema: "agent-run" | "agent-lineage" | "agent-tool-outcome",
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

  function decodeToolRecord(raw: unknown): AgentToolExecutionRecord {
    const value = parseJsonRecord(raw, "Invalid Agent tool outcome record.");
    if (value.recordVersion !== 1
      || !hasOnlyExpectedKeys(value, ["recordVersion", "record"], ["recordVersion", "record"])) {
      throw new Error("Unsupported Agent tool outcome record version.");
    }
    const record = value.record;
    if (!isRecord(record)
      || !hasOnlyExpectedKeys(
        record,
        ["runId", "requestId", "proposal", "decision", "outcome", "result", "resultReference", "occurredAt", "settlement"],
        ["runId", "requestId", "proposal", "decision", "outcome", "result", "resultReference", "occurredAt"],
      )
      || typeof record.runId !== "string"
      || typeof record.requestId !== "string"
      || typeof record.occurredAt !== "string"
      || !AGENT_TOOL_OUTCOMES.includes(record.outcome as never)
      || !isRecord(record.proposal)
      || record.proposal.proposalVersion !== AGENT_TOOL_PROPOSAL_VERSION
      || !isRecord(record.decision)
      || record.decision.decisionVersion !== AGENT_TOOL_DECISION_VERSION
      || typeof record.decision.allowed !== "boolean"
      || !AGENT_TOOL_DECISION_REASONS.includes(record.decision.reason as never)
      || (record.settlement !== undefined && !AGENT_TOOL_SETTLEMENTS.includes(record.settlement as never))
      || (record.resultReference !== null && !isRecord(record.resultReference))
      || (record.result !== null && !isRecord(record.result))) {
      throw new Error("Invalid Agent tool outcome record.");
    }
    if (record.resultReference !== null
      && (record.resultReference.referenceVersion !== AGENT_TOOL_REFERENCE_VERSION
        || typeof record.resultReference.value !== "string")) {
      throw new Error("Invalid Agent tool outcome record.");
    }
    if (record.result !== null && (record.result.resultVersion !== AGENT_TOOL_RESULT_VERSION
      || !validateAgentToolResult(record.result))) {
      throw new Error("Invalid Agent tool outcome record.");
    }
    if ((!record.decision.allowed && record.outcome !== "not-dispatched")
      || (record.settlement !== undefined && record.outcome === "not-dispatched")
      || (record.outcome === "completed" && (record.result === null || record.resultReference === null))
      || (record.outcome !== "completed" && (record.result !== null || record.resultReference !== null))
      || (record.result !== null && record.resultReference?.value !== record.result.reference.value)) {
      throw new Error("Invalid Agent tool outcome record.");
    }
    return {
      ...record,
      ...(typeof record.settlement === "string" ? { settlement: record.settlement } : {}),
    } as unknown as AgentToolExecutionRecord;
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
    recordToolRequest(record) {
      const protectedRecord = protectRecord(
        gate,
        "agent-tool-outcome",
        record as unknown as Record<string, unknown>,
      ) as unknown as AgentToolExecutionRecord;
      const encoded = JSON.stringify({ recordVersion: 1, record: protectedRecord });
      const existing = db.prepare(
        "SELECT record_json FROM agent_tool_outcomes WHERE run_id = ? AND request_id = ?",
      ).get(protectedRecord.runId, protectedRecord.requestId) as { record_json: string } | undefined;
      if (existing) {
        const current = decodeToolRecord(existing.record_json);
        if (canUpgradeAgentToolOutcome(protectedRecord, current)) {
          db.prepare(`
            UPDATE agent_tool_outcomes
            SET outcome = ?, result_reference = ?, result_json = ?, proposal_json = ?, decision_json = ?,
              occurred_at = ?, record_json = ?, updated_at = ?
            WHERE run_id = ? AND request_id = ?
          `).run(
            protectedRecord.outcome,
            protectedRecord.resultReference?.value ?? null,
            protectedRecord.result ? JSON.stringify(protectedRecord.result) : null,
            JSON.stringify(protectedRecord.proposal),
            JSON.stringify(protectedRecord.decision),
            protectedRecord.occurredAt,
            encoded,
            protectedRecord.occurredAt,
            protectedRecord.runId,
            protectedRecord.requestId,
          );
        }
        return;
      }
      db.prepare(`
        INSERT INTO agent_tool_outcomes (
          run_id, request_id, outcome, result_reference, result_json,
          proposal_json, decision_json, occurred_at, updated_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        protectedRecord.runId,
        protectedRecord.requestId,
        protectedRecord.outcome,
        protectedRecord.resultReference?.value ?? null,
        protectedRecord.result ? JSON.stringify(protectedRecord.result) : null,
        JSON.stringify(protectedRecord.proposal),
        JSON.stringify(protectedRecord.decision),
        protectedRecord.occurredAt,
        protectedRecord.occurredAt,
        encoded,
      );
    },
    getToolRequest(runId, requestId) {
      const row = db.prepare(
        "SELECT record_json FROM agent_tool_outcomes WHERE run_id = ? AND request_id = ?",
      ).get(runId, requestId) as { record_json: string } | undefined;
      return row ? decodeToolRecord(row.record_json) : null;
    },
    listToolRequests(runId) {
      const rows = db.prepare(
        "SELECT record_json FROM agent_tool_outcomes WHERE run_id = ? ORDER BY occurred_at, request_id",
      ).all(runId) as Array<{ record_json: string }>;
      return rows.map((row) => decodeToolRecord(row.record_json));
    },
    close() {
      db.close();
    },
  };
}

export type { AgentStoreOptions };
