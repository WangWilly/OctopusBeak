import { randomUUID } from "node:crypto";
import {
  AUTOMATION_SECRET_SCHEMA_ALLOWLIST,
  createAutomationSecretBoundaryGate,
  secretBoundaryFailureMessage,
  type SecretBoundaryDependencies,
  type SecretBoundaryGate,
  type SecretSchemaAllowlist,
} from "../../automation/server/secret-boundary.ts";

export type { SecretBoundaryDependencies, SecretBoundaryGate } from "../../automation/server/secret-boundary.ts";

export type AgentStartInput = {
  analysisId?: string;
};

export type AgentRunPhase = "running" | "completed" | "cancelled" | "failed";

export type AgentRunStatus = {
  runId: string;
  phase: AgentRunPhase;
  action: { type: "cancel" } | null;
  startedAt: string;
  finishedAt: string | null;
};

export type AgentLineageEvent = {
  runId: string;
  analysisId: string | null;
  seq: number;
  kind: "run.started" | "run.completed" | "run.cancelled" | "run.failed";
  status: "allowed" | "observed";
  occurredAt: string;
  dataClasses: readonly string[];
  secretFields: readonly [];
};

export type AgentDiagnosticsEvent = {
  runId: string;
  kind: AgentLineageEvent["kind"];
  phase: AgentRunPhase;
  occurredAt: string;
  secretFields: readonly [];
};

export type AgentToolRequest = {
  name: string;
  input: Record<string, unknown>;
};

export type AgentToolResult = {
  status: "rejected" | "completed";
};

export type AgentToolGateway = {
  execute(request: AgentToolRequest): AgentToolResult;
};

export type AgentProviderStart = {
  runId: string;
  input: AgentStartInput;
  toolGateway: AgentToolGateway;
  onComplete: () => void;
};

export type AgentProvider = {
  start(input: AgentProviderStart): void;
  cancel(runId: string): void;
};

export type AgentHelperLaunchInput = AgentProviderStart & {
  provider: AgentProvider;
};

export type AgentHelper = {
  launch(input: AgentHelperLaunchInput): void;
  cancel(runId: string): void;
};

export type AgentClock = {
  now(): string;
};

export type AgentRunRecord = {
  runId: string;
  analysisId: string | null;
  phase: AgentRunPhase;
  startedAt: string;
  finishedAt: string | null;
};

export type AgentRunStore = {
  createRun(record: AgentRunRecord): void;
  getRun(runId: string): AgentRunRecord | null;
  updateRun(runId: string, update: Partial<Pick<AgentRunRecord, "phase" | "finishedAt">>): void;
  appendLineage(event: AgentLineageEvent): void;
  getLineage(runId: string): AgentLineageEvent[];
};

export type AgentDiagnosticsSink = {
  record(event: AgentDiagnosticsEvent): void;
};

export type AgentHarnessService = {
  start(input: AgentStartInput): AgentRunStatus;
  status(runId: string): AgentRunStatus;
  cancel(runId: string): AgentRunStatus;
  complete(runId: string): AgentRunStatus;
  lineage(runId: string): AgentLineageEvent[];
};

export const AGENT_SECRET_SCHEMA_ALLOWLIST: SecretSchemaAllowlist = {
  "agent-run": ["runId", "analysisId", "phase", "startedAt", "finishedAt"],
  "agent-lineage": [
    "runId",
    "analysisId",
    "seq",
    "kind",
    "status",
    "occurredAt",
    "dataClasses",
    "secretFields",
  ],
  "agent-diagnostic": ["runId", "kind", "phase", "occurredAt", "secretFields"],
  "agent-start-input": ["analysisId"],
  "agent-status": ["apiVersion", "runId", "phase", "action", "startedAt", "finishedAt"],
};

