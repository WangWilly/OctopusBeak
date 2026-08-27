import type {
  HumanAssistanceContract,
  HumanAssistanceContractInput,
  HumanVerificationRect,
} from "../human-assistance.ts";
import { transformHumanAssistanceContract } from "../human-assistance.ts";
import {
  SINOPAC_CAPTCHA_IMAGE_SELECTOR,
  SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID,
  SINOPAC_CAPTCHA_INPUT_SELECTOR,
  SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID,
  SINOPAC_CAPTCHA_NATURAL_HEIGHT,
  SINOPAC_CAPTCHA_NATURAL_WIDTH,
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
import {
  createCaptchaSourceFreshnessStore,
  createLoadedCaptchaSourceOwner,
  type CaptchaImageDescriptor,
} from "./captcha-source-freshness.ts";
import {
  createProviderVerificationCapabilityRegistry,
  type ProviderVerificationCapabilityOwner,
} from "./provider-verification-capabilities.ts";

const YUANTA_TRADE_CAPTCHA_CHECKBOX_SELECTOR = "#chbYCaptchaV2";
const CATHAY_EMAIL_OTP_SELECTOR = "#OtpMailPassword";
export const YUANTA_BANK_CAPTCHA_IMAGE_SELECTOR = 'img[src*="GOTP"]:visible';
export const FUBON_CAPTCHA_IMAGE_SELECTOR = 'img[src*="captchaImage"]:visible';
const FUBON_CAPTCHA_INPUT_SEMANTIC_ID = "fubon.login.captcha-input";
const FUBON_CAPTCHA_IMAGE_SEMANTIC_ID = "fubon.login.captcha-image";
const FUBON_CAPTCHA_FRAME_NAME = "txnFrame";
const FUBON_CAPTCHA_NATURAL_WIDTH = 158;
const FUBON_CAPTCHA_NATURAL_HEIGHT = 30;

type YuantaCompletionProbe = {
  checkboxChecked: boolean;
  challengeVisible: boolean;
  challengeSubmitVisible: boolean;
};

type ProviderVerificationAdapter = {
  id: string;
  capabilityOwner?: ProviderVerificationCapabilityOwner;
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
  captureChallengeImage(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<Buffer | null>;
  isChallengeImageCurrent(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<boolean>;
  handlesChallengeImage(contract: HumanAssistanceContract): boolean;
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

function sinopacCaptchaContract(contract: HumanAssistanceContract) {
  return contract.targets.some(
    (target) => target.semanticId === SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID,
  ) && contract.challengeImageRegion?.semanticId === SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID;
}

function yuantaBankCaptchaContract(contract: HumanAssistanceContract) {
  return contract.targets.some(
    (target) => target.semanticId === "yuanta-bank.login.captcha-input",
  ) && contract.challengeImageRegion?.semanticId === "yuanta-bank.login.captcha-image";
}

function fubonCaptchaContract(contract: HumanAssistanceContract) {
  return contract.targets.some(
    (target) => target.semanticId === FUBON_CAPTCHA_INPUT_SEMANTIC_ID,
  ) && contract.challengeImageRegion?.semanticId === FUBON_CAPTCHA_IMAGE_SEMANTIC_ID;
}

async function resolveFubonCaptchaImage(
  page: ViewerPageAccess,
  _contract: HumanAssistanceContract,
): Promise<CaptchaImageDescriptor | null> {
  let frame;
  try {
    frame = page.frame?.(FUBON_CAPTCHA_FRAME_NAME);
  } catch {
    return null;
  }
  if (!frame) return null;

  const images = frame.locator(FUBON_CAPTCHA_IMAGE_SELECTOR);
  const count = await images.count().catch(() => 0);
  if (count !== 1) return null;
  const image = images.first();
  if (!await image.isVisible().catch(() => false)) return null;
  const rect = await image.boundingBox().catch(() => null);
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;

  return {
    image,
    rect,
    pageUrl: page.url?.() ?? "",
    frameUrl: typeof frame.url === "function" ? frame.url() : "",
    frameName: typeof frame.name === "function" ? frame.name() : "",
    markerKey: "__octopusBeakFubonCaptchaFrameMarker",
  };
}

async function resolveYuantaCaptchaImage(
  page: ViewerPageAccess,
  _contract: HumanAssistanceContract,
): Promise<CaptchaImageDescriptor | null> {
  let frame;
  try {
    frame = page.frame?.("main") ?? page.mainFrame?.();
  } catch {
    return null;
  }
  if (!frame) return null;

  const images = frame.locator(YUANTA_BANK_CAPTCHA_IMAGE_SELECTOR);
  const count = await images.count().catch(() => 0);
  if (count !== 1) return null;
  const image = images.first();
  if (!await image.isVisible().catch(() => false)) return null;
  const rect = await image.boundingBox().catch(() => null);
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;

  const pageUrl = page.url?.() ?? "";
  const frameUrl = typeof frame.url === "function" ? frame.url() : "";
  const frameName = typeof frame.name === "function" ? frame.name() : "";
  return {
    image,
    rect,
    pageUrl,
    frameUrl,
    frameName,
    markerKey: "__octopusBeakYuantaCaptchaFrameMarker",
  };
}

async function resolveSinopacCaptchaImage(
  page: ViewerPageAccess,
  _contract: HumanAssistanceContract,
): Promise<CaptchaImageDescriptor | null> {
  const images = page.locator(SINOPAC_CAPTCHA_IMAGE_SELECTOR);
  const count = await images.count().catch(() => 0);
  if (count !== 1) return null;
  const image = images.first();
  if (!await image.isVisible().catch(() => false)) return null;
  const rect = await image.boundingBox().catch(() => null);
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;

  const pageUrl = page.url?.() ?? "";
  return {
    image,
    rect,
    pageUrl,
    frameUrl: pageUrl,
    frameName: "top",
    markerKey: "__octopusBeakSinopacCaptchaPageMarker",
  };
}

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

  return transformHumanAssistanceContract(contract, (input) => ({
    ...input,
    targets: [
      ...input.targets,
      {
        id: "challenge-submit",
        label: "Verify challenge",
        semanticId: "yuanta-trade.login.challenge-submit",
        modes: ["click"],
        rect: submitRect,
      },
    ],
    completion: {
      ...input.completion,
      targetIds: [...input.completion.targetIds, "challenge-submit"],
      status: "pending",
    },
  }));
}

function createAdapters(withPage: ProviderVerificationPageRunner): readonly ProviderVerificationAdapter[] {
  const fubonSourceOwner = createLoadedCaptchaSourceOwner({
    id: FUBON_CAPTCHA_IMAGE_SEMANTIC_ID,
    withPage,
    resolveImage: resolveFubonCaptchaImage,
    naturalWidth: FUBON_CAPTCHA_NATURAL_WIDTH,
    naturalHeight: FUBON_CAPTCHA_NATURAL_HEIGHT,
  });
  const sinopacSourceOwner = createLoadedCaptchaSourceOwner({
    id: "sinopac.login.captcha-image",
    withPage,
    resolveImage: resolveSinopacCaptchaImage,
    naturalWidth: SINOPAC_CAPTCHA_NATURAL_WIDTH,
    naturalHeight: SINOPAC_CAPTCHA_NATURAL_HEIGHT,
  });
  const yuantaSourceOwner = createLoadedCaptchaSourceOwner({
    id: "yuanta-bank.login.captcha-image",
    withPage,
    resolveImage: resolveYuantaCaptchaImage,
  });
  return [
    {
      id: "fubon",
      capabilityOwner: {
        id: fubonSourceOwner.id,
        capabilities: ["challenge-image"],
        owns: fubonCaptchaContract,
        sourceOwner: fubonSourceOwner,
      },
      owns: (contract) => contract.targets.some(
        (target) => target.semanticId === FUBON_CAPTCHA_INPUT_SEMANTIC_ID,
      ),
      refreshTarget: async () => null,
      inspectCompletion: async () => false,
      shouldCheckCompletion: () => false,
      shouldAutoResume: () => false,
    },
    {
      id: "cathay",
      owns: (contract) => contract.targets.some((target) => target.semanticId.startsWith("cathay.")),
      refreshTarget: (session, contract) => refreshCathayEmailOtpTarget(withPage, session, contract),
      inspectCompletion: async () => false,
      shouldCheckCompletion: () => false,
      shouldAutoResume: () => false,
    },
    {
      id: "sinopac",
      capabilityOwner: {
        id: sinopacSourceOwner.id,
        capabilities: ["challenge-image"],
        owns: sinopacCaptchaContract,
        sourceOwner: sinopacSourceOwner,
      },
      owns: (contract) => contract.targets.some((target) => target.semanticId === SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID),
      refreshTarget: (session, contract) => refreshSinopacCaptchaTarget(withPage, session, contract),
      inspectCompletion: async () => false,
      handleInput: sinopacInputHandler,
      shouldCheckCompletion: () => false,
      shouldAutoResume: () => false,
    },
    {
      id: "yuanta",
      capabilityOwner: {
        id: yuantaSourceOwner.id,
        capabilities: ["challenge-image"],
        owns: yuantaBankCaptchaContract,
        sourceOwner: yuantaSourceOwner,
      },
      owns: (contract) => contract.targets.some((target) => (
        target.semanticId.startsWith("yuanta-trade.")
        || target.semanticId.startsWith("yuanta-bank.")
      )),
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
  const capabilityRegistry = createProviderVerificationCapabilityRegistry(
    adapters.flatMap((adapter) => adapter.capabilityOwner ? [adapter.capabilityOwner] : []),
  );
  const sourceFreshness = createCaptchaSourceFreshnessStore((ownerId, contract) =>
    capabilityRegistry.resolveById("challenge-image", ownerId, contract)?.sourceOwner ?? null,
  );
  const matchingAdapters = (contract: HumanAssistanceContract) =>
    adapters.filter((adapter) => adapter.owns(contract));

  const handlesChallengeImage = (contract: HumanAssistanceContract) =>
    capabilityRegistry.resolve("challenge-image", contract)?.sourceOwner !== undefined;

  const captureChallengeImage = async (
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<Buffer | null> => {
    const owner = capabilityRegistry.resolve("challenge-image", contract)?.sourceOwner;
    if (!owner) {
      sourceFreshness.clear(session);
      return null;
    }
    return sourceFreshness.capture(session, contract, owner);
  };

  const isChallengeImageCurrent = async (
    session: string,
    contract: HumanAssistanceContract,
  ) => {
    return sourceFreshness.isCurrent(session, contract);
  };

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
    captureChallengeImage,
    isChallengeImageCurrent,
    handlesChallengeImage,
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

export const captureProviderVerificationImage = defaultHost.captureChallengeImage;
export const isProviderVerificationImageCurrent = defaultHost.isChallengeImageCurrent;
export const providerVerificationHandlesChallengeImage = defaultHost.handlesChallengeImage;
export const refreshProviderVerificationTarget = defaultHost.refreshTarget;
export const sendProviderVerificationInput = defaultHost.sendInput;
export const inspectProviderVerificationCompletion = defaultHost.inspectCompletion;
export const waitForProviderVerificationCompletion = defaultHost.waitForCompletion;
export const shouldCheckProviderVerificationCompletion = defaultHost.shouldCheckCompletion;
export const shouldAutoResumeProviderVerification = defaultHost.shouldAutoResume;
