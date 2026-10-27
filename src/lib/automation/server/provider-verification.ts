import type { HumanAssistanceContract } from "../human-assistance.ts";
import {
  SINOPAC_CAPTCHA_IMAGE_SELECTOR,
  SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID,
  SINOPAC_CAPTCHA_INPUT_SELECTOR,
  SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID,
  SINOPAC_CAPTCHA_NATURAL_HEIGHT,
  SINOPAC_CAPTCHA_NATURAL_WIDTH,
} from "../sinopac-captcha.ts";
import {
  POST_CAPTCHA_INPUT_SELECTOR,
  POST_CAPTCHA_INPUT_SEMANTIC_ID,
  POST_CAPTCHA_STAGE_ID,
} from "../post-captcha.ts";
import {
  YUANTA_TRADE_AUDIO_PATH,
  YUANTA_TRADE_AUDIO_SEMANTIC_ID,
  YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR,
  YUANTA_TRADE_CAPTCHA_CHECKBOX_SELECTOR,
  YUANTA_TRADE_CAPTCHA_CHECKBOX_SEMANTIC_ID,
  YUANTA_TRADE_CAPTCHA_CHECKBOX_STAGE_ID,
  YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR,
  YUANTA_TRADE_CHALLENGE_CONTROL_SEMANTIC_ID,
  YUANTA_TRADE_CHALLENGE_SUBMIT_SEMANTIC_ID,
} from "../yuanta-trade-captcha.ts";
import {
  YUANTA_BANK_CAPTCHA_IMAGE_SELECTOR,
  YUANTA_BANK_CAPTCHA_IMAGE_SEMANTIC_ID,
  YUANTA_BANK_CAPTCHA_INPUT_SEMANTIC_ID,
  YUANTA_BANK_MAIN_FRAME_NAME,
} from "../yuanta-captcha.ts";
import {
  FUBON_CAPTCHA_IMAGE_SELECTOR,
  FUBON_CAPTCHA_IMAGE_SEMANTIC_ID,
  FUBON_CAPTCHA_INPUT_SEMANTIC_ID,
  FUBON_CAPTCHA_NATURAL_HEIGHT,
  FUBON_CAPTCHA_NATURAL_WIDTH,
  FUBON_LOGIN_FRAME_NAME,
} from "../fubon-captcha.ts";
import {
  automationViewer,
  type PageForRun,
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

type YuantaCompletionProbe = {
  checkboxChecked: boolean;
  challengeVisible: boolean;
  challengeSubmitVisible: boolean;
};

type ProviderVerificationAdapter = {
  id: string;
  capabilityOwner?: ProviderVerificationCapabilityOwner;
  owns(contract: HumanAssistanceContract): boolean;
  inspectCompletion(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<boolean>;
  handleInput?: ViewerTargetInputHandler;
  /** Fails when a solver click did not reach the provider's verified state. */
  confirmClick?(session: string, contract: HumanAssistanceContract): Promise<void>;
};

type ProviderVerificationPageRunner = <T>(
  session: string,
  action: (page: ViewerPageAccess) => Promise<T>,
) => Promise<T>;

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
  /** True only when the challenge-image owner declares an in-page refresh control. */
  refreshesChallengeImage(contract: HumanAssistanceContract): boolean;
  refreshChallengeImage(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<boolean>;
  handlesChallengeAudio(contract: HumanAssistanceContract): boolean;
  captureChallengeAudio(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<Buffer | null>;
  sendInput(
    session: string,
    rawInput: unknown,
    contract: HumanAssistanceContract,
  ): Promise<unknown>;
  injectAnswer(
    session: string,
    contract: HumanAssistanceContract,
    answer: string,
  ): Promise<void>;
  /** Clicks a declared target, then holds the provider to its verified state. */
  clickTarget(
    session: string,
    contract: HumanAssistanceContract,
    targetId: string,
  ): Promise<void>;
  inspectCompletion(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<boolean>;
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

const sinopacInputHandler: ViewerTargetInputHandler = async (page, input, target) => {
  if (target.semanticId !== SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID) return false;
  const { input: captcha } = await visibleSinopacCaptchaInput(page);
  if (input.type === "click") {
    await captcha.click();
    return true;
  }
  if (input.type === "type") {
    await captcha.fill(input.text);
    if ((await captcha.inputValue()).trim() !== input.text) {
      // Retention is a provider-side input failure, not evidence that a new
      // CAPTCHA challenge exists.  Keep it as an ordinary error so generic
      // routing fails closed instead of silently spending a retry round.
      throw new Error("SinoPac CAPTCHA input did not retain the solver answer.");
    }
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
    (target) => target.semanticId === YUANTA_BANK_CAPTCHA_INPUT_SEMANTIC_ID,
  ) && contract.challengeImageRegion?.semanticId === YUANTA_BANK_CAPTCHA_IMAGE_SEMANTIC_ID;
}

function yuantaTradeAudioContract(contract: HumanAssistanceContract) {
  return contract.challengeAudioSource?.semanticId === YUANTA_TRADE_AUDIO_SEMANTIC_ID;
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
    frame = page.frame?.(FUBON_LOGIN_FRAME_NAME);
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
    scope: frame,
  };
}

async function resolveYuantaCaptchaImage(
  page: ViewerPageAccess,
  _contract: HumanAssistanceContract,
): Promise<CaptchaImageDescriptor | null> {
  let frame;
  try {
    frame = page.frame?.(YUANTA_BANK_MAIN_FRAME_NAME) ?? page.mainFrame?.();
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
    scope: frame,
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
    scope: page,
  };
}

function yuantaCompletionSatisfied(
  semanticId: string,
  probe: YuantaCompletionProbe,
) {
  if (semanticId === YUANTA_TRADE_CAPTCHA_CHECKBOX_SEMANTIC_ID) {
    return probe.checkboxChecked || probe.challengeVisible;
  }
  if (semanticId === YUANTA_TRADE_CHALLENGE_CONTROL_SEMANTIC_ID) {
    return !probe.challengeVisible;
  }
  if (semanticId === YUANTA_TRADE_CHALLENGE_SUBMIT_SEMANTIC_ID) return !probe.challengeVisible;
  return false;
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

function createAdapters(
  withPage: ProviderVerificationPageRunner,
): readonly ProviderVerificationAdapter[] {
  const fubonSourceOwner = createLoadedCaptchaSourceOwner({
    id: FUBON_CAPTCHA_IMAGE_SEMANTIC_ID,
    withPage,
    resolveImage: resolveFubonCaptchaImage,
    naturalWidth: FUBON_CAPTCHA_NATURAL_WIDTH,
    naturalHeight: FUBON_CAPTCHA_NATURAL_HEIGHT,
  });
  const sinopacSourceOwner = createLoadedCaptchaSourceOwner({
    id: SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID,
    withPage,
    resolveImage: resolveSinopacCaptchaImage,
    naturalWidth: SINOPAC_CAPTCHA_NATURAL_WIDTH,
    naturalHeight: SINOPAC_CAPTCHA_NATURAL_HEIGHT,
  });
  const yuantaSourceOwner = createLoadedCaptchaSourceOwner({
    id: YUANTA_BANK_CAPTCHA_IMAGE_SEMANTIC_ID,
    withPage,
    resolveImage: resolveYuantaCaptchaImage,
  });
  return [
    {
      id: "post",
      owns: contract => contract.stageId === POST_CAPTCHA_STAGE_ID
        && contract.targets.some(target => target.semanticId === POST_CAPTCHA_INPUT_SEMANTIC_ID),
      inspectCompletion: async () => false,
      handleInput: async (page, operation, target) => {
        if (target.semanticId !== POST_CAPTCHA_INPUT_SEMANTIC_ID) return false;
        const input = page.locator(POST_CAPTCHA_INPUT_SELECTOR);
        if (await input.count() !== 1 || !await input.isVisible()) {
          throw new Error("Post CAPTCHA field is missing or ambiguous.");
        }
        if (operation.type === "click") {
          await input.click();
          return true;
        }
        if (operation.type === "type") {
          await input.fill(operation.text);
          if (await input.inputValue() !== operation.text) {
            throw new Error("Post CAPTCHA field did not retain the solver answer.");
          }
          return true;
        }
        return false;
      },
    },
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
      inspectCompletion: async () => false,
    },
    {
      id: "cathay",
      owns: (contract) => contract.targets.some((target) => target.semanticId.startsWith("cathay.")),
      inspectCompletion: async () => false,
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
      inspectCompletion: async () => false,
      handleInput: sinopacInputHandler,
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
      inspectCompletion: (session, contract) => inspectYuantaCompletion(withPage, session, contract),
      async confirmClick(session, contract) {
        if (
          contract.stageId === YUANTA_TRADE_CAPTCHA_CHECKBOX_STAGE_ID
          && !await inspectYuantaCompletion(withPage, session, contract)
        ) {
          throw new Error("Yuanta Trade CAPTCHA checkbox did not reach its verified state.");
        }
      },
    },
  ];
}

/** Each run's provider adapters, reaching its page only through the page lookup. */
export function createProviderVerificationHost(
  dependencies: Readonly<{ pageForRun: PageForRun }>,
): ProviderVerificationHost {
  const viewer = automationViewer(dependencies.pageForRun);
  const withPage = viewer.withPage;
  const forwardInput = viewer.sendHumanVerificationInput;
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

  const refreshesChallengeImage = (contract: HumanAssistanceContract) =>
    capabilityRegistry.resolve("challenge-image", contract)?.sourceOwner?.refresh !== undefined;

  const refreshChallengeImage = (session: string, contract: HumanAssistanceContract) =>
    sourceFreshness.refresh(session, contract);

  const handlesChallengeAudio = (contract: HumanAssistanceContract) =>
    yuantaTradeAudioContract(contract);

  const captureChallengeAudio = async (
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<Buffer | null> => {
    if (!yuantaTradeAudioContract(contract)) return null;
    return withPage(session, async (page) => {
      if (!page.evaluate) return null;
      // Fetch inside the page so the provider session cookie is carried; a
      // Node-side request on a CDP-connected context drops the httpOnly
      // session cookie and the provider answers with an error clip.
      const bytes = await page.evaluate(async (audioPath) => {
        const response = await fetch(String(audioPath));
        if (!response.ok) return null;
        const buffer = await response.arrayBuffer();
        return Array.from(new Uint8Array(buffer));
      }, YUANTA_TRADE_AUDIO_PATH);
      if (!bytes || bytes.length === 0) return null;
      return Buffer.from(bytes);
    });
  };

  const sendInput = (
    session: string,
    rawInput: unknown,
    contract: HumanAssistanceContract,
  ) => {
    const adapter = matchingAdapters(contract).find((candidate) => candidate.handleInput);
    return forwardInput(session, rawInput, contract, adapter?.handleInput);
  };

  const injectAnswer = async (
    session: string,
    contract: HumanAssistanceContract,
    answer: string,
  ) => {
    const focusTarget = contract.targets.find((target) =>
      target.id === contract.focus.targetId && target.modes.includes("type")
    );
    const target = focusTarget
      ?? contract.targets.find((candidate) => candidate.modes.includes("type"));
    if (!target) {
      throw new Error("Verification contract declares no type target for the solver answer.");
    }
    await sendInput(session, {
      type: "type",
      text: answer,
      targetId: target.id,
      contractVersion: contract.version,
    }, contract);
  };

  const clickTarget = async (
    session: string,
    contract: HumanAssistanceContract,
    targetId: string,
  ) => {
    await viewer.clickTarget(session, contract, targetId);
    for (const adapter of matchingAdapters(contract)) {
      await adapter.confirmClick?.(session, contract);
    }
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

  return {
    captureChallengeImage,
    isChallengeImageCurrent,
    handlesChallengeImage,
    refreshesChallengeImage,
    refreshChallengeImage,
    handlesChallengeAudio,
    captureChallengeAudio,
    sendInput,
    injectAnswer,
    clickTarget,
    inspectCompletion,
  };
}
