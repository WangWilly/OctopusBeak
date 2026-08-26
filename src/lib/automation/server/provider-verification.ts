import type {
  HumanAssistanceContract,
  HumanAssistanceContractInput,
} from "../human-assistance.ts";
import {
  SINOPAC_CAPTCHA_INPUT_SELECTOR,
  SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID,
} from "../sinopac-captcha.ts";
import {
  YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR,
  YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR,
} from "../yuanta-trade-captcha.ts";
import {
  refreshTargetRect,
  sendHumanVerificationInput,
  withViewerPage,
  type ViewerTargetInputHandler,
  type ViewerPageAccess,
} from "./automation-viewer.ts";

const YUANTA_TRADE_CAPTCHA_CHECKBOX_SELECTOR = "#chbYCaptchaV2";
const CATHAY_EMAIL_OTP_SELECTOR = "#OtpMailPassword";

type YuantaCompletionProbe = {
  checkboxChecked: boolean;
  challengeVisible: boolean;
  challengeSubmitVisible: boolean;
};

type ProviderVerificationAdapter = {
  owns(contract: HumanAssistanceContract): boolean;
  refreshTarget(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<HumanAssistanceContractInput | null>;
  inspectCompletion(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<boolean>;
  handleInput?: ViewerTargetInputHandler;
  shouldCheckCompletion(inputType: unknown, semanticId: unknown): boolean;
  shouldAutoResume(
    contract: HumanAssistanceContract,
    targetId: unknown,
    verified: boolean,
  ): boolean;
};

export type ProviderVerificationPageRunner = <T>(
  session: string,
  action: (page: ViewerPageAccess) => Promise<T>,
) => Promise<T>;

export type ProviderVerificationInputForwarder = (
  session: string,
  rawInput: unknown,
  contract: HumanAssistanceContract,
  targetInputHandler?: ViewerTargetInputHandler,
) => Promise<unknown>;

export type ProviderVerificationHost = {
  refreshTarget(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<HumanAssistanceContractInput | null>;
  sendInput(
    session: string,
    rawInput: unknown,
    contract: HumanAssistanceContract,
  ): Promise<unknown>;
  inspectCompletion(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<boolean>;
  waitForCompletion(
    session: string,
    contract: HumanAssistanceContract,
    attempts?: number,
    intervalMs?: number,
  ): Promise<boolean>;
  shouldCheckCompletion(inputType: unknown, semanticId: unknown): boolean;
  shouldAutoResume(
    contract: HumanAssistanceContract,
    targetId: unknown,
    verified: boolean,
  ): boolean;
};

export type ProviderVerificationDependencies = {
  withPage?: ProviderVerificationPageRunner;
  sendInput?: ProviderVerificationInputForwarder;
  sleep?: (milliseconds: number) => Promise<void>;
};

function optionalContractMetadata(contract: HumanAssistanceContract) {
  return {
    ...(contract.challengeKind === undefined ? {} : { challengeKind: contract.challengeKind }),
    ...(contract.challengeImageRegion === undefined ? {} : { challengeImageRegion: contract.challengeImageRegion }),
    ...(contract.charset === undefined ? {} : { charset: contract.charset }),
    ...(contract.imagePreprocessing === undefined
      ? {}
      : { imagePreprocessing: contract.imagePreprocessing }),
    ...(contract.ocrPageSegmentationMode === undefined
      ? {}
      : { ocrPageSegmentationMode: contract.ocrPageSegmentationMode }),
    ...(contract.solverConfidenceThreshold === undefined
      ? {}
      : { solverConfidenceThreshold: contract.solverConfidenceThreshold }),
    ...(contract.expectedAnswerLength === undefined
      ? {}
      : { expectedAnswerLength: contract.expectedAnswerLength }),
    ...(contract.prompt === undefined ? {} : { prompt: contract.prompt }),
  };
}

async function visibleSinopacCaptchaInput(page: ViewerPageAccess) {
  const input = page.locator(SINOPAC_CAPTCHA_INPUT_SELECTOR);
  const count = await input.count().catch(() => 0);
  if (count !== 1) {
    throw new Error("SinoPac CAPTCHA input is missing or ambiguous.");
  }
  if (!await input.isVisible().catch(() => false)) {
    throw new Error("SinoPac CAPTCHA input is not visible.");
  }
  const rect = await input.boundingBox().catch(() => null);
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error("SinoPac CAPTCHA input is not visible.");
  }
  return { input, rect };
}

async function refreshCathayEmailOtpTarget(
  withPage: ProviderVerificationPageRunner,
  session: string,
  contract: HumanAssistanceContract,
): Promise<HumanAssistanceContractInput | null> {
  if (!contract.targets.some((target) => target.semanticId === "cathay.login.email-otp-input")) {
    return null;
  }
  const rect = await withPage(session, async (page) => {
    const otp = page.locator(CATHAY_EMAIL_OTP_SELECTOR).first();
    if (!await otp.isVisible().catch(() => false)) return null;
    return await otp.boundingBox().catch(() => null);
  });
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return refreshTargetRect(contract, "cathay.login.email-otp-input", rect);
}

async function refreshSinopacCaptchaTarget(
  withPage: ProviderVerificationPageRunner,
  session: string,
  contract: HumanAssistanceContract,
): Promise<HumanAssistanceContractInput | null> {
  if (!contract.targets.some((target) => target.semanticId === SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID)) {
    return null;
  }
  return withPage(session, async (page) => {
    const { rect } = await visibleSinopacCaptchaInput(page);
    return refreshTargetRect(contract, SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID, rect);
  });
}

const sinopacInputHandler: ViewerTargetInputHandler = async (page, input, target) => {
  if (target.semanticId !== SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID) return false;
  const { input: captcha } = await visibleSinopacCaptchaInput(page);
  if (input.type === "click") {
    await captcha.click();
    return true;
  }
  if (input.type === "type") {
    await captcha.fill(input.text);
    return true;
  }
  return false;
};

function yuantaCompletionSatisfied(
  semanticId: string,
  probe: YuantaCompletionProbe,
) {
  if (semanticId === "yuanta-trade.login.captcha-checkbox") {
    return probe.checkboxChecked || probe.challengeVisible;
  }
  if (semanticId === "yuanta-trade.login.challenge-control") {
    return !probe.challengeVisible;
  }
  if (semanticId === "yuanta-trade.login.challenge-submit") return !probe.challengeVisible;
  return false;
}

function shouldCheckYuantaCompletion(inputType: unknown, semanticId: unknown) {
  if (inputType !== "click") return false;
  return semanticId === "yuanta-trade.login.captcha-checkbox"
    || semanticId === "yuanta-trade.login.challenge-submit";
}

function shouldAutoResumeYuantaTradeCaptcha(
  contract: HumanAssistanceContract,
  targetId: unknown,
  verified: boolean,
) {
  if (!verified || contract.stageId !== "yuanta-trade-captcha-checkbox") return false;
  if (contract.completion.mode !== "independent") return false;
  return contract.targets.some((target) => (
    target.id === targetId
    && target.semanticId === "yuanta-trade.login.captcha-checkbox"
  ));
}

async function inspectYuantaCompletion(
  withPage: ProviderVerificationPageRunner,
  session: string,
  contract: HumanAssistanceContract,
) {
  if (contract.completion.mode !== "independent") return false;
  return withPage(session, async (page) => {
    const checkbox = page.locator(YUANTA_TRADE_CAPTCHA_CHECKBOX_SELECTOR).first();
    const challenge = page.locator(YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR).first();
    const checkboxChecked = await checkbox.evaluate((node) => {
      if (node instanceof HTMLInputElement) return node.checked;
      return node.getAttribute("aria-checked") === "true"
        || node.classList.contains("checked")
        || node.classList.contains("is-checked")
        || node.parentElement?.getAttribute("aria-checked") === "true";
    }).catch(() => false);
    const challengeVisible = await challenge.isVisible().catch(() => false);
    const challengeSubmitVisible = await challenge
      .locator(YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR)
      .first()
      .isVisible()
      .catch(() => false);
    const probe = { checkboxChecked, challengeVisible, challengeSubmitVisible };
    return contract.completion.targetIds.every((targetId) => {
      const target = contract.targets.find((candidate) => candidate.id === targetId);
      return target ? yuantaCompletionSatisfied(target.semanticId, probe) : false;
    });
  });
}

async function refreshYuantaChallengeSubmitTarget(
  withPage: ProviderVerificationPageRunner,
  session: string,
  contract: HumanAssistanceContract,
): Promise<HumanAssistanceContractInput | null> {
  const isChallengeStage = contract.targets.some(
    (target) => target.semanticId === "yuanta-trade.login.challenge-control",
  );
  const alreadyDeclared = contract.targets.some((target) => target.id === "challenge-submit");
  if (!isChallengeStage || alreadyDeclared) return null;

  const submitRect = await withPage(session, async (page) => {
    const challenge = page.locator(YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR).first();
    if (!await challenge.isVisible().catch(() => false)) return null;
    const submit = challenge.locator(YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR).first();
    if (!await submit.isVisible().catch(() => false)) return null;
    return await submit.boundingBox().catch(() => null);
  });
  if (!submitRect || submitRect.width <= 0 || submitRect.height <= 0) return null;

  return {
    stageId: contract.stageId,
    title: contract.title,
    targets: [
      ...contract.targets,
      {
        id: "challenge-submit",
        label: "Verify challenge",
        semanticId: "yuanta-trade.login.challenge-submit",
        modes: ["click"],
        rect: submitRect,
      },
    ],
    contextRegions: contract.contextRegions,
    completion: {
      ...contract.completion,
      targetIds: [...contract.completion.targetIds, "challenge-submit"],
      status: "pending",
    },
    focus: contract.focus,
    ...optionalContractMetadata(contract),
  };
}

function createAdapters(withPage: ProviderVerificationPageRunner): readonly ProviderVerificationAdapter[] {
  return [
    {
      owns: (contract) => contract.targets.some((target) => target.semanticId.startsWith("cathay.")),
      refreshTarget: (session, contract) => refreshCathayEmailOtpTarget(withPage, session, contract),
      inspectCompletion: async () => false,
      shouldCheckCompletion: () => false,
      shouldAutoResume: () => false,
    },
    {
      owns: (contract) => contract.targets.some((target) => target.semanticId === SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID),
      refreshTarget: (session, contract) => refreshSinopacCaptchaTarget(withPage, session, contract),
      inspectCompletion: async () => false,
      handleInput: sinopacInputHandler,
      shouldCheckCompletion: () => false,
      shouldAutoResume: () => false,
    },
    {
      owns: (contract) => contract.targets.some((target) => target.semanticId.startsWith("yuanta-trade.")),
      refreshTarget: (session, contract) => refreshYuantaChallengeSubmitTarget(withPage, session, contract),
      inspectCompletion: (session, contract) => inspectYuantaCompletion(withPage, session, contract),
      shouldCheckCompletion: shouldCheckYuantaCompletion,
      shouldAutoResume: shouldAutoResumeYuantaTradeCaptcha,
    },
  ];
}

export function createProviderVerificationHost(
  dependencies: ProviderVerificationDependencies = {},
): ProviderVerificationHost {
  const withPage = dependencies.withPage ?? withViewerPage;
  const forwardInput = dependencies.sendInput ?? sendHumanVerificationInput;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => (
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  ));
  const adapters = createAdapters(withPage);
  const matchingAdapters = (contract: HumanAssistanceContract) =>
    adapters.filter((adapter) => adapter.owns(contract));

  const refreshTarget = async (
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<HumanAssistanceContractInput | null> => {
    for (const adapter of matchingAdapters(contract)) {
      const refreshed = await adapter.refreshTarget(session, contract);
      if (refreshed) return refreshed;
    }
    return null;
  };

  const sendInput = (
    session: string,
    rawInput: unknown,
    contract: HumanAssistanceContract,
  ) => {
    const adapter = matchingAdapters(contract).find((candidate) => candidate.handleInput);
    return forwardInput(session, rawInput, contract, adapter?.handleInput);
  };

  const inspectCompletion = async (
    session: string,
    contract: HumanAssistanceContract,
  ) => {
    for (const adapter of matchingAdapters(contract)) {
      if (await adapter.inspectCompletion(session, contract)) return true;
    }
    return false;
  };

  const waitForCompletion = async (
    session: string,
    contract: HumanAssistanceContract,
    attempts = 12,
    intervalMs = 100,
  ) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await inspectCompletion(session, contract)) return true;
      if (attempt < attempts - 1) await sleep(intervalMs);
    }
    return false;
  };

  return {
    refreshTarget,
    sendInput,
    inspectCompletion,
    waitForCompletion,
    shouldCheckCompletion: (inputType, semanticId) =>
      adapters.some((adapter) => adapter.shouldCheckCompletion(inputType, semanticId)),
    shouldAutoResume: (contract, targetId, verified) =>
      matchingAdapters(contract).some((adapter) =>
        adapter.shouldAutoResume(contract, targetId, verified)),
  };
}

const defaultHost = createProviderVerificationHost();

export const refreshProviderVerificationTarget = defaultHost.refreshTarget;
export const sendProviderVerificationInput = defaultHost.sendInput;
export const inspectProviderVerificationCompletion = defaultHost.inspectCompletion;
export const waitForProviderVerificationCompletion = defaultHost.waitForCompletion;
export const shouldCheckProviderVerificationCompletion = defaultHost.shouldCheckCompletion;
export const shouldAutoResumeProviderVerification = defaultHost.shouldAutoResume;