export function createAgentSecretBoundaryGate({
  secretValues,
  additionalSecretValues = [],
  dependencies = {},
}: {
  secretValues?: readonly string[];
  additionalSecretValues?: readonly string[];
  dependencies?: Partial<SecretBoundaryDependencies>;
} = {}): SecretBoundaryGate {
  const schemaAllowlist = dependencies.schemaAllowlist === undefined
    ? {
      ...AUTOMATION_SECRET_SCHEMA_ALLOWLIST,
      ...AGENT_SECRET_SCHEMA_ALLOWLIST,
    }
    : dependencies.schemaAllowlist;
  return createAutomationSecretBoundaryGate({
    secretValues,
    additionalSecretValues,
    dependencies: {
      ...dependencies,
      schemaAllowlist,
    },
  });
}

export function createInMemoryAgentRunStore(): AgentRunStore {
  const runs = new Map<string, AgentRunRecord>();
  const lineage = new Map<string, AgentLineageEvent[]>();
  return {
    createRun(record) {
      if (runs.has(record.runId)) throw new Error("Agent run already exists.");
      runs.set(record.runId, { ...record });
      lineage.set(record.runId, []);
    },
    getRun(runId) {
      const record = runs.get(runId);
      return record ? { ...record } : null;
    },
    updateRun(runId, update) {
      const record = runs.get(runId);
      if (!record) throw new Error("Agent run not found.");
      runs.set(runId, { ...record, ...update });
    },
    appendLineage(event) {
      const events = lineage.get(event.runId);
      if (!events) throw new Error("Agent run not found.");
      events.push({ ...event, dataClasses: [...event.dataClasses], secretFields: [] });
    },
    getLineage(runId) {
      return (lineage.get(runId) ?? []).map((event) => ({
        ...event,
        dataClasses: [...event.dataClasses],
        secretFields: [],
      }));
    },
  };
}

export function createNoToolAgentGateway(): AgentToolGateway {
  return {
    execute() {
      return { status: "rejected" };
    },
  };
}

export function createInlineAgentHelper(): AgentHelper {
  const providers = new Map<string, AgentProvider>();
  return {
    launch(input) {
      providers.set(input.runId, input.provider);
      input.provider.start({
        ...input,
        onComplete: () => {
          providers.delete(input.runId);
          input.onComplete();
        },
      });
    },
    cancel(runId) {
      const provider = providers.get(runId);
      if (!provider) return;
      provider.cancel(runId);
      providers.delete(runId);
    },
  };
}

export function createNoToolAgentProvider(): AgentProvider {
  return {
    start({ onComplete }) {
      onComplete();
    },
    cancel() {},
  };
}

export type AgentHarnessDependencies = {
  helper: AgentHelper;
  provider: AgentProvider;
  runStore: AgentRunStore;
  toolGateway: AgentToolGateway;
  clock: AgentClock;
  diagnosticsSink: AgentDiagnosticsSink;
  idFactory?: () => string;
  secretValues?: readonly string[];
  additionalSecretValues?: readonly string[];
  secretBoundaryDependencies?: Partial<SecretBoundaryDependencies>;
};

