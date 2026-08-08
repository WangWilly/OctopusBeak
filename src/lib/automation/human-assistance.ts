export const HUMAN_ASSISTANCE_SCHEMA_VERSION = 1 as const;

export const HUMAN_VERIFICATION_INTERACTION_MODES = [
  "click",
  "type",
  "press",
  "drag",
] as const;

export type VerificationInteractionMode = typeof HUMAN_VERIFICATION_INTERACTION_MODES[number];

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
  completion: HumanAssistanceCompletion;
  focus: HumanAssistanceFocus;
};

export type HumanAssistanceContract = HumanAssistanceContractInput & {
  schemaVersion: typeof HUMAN_ASSISTANCE_SCHEMA_VERSION;
  version: number;
};

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
    },
    focus: {
      targetId: input.focus.targetId,
      contextRegionIds: [...input.focus.contextRegionIds],
      ...(input.focus.initialZoom === undefined ? {} : { initialZoom: input.focus.initialZoom }),
    },
  };
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
