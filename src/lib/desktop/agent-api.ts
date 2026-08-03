import {
  createAgentSecretBoundaryGate,
  type AgentHarnessService,
  type AgentRunStatus,
  type AgentStartInput,
  type SecretBoundaryDependencies,
  type SecretBoundaryGate,
} from "../agent/server/harness.ts";
import { secretBoundaryFailureMessage } from "../automation/server/secret-boundary.ts";

export const AGENT_DESKTOP_API_VERSION = "v1" as const;

export type AgentStatusDto = {
  apiVersion: typeof AGENT_DESKTOP_API_VERSION;
  runId: string;
  phase: AgentRunStatus["phase"];
  action: { type: "cancel"; runId: string } | null;
  startedAt: string;
  finishedAt: string | null;
};

export type AgentDesktopService = Pick<AgentHarnessService, "start" | "status" | "cancel">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateAgentStartInput(input: unknown): AgentStartInput {
  if (input === undefined) return {};
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "analysisId")) {
    throw new TypeError("Invalid Agent start input.");
  }
  if (input.analysisId !== undefined
    && (typeof input.analysisId !== "string" || input.analysisId.length === 0 || input.analysisId.length > 200)) {
    throw new TypeError("Invalid Agent start input.");
  }
  return input as AgentStartInput;
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
    start: (_event: unknown, input: unknown) =>
      projectAgentRunStatus(service.start(validateAgentStartInput(input)), secretBoundary),
    status: (_event: unknown, runId: unknown) =>
      projectAgentRunStatus(service.status(validateAgentRunId(runId)), secretBoundary),
    cancel: (_event: unknown, runId: unknown) =>
      projectAgentRunStatus(service.cancel(validateAgentRunId(runId)), secretBoundary),
  };
}
