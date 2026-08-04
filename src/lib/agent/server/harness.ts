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
  prompt?: string;
};

export type AgentRunPhase = "running" | "completed" | "cancelled" | "failed";

export const AGENT_FAILURE_REASONS = [
  "context-window-exceeded",
  "provider-assets-unavailable",
  "provider-guardrail-violation",
  "provider-guide-unsupported",
  "provider-language-or-locale-unsupported",
  "provider-decoding-failed",
  "provider-rate-limited",
  "provider-concurrent-request",
  "provider-refused",
  "provider-generation-failed",
  "provider-failed",
  "helper-launch-failed",
  "secret-boundary-violation",
] as const;

export type AgentFailureReason = (typeof AGENT_FAILURE_REASONS)[number];

export type AgentTransitionReason = AgentFailureReason | "user-cancelled" | null;

export type AgentRunStatus = {
  runId: string;
  phase: AgentRunPhase;
  action: { type: "cancel" } | null;
  startedAt: string;
  finishedAt: string | null;
  output: string;
};

export type AgentLineageEvent = {
  runId: string;
  analysisId: string | null;
  seq: number;
  kind: "run.started" | "run.completed" | "run.cancelled" | "run.failed";
  status: "allowed" | "observed";
  occurredAt: string;
  dataClasses: readonly string[];
  providerIdentity: string;
  osBuild: string;
  providerAssurance: AgentSystemModelActivation["assurance"];
  transitionReason: AgentTransitionReason;
  secretFields: readonly [];
};

export type AgentDiagnosticsEvent = {
  runId: string;
  kind: AgentLineageEvent["kind"];
  phase: AgentRunPhase;
  occurredAt: string;
  transitionReason: AgentTransitionReason;
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
  onStream: (content: string) => void;
  onComplete: () => void;
  onFailure: (error: Error) => void;
};

export type AgentProviderActivation = {
  availability: "available" | "unavailable" | "incompatible";
  providerIdentity: string;
  osBuild: string;
  reason?: string;
};

export type AgentSystemModelActivation = Omit<AgentProviderActivation, "availability" | "reason"> & {
  availability: "available";
  assurance: "verified-build" | "unverified-build";
};

export const VERIFIED_APPLE_SYSTEM_MODEL_PROVIDER_IDENTITY =
  "apple.foundation-models:SystemLanguageModel.default";
export const VERIFIED_APPLE_SYSTEM_MODEL_OS_BUILD = "25C56";

export type AgentProvider = {
  activate(options?: { userStartedNewRun?: boolean }): Promise<AgentProviderActivation>;
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
  output: string;
  failureReason: AgentFailureReason | null;
};

export type AgentRunStore = {
  createRun(record: AgentRunRecord): void;
  getRun(runId: string): AgentRunRecord | null;
  updateRun(
    runId: string,
    update: Partial<Pick<
      AgentRunRecord,
      "phase" | "finishedAt" | "output" | "failureReason"
    >>,
  ): void;
  appendLineage(event: AgentLineageEvent): void;
  getLineage(runId: string): AgentLineageEvent[];
};

export type AgentDiagnosticsSink = {
  record(event: AgentDiagnosticsEvent): void;
};

export type AgentHarnessService = {
  activate(options?: { userStartedNewRun?: boolean }): Promise<AgentSystemModelActivation>;
  start(input: AgentStartInput): AgentRunStatus;
  startNewRun(input: AgentStartInput): Promise<AgentRunStatus>;
  status(runId: string): AgentRunStatus;
  cancel(runId: string): AgentRunStatus;
  complete(runId: string): AgentRunStatus;
  lineage(runId: string): AgentLineageEvent[];
};

