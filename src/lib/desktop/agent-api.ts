import {
  createAgentSecretBoundaryGate,
  type AgentHarnessService,
  type AgentRunStatus,
  type AgentStartInput,
  type AgentSystemModelActivation,
  type SecretBoundaryDependencies,
  type SecretBoundaryGate,
} from "../agent/server/harness.ts";
import { secretBoundaryFailureMessage } from "../automation/server/secret-boundary.ts";

export const AGENT_DESKTOP_API_VERSION = "v1" as const;

export type AgentActivationDto = {
  apiVersion: typeof AGENT_DESKTOP_API_VERSION;
  availability: "available";
  warning: "unverified-build" | null;
};

export type AgentStatusDto = {
  apiVersion: typeof AGENT_DESKTOP_API_VERSION;
  runId: string;
  phase: AgentRunStatus["phase"];
  action: { type: "cancel"; runId: string } | null;
  startedAt: string;
  finishedAt: string | null;
  output: string;
};

export type AgentDesktopService = Pick<AgentHarnessService, "activate" | "startNewRun" | "status" | "cancel">;

export type ValidatedAgentStartInput = Omit<AgentStartInput, "prompt"> & {
  prompt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateAgentStartInput(input: unknown): ValidatedAgentStartInput {
  if (!isRecord(input)
    || Object.keys(input).some((key) => key !== "analysisId" && key !== "prompt")) {
    throw new TypeError("Invalid Agent start input.");
  }
  if (input.analysisId !== undefined
    && (typeof input.analysisId !== "string" || input.analysisId.length === 0 || input.analysisId.length > 200)) {
    throw new TypeError("Invalid Agent start input.");
  }
  if (typeof input.prompt !== "string"
    || input.prompt.trim().length === 0
    || input.prompt.length > 20_000) {
    throw new TypeError("Invalid Agent start input.");
  }
  const analysisId = input.analysisId;
  const prompt = input.prompt;
  return analysisId === undefined
    ? { prompt }
    : { analysisId, prompt };
}

export function validateAgentRunId(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 200) {
    throw new TypeError("Invalid Agent run id.");
  }
  return input;
}

export function projectAgentRunStatus(
  status: AgentRunStatus,
  secretBoundary: SecretBoundaryGate = createAgentSecretBoundaryGate(),
): AgentStatusDto {
  const projected = {
    apiVersion: AGENT_DESKTOP_API_VERSION,
    runId: status.runId,
    phase: status.phase,
    action: status.action ? { type: "cancel" as const, runId: status.runId } : null,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    output: status.output,
  };
  const protectedProjection = secretBoundary.protectRecord(
    "diagnostic-export",
    "agent-status",
    projected,
  );
  if (protectedProjection.failure) {
    throw new Error(secretBoundaryFailureMessage(protectedProjection.failure));
  }
  return protectedProjection.value as AgentStatusDto;
}

export function projectAgentActivation(
  activation: AgentSystemModelActivation,
  secretBoundary: SecretBoundaryGate = createAgentSecretBoundaryGate(),
): AgentActivationDto {
  const projected = {
    apiVersion: AGENT_DESKTOP_API_VERSION,
    availability: "available" as const,
    warning: activation.assurance === "unverified-build" ? "unverified-build" as const : null,
  };
  const protectedProjection = secretBoundary.protectRecord(
    "diagnostic-export",
    "agent-activation",
    projected,
  );
  if (protectedProjection.failure) {
    throw new Error(secretBoundaryFailureMessage(protectedProjection.failure));
  }
  return protectedProjection.value as AgentActivationDto;
}

export function createAgentIpcHandlers(
  service: AgentDesktopService,
  options: {
    secretBoundary?: SecretBoundaryGate;
    secretValues?: readonly string[];
    additionalSecretValues?: readonly string[];
    secretBoundaryDependencies?: Partial<SecretBoundaryDependencies>;
  } = {},
) {
  const secretBoundary = options.secretBoundary ?? createAgentSecretBoundaryGate({
    secretValues: options.secretValues,
    additionalSecretValues: options.additionalSecretValues,
    dependencies: options.secretBoundaryDependencies,
  });
  return {
    activate: async (_event: unknown) =>
      projectAgentActivation(await service.activate(), secretBoundary),
    start: async (_event: unknown, input: unknown) =>
      projectAgentRunStatus(await service.startNewRun(validateAgentStartInput(input)), secretBoundary),
    status: (_event: unknown, runId: unknown) =>
      projectAgentRunStatus(service.status(validateAgentRunId(runId)), secretBoundary),
    cancel: (_event: unknown, runId: unknown) =>
      projectAgentRunStatus(service.cancel(validateAgentRunId(runId)), secretBoundary),
  };
}

type AgentIpcRegistrationHandler =
  | ((event: unknown) => unknown)
  | ((event: unknown, input: unknown) => unknown);

export type AgentIpcRegistrar = {
  handle(channel: string, handler: AgentIpcRegistrationHandler): unknown;
};

export function registerAgentIpcHandlers(
  registrar: AgentIpcRegistrar,
  service: AgentDesktopService,
  options: Parameters<typeof createAgentIpcHandlers>[1] = {},
) {
  const handlers = createAgentIpcHandlers(service, options);
  registrar.handle("agent:v1:activate", handlers.activate);
  registrar.handle("agent:v1:start", handlers.start);
  registrar.handle("agent:v1:status", handlers.status);
  registrar.handle("agent:v1:cancel", handlers.cancel);
}
