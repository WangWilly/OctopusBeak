export const HUMAN_ASSISTANCE_SCHEMA_VERSION = 1 as const;

export const HUMAN_VERIFICATION_INTERACTION_MODES = [
  "click",
  "type",
  "press",
  "drag",
] as const;

export const HUMAN_ASSISTANCE_COMPLETION_STATUSES = [
  "pending",
  "entered",
  "verified",
  "failed",
] as const;

export type VerificationInteractionMode = typeof HUMAN_VERIFICATION_INTERACTION_MODES[number];
export type HumanAssistanceCompletionStatus = typeof HUMAN_ASSISTANCE_COMPLETION_STATUSES[number];

export type HumanVerificationRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type HumanVerificationTarget = {
  id: string;
  label: string;
  semanticId: string;
  modes: readonly VerificationInteractionMode[];
  rect?: HumanVerificationRect | null;
};

export type VerificationContextRegion = {
  id: string;
  label: string;
  semanticId: string;
};

export type HumanAssistanceCompletion = {
  mode: "independent" | "inline";
  targetIds: readonly string[];
  status: HumanAssistanceCompletionStatus;
};

export type HumanAssistanceCompletionInput = Omit<HumanAssistanceCompletion, "status"> & {
  status?: HumanAssistanceCompletionStatus;
};

export type HumanAssistanceFocus = {
  targetId: string;
  contextRegionIds: readonly string[];
  initialZoom?: number;
};

export type HumanAssistanceContractInput = {
  stageId: string;
  title: string;
  targets: readonly HumanVerificationTarget[];
  contextRegions: readonly VerificationContextRegion[];
  completion: HumanAssistanceCompletionInput;
  focus: HumanAssistanceFocus;
};

export type HumanAssistanceContract = HumanAssistanceContractInput & {
  schemaVersion: typeof HUMAN_ASSISTANCE_SCHEMA_VERSION;
  version: number;
  completion: HumanAssistanceCompletion;
};

export const HUMAN_ASSISTANCE_CONTRACT_SIGNAL = "human-assistance-contract:";

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid human assistance contract: ${field} must be non-empty.`);
  }
}

function uniqueIds(values: readonly string[], field: string) {
  if (new Set(values).size !== values.length) {
    throw new Error(`Invalid human assistance contract: ${field} must contain unique ids.`);
  }
}

function assertTarget(target: HumanVerificationTarget) {
  nonEmpty(target.id, "target id");
  nonEmpty(target.label, `target ${target.id} label`);
  nonEmpty(target.semanticId, `target ${target.id} semanticId`);
  if (target.modes.length === 0) {
    throw new Error(`Invalid human assistance contract: target ${target.id} needs an interaction mode.`);
  }
  for (const mode of target.modes) {
    if (!HUMAN_VERIFICATION_INTERACTION_MODES.includes(mode)) {
      throw new Error(`Invalid human assistance contract: target ${target.id} has mode ${mode}.`);
    }
  }
}

export function createHumanAssistanceContract(
  input: HumanAssistanceContractInput,
  version: number,
): HumanAssistanceContract {
  nonEmpty(input.stageId, "stageId");
  nonEmpty(input.title, "title");
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("Invalid human assistance contract: version must be a positive integer.");
  }
  if (input.targets.length === 0) {
    throw new Error("Invalid human assistance contract: at least one target is required.");
  }
  uniqueIds(input.targets.map((target) => target.id), "targets");
  uniqueIds(input.contextRegions.map((region) => region.id), "context regions");
  input.targets.forEach(assertTarget);
  input.contextRegions.forEach((region) => {
    nonEmpty(region.id, "context region id");
    nonEmpty(region.label, `context region ${region.id} label`);
    nonEmpty(region.semanticId, `context region ${region.id} semanticId`);
  });
  if (input.completion.targetIds.length === 0) {
    throw new Error("Invalid human assistance contract: completion needs a target.");
  }
  if (
    input.completion.status !== undefined
    && !HUMAN_ASSISTANCE_COMPLETION_STATUSES.includes(input.completion.status)
  ) {
    throw new Error(`Invalid human assistance contract: unknown completion status ${input.completion.status}.`);
  }
  if (input.completion.targetIds.some((id) => !input.targets.some((target) => target.id === id))) {
    throw new Error("Invalid human assistance contract: completion references an unknown target.");
  }
  if (!input.targets.some((target) => target.id === input.focus.targetId)) {
    throw new Error("Invalid human assistance contract: focus references an unknown target.");
  }
  if (input.focus.contextRegionIds.some((id) => !input.contextRegions.some((region) => region.id === id))) {
    throw new Error("Invalid human assistance contract: focus references an unknown context region.");
  }
  if (input.focus.initialZoom !== undefined && (!Number.isFinite(input.focus.initialZoom) || input.focus.initialZoom <= 0)) {
    throw new Error("Invalid human assistance contract: initialZoom must be positive.");
  }

  return {
    schemaVersion: HUMAN_ASSISTANCE_SCHEMA_VERSION,
    version,
    stageId: input.stageId,
    title: input.title,
    targets: input.targets.map((target) => ({ ...target, modes: [...target.modes] })),
    contextRegions: input.contextRegions.map((region) => ({ ...region })),
    completion: {
      mode: input.completion.mode,
      targetIds: [...input.completion.targetIds],
      status: input.completion.status ?? "pending",
    },
    focus: {
      targetId: input.focus.targetId,
      contextRegionIds: [...input.focus.contextRegionIds],
      ...(input.focus.initialZoom === undefined ? {} : { initialZoom: input.focus.initialZoom }),
    },
  };
}

export function humanAssistanceContractSignal(input: HumanAssistanceContractInput): string {
  createHumanAssistanceContract(input, 1);
  return `${HUMAN_ASSISTANCE_CONTRACT_SIGNAL} ${JSON.stringify(input)}`;
}

export function parseHumanAssistanceContractSignals(output: string): HumanAssistanceContractInput[] {
  const contracts: HumanAssistanceContractInput[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(HUMAN_ASSISTANCE_CONTRACT_SIGNAL)) continue;
    try {
      const value = JSON.parse(line.slice(HUMAN_ASSISTANCE_CONTRACT_SIGNAL.length).trim()) as HumanAssistanceContractInput;
      createHumanAssistanceContract(value, 1);
      contracts.push(value);
    } catch {
      // Invalid workflow signals are ignored; the run remains fail-safe without a contract.
    }
  }
  return contracts;
}

export function parseHumanAssistanceContract(recordJson: string): HumanAssistanceContract | null {
  try {
    const record = JSON.parse(recordJson) as { humanAssistanceContract?: unknown };
    const value = record.humanAssistanceContract;
    if (!value || typeof value !== "object") return null;
    const candidate = value as HumanAssistanceContract;
    if (candidate.schemaVersion !== HUMAN_ASSISTANCE_SCHEMA_VERSION) return null;
    return createHumanAssistanceContract(candidate, candidate.version);
  } catch {
    return null;
  }
}