export const AGENT_SECRET_SCHEMA_ALLOWLIST: SecretSchemaAllowlist = {
  "agent-run": [
    "runId",
    "analysisId",
    "phase",
    "startedAt",
    "finishedAt",
    "output",
    "failureReason",
  ],
  "agent-lineage": [
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
  ],
  "agent-diagnostic": [
    "runId",
    "kind",
    "phase",
    "occurredAt",
    "transitionReason",
    "secretFields",
  ],
  "agent-start-input": ["analysisId", "prompt"],
  "agent-activation": ["apiVersion", "availability", "warning"],
  "agent-stream": ["output"],
  "agent-status": ["apiVersion", "runId", "phase", "action", "startedAt", "finishedAt", "output"],
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
        onFailure: (error) => {
          providers.delete(input.runId);
          input.onFailure(error);
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
    async activate(options = {}) {
      return {
        availability: "available",
        providerIdentity: "deterministic.no-tool-provider",
        osBuild: "deterministic",
      };
    },
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

function statusFor(record: AgentRunRecord, output = record.output): AgentRunStatus {
  return {
    runId: record.runId,
    phase: record.phase,
    action: record.phase === "running" ? { type: "cancel" } : null,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    output,
  };
}

const AGENT_FAILURE_REASON_SET: ReadonlySet<string> = new Set(AGENT_FAILURE_REASONS);

export function isAgentFailureReason(value: unknown): value is AgentFailureReason {
  return typeof value === "string" && AGENT_FAILURE_REASON_SET.has(value);
}

function boundedAgentFailureReason(error: Error): AgentFailureReason {
  return isAgentFailureReason(error.message)
    ? error.message
    : "provider-failed";
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
  let activeProvider: AgentSystemModelActivation | null = null;
  let activationGeneration = 0;
  const outputs = new Map<string, string>();
  const runProviders = new Map<string, AgentSystemModelActivation>();

  function cleanupRun(runId: string) {
    runProviders.delete(runId);
    outputs.delete(runId);
  }

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

  function transition(
    runId: string,
    kind: AgentLineageEvent["kind"],
    phase: AgentRunPhase,
    transitionReason: AgentTransitionReason = null,
  ) {
    const record = requireRun(runStore, runId);
    if (record.phase !== "running") return statusFor(record, outputs.get(runId));
    const runProvider = runProviders.get(runId);
    if (!runProvider) throw new Error("Agent run provider metadata not found.");
    try {
      const occurredAt = clock.now();
      const output = outputs.get(runId) ?? record.output;
      const failureReason = phase === "failed"
        ? transitionReason as AgentFailureReason
        : null;
      const protectedRecord = secretBoundary.protectRecord(
        "sqlite-persistence",
        "agent-run",
        { ...record, phase, finishedAt: occurredAt, output, failureReason },
      );
      if (protectedRecord.failure) {
        throw new Error(secretBoundaryFailureMessage(protectedRecord.failure));
      }
      runStore.updateRun(runId, {
        phase: protectedRecord.value.phase as AgentRunPhase,
        finishedAt: protectedRecord.value.finishedAt as string,
        output: protectedRecord.value.output as string,
        failureReason: protectedRecord.value.failureReason as AgentFailureReason | null,
      });
      recordLineage({
        runId,
        analysisId: record.analysisId,
        seq: runStore.getLineage(runId).length + 1,
        kind,
        status: "observed",
        occurredAt,
        dataClasses: [],
        providerIdentity: runProvider.providerIdentity,
        osBuild: runProvider.osBuild,
        providerAssurance: runProvider.assurance,
        transitionReason,
        secretFields: [],
      });
      recordDiagnostics({
        runId,
        kind,
        phase,
        occurredAt,
        transitionReason,
        secretFields: [],
      });
      return status(runId);
    } finally {
      cleanupRun(runId);
    }
  }

  function status(runId: string) {
    return statusFor(requireRun(runStore, runId), outputs.get(runId));
  }

  function failCancellation(runId: string): never {
    try {
      if (requireRun(runStore, runId).phase === "running" && runProviders.has(runId)) {
        transition(runId, "run.failed", "failed", "provider-failed");
      }
    } catch {
      // Preserve the stable public cancellation error when terminal persistence or diagnostics fail.
    } finally {
      cleanupRun(runId);
    }
    throw new Error("Agent cancellation failed.");
  }

  function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return value !== null
      && (typeof value === "object" || typeof value === "function")
      && typeof (value as { then?: unknown }).then === "function";
  }

  return {
    async activate(options = {}) {
      const generation = ++activationGeneration;
      activeProvider = null;
      const activation = await provider.activate(options);
      if (generation !== activationGeneration) {
        throw new Error("Apple system model activation superseded.");
      }
      if (activation.availability === "unavailable") {
        throw new Error("Apple system model activation blocked: provider unavailable.");
      }
      if (activation.availability === "incompatible") {
        throw new Error("Apple system model activation blocked: provider API incompatible.");
      }
      activeProvider = {
        availability: activation.availability,
        providerIdentity: activation.providerIdentity,
        osBuild: activation.osBuild,
        assurance: activation.providerIdentity
            === VERIFIED_APPLE_SYSTEM_MODEL_PROVIDER_IDENTITY
          && activation.osBuild === VERIFIED_APPLE_SYSTEM_MODEL_OS_BUILD
          ? "verified-build"
          : "unverified-build",
      };
      return activeProvider;
    },
    start(input) {
      if (!activeProvider) {
        throw new Error("Apple system model must be activated before starting a run.");
      }
      const runProvider = activeProvider;
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
        output: "",
        failureReason: null,
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
      outputs.set(runId, "");
      runProviders.set(runId, runProvider);
      recordLineage({
        runId,
        analysisId: record.analysisId,
        seq: 1,
        kind: "run.started",
        status: "allowed",
        occurredAt: startedAt,
        dataClasses: [],
        providerIdentity: runProvider.providerIdentity,
        osBuild: runProvider.osBuild,
        providerAssurance: runProvider.assurance,
        transitionReason: null,
        secretFields: [],
      });
      recordDiagnostics({
        runId,
        kind: "run.started",
        phase: "running",
        occurredAt: startedAt,
        transitionReason: null,
        secretFields: [],
      });
      try {
        helper.launch({
          runId,
          input: protectedInput.value as AgentStartInput,
          provider,
          toolGateway,
          onStream: (output) => {
            if (!runProviders.has(runId)) return;
            const protectedStream = secretBoundary.protectRecord(
              "diagnostic-export",
              "agent-stream",
              { output },
            );
            if (protectedStream.failure) {
              transition(
                runId,
                "run.failed",
                "failed",
                "secret-boundary-violation",
              );
              try {
                helper.cancel(runId);
              } catch {
                // A helper cancellation failure cannot keep a secret-boundary violation running.
              }
              return;
            }
            outputs.set(runId, protectedStream.value.output as string);
          },
          onComplete: () => transition(runId, "run.completed", "completed"),
          onFailure: (error) => transition(
            runId,
            "run.failed",
            "failed",
            boundedAgentFailureReason(error),
          ),
        });
      } catch {
        transition(runId, "run.failed", "failed", "helper-launch-failed");
        throw new Error("Agent helper launch failed.");
      }
      return status(runId);
    },
    async startNewRun(input) {
      await this.activate({ userStartedNewRun: true });
      return this.start(input);
    },
    status,
    cancel(runId) {
      const record = requireRun(runStore, runId);
      if (record.phase === "running") {
        if (!runProviders.has(runId)) return failCancellation(runId);
        try {
          const cancellation = helper.cancel(runId) as unknown;
          if (isPromiseLike(cancellation)) {
            void Promise.resolve(cancellation).catch(() => undefined);
            return failCancellation(runId);
          }
        } catch {
          failCancellation(runId);
        }
        return transition(runId, "run.cancelled", "cancelled", "user-cancelled");
      }
      return statusFor(record, outputs.get(runId));
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
