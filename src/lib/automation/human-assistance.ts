export const HUMAN_ASSISTANCE_SCHEMA_VERSION = 1 as const;

// CAPTCHA answers are intentionally bounded to keep the workflow contract
// descriptive rather than allowing an unbounded solver hint.
export const MAX_EXPECTED_ANSWER_LENGTH = 32;

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

export const VERIFICATION_CHALLENGE_KINDS = [
  "text-captcha",
  "image-selection",
  "checkbox",
] as const;

export const HUMAN_ASSISTANCE_HOST_FD_ENV = "OCTOPUSBEAK_HUMAN_ASSISTANCE_FD";
export const HUMAN_ASSISTANCE_HOST_PATH_ENV = "OCTOPUSBEAK_HUMAN_ASSISTANCE_PATH";

export type VerificationInteractionMode = typeof HUMAN_VERIFICATION_INTERACTION_MODES[number];
export type HumanAssistanceCompletionStatus = typeof HUMAN_ASSISTANCE_COMPLETION_STATUSES[number];
export type VerificationChallengeKind = typeof VERIFICATION_CHALLENGE_KINDS[number];

export const CHALLENGE_CHARACTER_SETS = ["digits", "alphanumeric"] as const;

export type ChallengeCharacterSet = typeof CHALLENGE_CHARACTER_SETS[number];

export const CAPTCHA_OCR_PAGE_SEGMENTATION_MODES = [
  "single-line",
  "single-word",
  "raw-line",
] as const;

export type CaptchaOcrPageSegmentationMode =
  typeof CAPTCHA_OCR_PAGE_SEGMENTATION_MODES[number];

export const CAPTCHA_IMAGE_PREPROCESSING_MODES = [
  "remove-interference-lines",
] as const;

export type CaptchaImagePreprocessingMode =
  typeof CAPTCHA_IMAGE_PREPROCESSING_MODES[number];

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
  rect?: HumanVerificationRect | null;
};

export type VerificationChallengeImageRegion = {
  id: string;
  label: string;
  semanticId: string;
  rect: HumanVerificationRect;
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
  challengeKind?: VerificationChallengeKind;
  challengeImageRegion?: VerificationChallengeImageRegion;
  charset?: ChallengeCharacterSet;
  imagePreprocessing?: readonly CaptchaImagePreprocessingMode[];
  ocrPageSegmentationMode?: CaptchaOcrPageSegmentationMode;
  solverConfidenceThreshold?: number;
  expectedAnswerLength?: number;
  prompt?: string;
};

export type HumanAssistanceContract = HumanAssistanceContractInput & {
  schemaVersion: typeof HUMAN_ASSISTANCE_SCHEMA_VERSION;
  version: number;
  completion: HumanAssistanceCompletion;
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

function assertChallengeImageRegion(region: VerificationChallengeImageRegion) {
  nonEmpty(region.id, "challenge image region id");
  nonEmpty(region.label, `challenge image region ${region.id} label`);
  nonEmpty(region.semanticId, `challenge image region ${region.id} semanticId`);
  const rect = region.rect;
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`Invalid human assistance contract: challenge image region ${region.semanticId} cannot be resolved.`);
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
  if (input.challengeKind !== undefined && !VERIFICATION_CHALLENGE_KINDS.includes(input.challengeKind)) {
    throw new Error(`Invalid human assistance contract: unknown challenge kind ${input.challengeKind}.`);
  }
  if (input.charset !== undefined && !CHALLENGE_CHARACTER_SETS.includes(input.charset)) {
    throw new Error(`Invalid human assistance contract: unknown challenge character set ${input.charset}.`);
  }
  if (input.imagePreprocessing !== undefined) {
    uniqueIds(input.imagePreprocessing, "image preprocessing modes");
    for (const mode of input.imagePreprocessing) {
      if (!CAPTCHA_IMAGE_PREPROCESSING_MODES.includes(mode)) {
        throw new Error(
          `Invalid human assistance contract: unknown image preprocessing mode ${mode}.`,
        );
      }
    }
  }
  if (
    input.ocrPageSegmentationMode !== undefined
    && !CAPTCHA_OCR_PAGE_SEGMENTATION_MODES.includes(input.ocrPageSegmentationMode)
  ) {
    throw new Error(
      `Invalid human assistance contract: unknown OCR page segmentation mode ${input.ocrPageSegmentationMode}.`,
    );
  }
  if (
    input.solverConfidenceThreshold !== undefined
    && (
      !Number.isFinite(input.solverConfidenceThreshold)
      || input.solverConfidenceThreshold < 0
      || input.solverConfidenceThreshold > 1
    )
  ) {
    throw new Error(
      "Invalid human assistance contract: solver confidence threshold must be finite and between 0 and 1.",
    );
  }
  if (
    input.expectedAnswerLength !== undefined
    && (
      !Number.isInteger(input.expectedAnswerLength)
      || input.expectedAnswerLength <= 0
      || input.expectedAnswerLength > MAX_EXPECTED_ANSWER_LENGTH
    )
  ) {
    throw new Error(
      `Invalid human assistance contract: expected answer length must be a positive integer no greater than ${MAX_EXPECTED_ANSWER_LENGTH}.`,
    );
  }
  if (input.prompt !== undefined) {
    nonEmpty(input.prompt, "prompt");
  }
  if (input.challengeImageRegion !== undefined) {
    assertChallengeImageRegion(input.challengeImageRegion);
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
    ...(input.challengeKind === undefined ? {} : { challengeKind: input.challengeKind }),
    ...(input.challengeImageRegion === undefined ? {} : { challengeImageRegion: { ...input.challengeImageRegion } }),
    ...(input.charset === undefined ? {} : { charset: input.charset }),
    ...(input.imagePreprocessing === undefined
      ? {}
      : { imagePreprocessing: [...input.imagePreprocessing] }),
    ...(input.ocrPageSegmentationMode === undefined
      ? {}
      : { ocrPageSegmentationMode: input.ocrPageSegmentationMode }),
    ...(input.solverConfidenceThreshold === undefined
      ? {}
      : { solverConfidenceThreshold: input.solverConfidenceThreshold }),
    ...(input.expectedAnswerLength === undefined
      ? {}
      : { expectedAnswerLength: input.expectedAnswerLength }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
  };
}

export function humanAssistanceContractFrame(input: HumanAssistanceContractInput): string {
  createHumanAssistanceContract(input, 1);
  return `${JSON.stringify(input)}\n`;
}

export function parseHumanAssistanceContractFrame(frame: string): HumanAssistanceContractInput | null {
  try {
    const value = JSON.parse(frame) as HumanAssistanceContractInput;
    createHumanAssistanceContract(value, 1);
    return value;
  } catch {
    return null;
  }
}

export function createHumanAssistanceContractFrameParser(
  onContract: (contract: HumanAssistanceContractInput) => void,
) {
  let pending = "";
  const decoder = new TextDecoder();
  return {
    push(chunk: string | Uint8Array) {
      pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const contract = parseHumanAssistanceContractFrame(line);
        if (contract) onContract(contract);
      }
    },
    flush() {
      pending += decoder.decode();
      const contract = parseHumanAssistanceContractFrame(pending);
      pending = "";
      if (contract) onContract(contract);
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