function statusFor(record: AgentRunRecord): AgentRunStatus {
  return {
    runId: record.runId,
    phase: record.phase,
    action: record.phase === "running" ? { type: "cancel" } : null,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}

function requireRun(runStore: AgentRunStore, runId: string) {
  const record = runStore.getRun(runId);
  if (!record) throw new Error("Agent run not found.");
  return record;
}

export function createAgentHarnessService({
  helper,
  provider,
  runStore,
  toolGateway,
  clock,
  diagnosticsSink,
  idFactory = () => randomUUID(),
  secretValues,
  additionalSecretValues,
  secretBoundaryDependencies,
}: AgentHarnessDependencies): AgentHarnessService {
  const secretBoundary = createAgentSecretBoundaryGate({
    secretValues,
    additionalSecretValues,
    dependencies: secretBoundaryDependencies,
  });

  function recordLineage(event: AgentLineageEvent) {
    const protectedEvent = secretBoundary.protectRecord(
      "sqlite-persistence",
      "agent-lineage",
      event as unknown as Record<string, unknown>,
    );
    if (protectedEvent.failure) {
      throw new Error(secretBoundaryFailureMessage(protectedEvent.failure));
    }
    runStore.appendLineage(protectedEvent.value as unknown as AgentLineageEvent);
  }

  function recordDiagnostics(event: AgentDiagnosticsEvent) {
    const protectedEvent = secretBoundary.protectRecord(
      "diagnostic-export",
      "agent-diagnostic",
      event as unknown as Record<string, unknown>,
    );
    if (protectedEvent.failure) {
      throw new Error(secretBoundaryFailureMessage(protectedEvent.failure));
    }
    diagnosticsSink.record(protectedEvent.value as AgentDiagnosticsEvent);
  }

  function transition(runId: string, kind: AgentLineageEvent["kind"], phase: AgentRunPhase) {
    const record = requireRun(runStore, runId);
    if (record.phase !== "running") return statusFor(record);
    const occurredAt = clock.now();
    const protectedRecord = secretBoundary.protectRecord(
      "sqlite-persistence",
      "agent-run",
      { ...record, phase, finishedAt: occurredAt },
    );
    if (protectedRecord.failure) {
      throw new Error(secretBoundaryFailureMessage(protectedRecord.failure));
    }
    runStore.updateRun(runId, {
      phase: protectedRecord.value.phase as AgentRunPhase,
      finishedAt: protectedRecord.value.finishedAt as string,
    });
    recordLineage({
      runId,
      analysisId: record.analysisId,
      seq: runStore.getLineage(runId).length + 1,
      kind,
      status: "observed",
      occurredAt,
      dataClasses: [],
      secretFields: [],
    });
    recordDiagnostics({ runId, kind, phase, occurredAt, secretFields: [] });
    return status(runId);
  }

  function status(runId: string) {
    return statusFor(requireRun(runStore, runId));
  }

  return {
    start(input) {
      const runId = idFactory();
      const startedAt = clock.now();
      const protectedInput = secretBoundary.protectRecord(
        "diagnostic-export",
        "agent-start-input",
        input,
      );
      if (protectedInput.failure) {
        throw new Error(secretBoundaryFailureMessage(protectedInput.failure));
      }
      const record = {
        runId,
        analysisId: protectedInput.value.analysisId ?? null,
        phase: "running" as const,
        startedAt,
        finishedAt: null,
      };
      const protectedRecord = secretBoundary.protectRecord(
        "sqlite-persistence",
        "agent-run",
        record,
      );
      if (protectedRecord.failure) {
        throw new Error(secretBoundaryFailureMessage(protectedRecord.failure));
      }
      runStore.createRun(protectedRecord.value as typeof record);
      recordLineage({
        runId,
        analysisId: record.analysisId,
        seq: 1,
        kind: "run.started",
        status: "allowed",
        occurredAt: startedAt,
        dataClasses: [],
        secretFields: [],
      });
      recordDiagnostics({ runId, kind: "run.started", phase: "running", occurredAt: startedAt, secretFields: [] });
      try {
        helper.launch({
          runId,
          input: protectedInput.value as AgentStartInput,
          provider,
          toolGateway,
          onComplete: () => transition(runId, "run.completed", "completed"),
        });
      } catch {
        transition(runId, "run.failed", "failed");
        throw new Error("Agent helper launch failed.");
      }
      return status(runId);
    },
    status,
    cancel(runId) {
      const record = requireRun(runStore, runId);
      if (record.phase === "running") {
        try {
          helper.cancel(runId);
        } catch {
          throw new Error("Agent cancellation failed.");
        }
        return transition(runId, "run.cancelled", "cancelled");
      }
      return statusFor(record);
    },
    complete(runId) {
      return transition(runId, "run.completed", "completed");
    },
    lineage(runId) {
      requireRun(runStore, runId);
      return runStore.getLineage(runId);
    },
  };
}
