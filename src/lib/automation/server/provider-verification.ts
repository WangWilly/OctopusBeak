import { createHash } from "node:crypto";
import type {
  HumanAssistanceContract,
  HumanAssistanceContractInput,
  HumanVerificationRect,
} from "../human-assistance.ts";
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

const YUANTA_TRADE_CAPTCHA_CHECKBOX_SELECTOR = "#chbYCaptchaV2";
const CATHAY_EMAIL_OTP_SELECTOR = "#OtpMailPassword";
export const YUANTA_BANK_CAPTCHA_IMAGE_SELECTOR = 'img[src*="GOTP"]:visible';

type ProviderCaptchaFingerprint = {
  pageUrl: string;
  frameUrl: string;
  frameIdentity: string;
  sourceMarker: string;
  rect: HumanVerificationRect;
  naturalWidth?: number;
  naturalHeight?: number;
  imageHash?: string;
};

type ProviderCaptchaCapture = {
  image: Buffer;
  fingerprint: ProviderCaptchaFingerprint;
  source: "loaded-image" | "screenshot";
};

type ProviderCaptchaSource = {
  dataUrl: string | null;
  sourceMarker: string;
  frameMarker: string;
  naturalWidth: number;
  naturalHeight: number;
};

type YuantaCompletionProbe = {
  checkboxChecked: boolean;
  challengeVisible: boolean;
  challengeSubmitVisible: boolean;
};

type ProviderVerificationAdapter = {
  owns(contract: HumanAssistanceContract): boolean;
  captureChallengeImage?: (
    session: string,
    contract: HumanAssistanceContract,
  ) => Promise<ProviderCaptchaCapture | null>;
  isChallengeImageCurrent?: (
    session: string,
    contract: HumanAssistanceContract,
    capture: ProviderCaptchaCapture,
  ) => Promise<boolean>;
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
    ...(contract.ocrAttemptPlan === undefined
      ? {}
      : { ocrAttemptPlan: contract.ocrAttemptPlan }),
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

function rectMatches(left: HumanVerificationRect, right: HumanVerificationRect) {
  return Math.abs(left.x - right.x) <= 1
    && Math.abs(left.y - right.y) <= 1
    && Math.abs(left.width - right.width) <= 1
    && Math.abs(left.height - right.height) <= 1;
}

function hashImage(image: Buffer) {
  return createHash("sha256").update(image).digest("hex");
}

function imageFromDataUrl(dataUrl: unknown): Buffer | null {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match?.[1]) return null;
  try {
    const image = Buffer.from(match[1], "base64");
    return image.length > 0 ? image : null;
  } catch {
    return null;
  }
}

async function inspectCaptchaImageSource(
  image: ReturnType<ViewerPageAccess["locator"]>,
  markerKey: string,
): Promise<ProviderCaptchaSource | null> {
  return image.evaluate((node, key) => {
    if (!(node instanceof HTMLImageElement)) return null;
    const windowRecord = window as typeof window & Record<string, unknown>;
    const existingMarker = windowRecord[key];
    const frameMarker = typeof existingMarker === "string"
      ? existingMarker
      : `${Date.now()}-${Math.random()}`;
    windowRecord[key] = frameMarker;
    const sourceMarker = () => JSON.stringify({
      frameMarker,
      href: document.location.href,
      src: node.getAttribute("src"),
      currentSrc: node.currentSrc,
      id: node.id,
      className: node.className,
      naturalWidth: node.naturalWidth,
      naturalHeight: node.naturalHeight,
    });
    if (!node.complete || node.naturalWidth <= 0 || node.naturalHeight <= 0) {
      return {
        dataUrl: null,
        frameMarker,
        sourceMarker: sourceMarker(),
        naturalWidth: node.naturalWidth,
        naturalHeight: node.naturalHeight,
      };
    }
    const canvas = document.createElement("canvas");
    canvas.width = node.naturalWidth;
    canvas.height = node.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    let dataUrl: string | null = null;
    try {
      context.drawImage(node, 0, 0, node.naturalWidth, node.naturalHeight);
      dataUrl = canvas.toDataURL("image/png");
    } catch {
      // Callers decide whether their calibrated provider permits a screenshot
      // fallback. The source marker still guards that fallback against staleness.
    }
    return {
      dataUrl,
      frameMarker,
      sourceMarker: sourceMarker(),
      naturalWidth: node.naturalWidth,
      naturalHeight: node.naturalHeight,
    };
  }, markerKey).catch(() => null) as Promise<ProviderCaptchaSource | null>;
}

function sinopacCaptchaContract(contract: HumanAssistanceContract) {
  return contract.targets.some(
    (target) => target.semanticId === SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID,
  ) && contract.challengeImageRegion?.semanticId === SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID;
}

function yuantaBankCaptchaContract(contract: HumanAssistanceContract) {
  return contract.targets.some((target) => target.semanticId.startsWith("yuanta-bank."))
    || contract.challengeImageRegion?.semanticId === "yuanta-bank.login.captcha-image";
}

async function inspectYuantaCaptchaSource(page: ViewerPageAccess) {
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
  const source = await inspectCaptchaImageSource(
    image,
    "__octopusBeakYuantaCaptchaFrameMarker",
  );

  return { image, rect, pageUrl, frameUrl, frameName, source };
}

async function inspectSinopacCaptchaSource(page: ViewerPageAccess) {
  const images = page.locator(SINOPAC_CAPTCHA_IMAGE_SELECTOR);
  const count = await images.count().catch(() => 0);
  if (count !== 1) return null;
  const image = images.first();
  if (!await image.isVisible().catch(() => false)) return null;
  const rect = await image.boundingBox().catch(() => null);
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;

  const pageUrl = page.url?.() ?? "";
  const source = await inspectCaptchaImageSource(
    image,
    "__octopusBeakSinopacCaptchaPageMarker",
  );
  return {
    image,
    rect,
    pageUrl,
    frameUrl: pageUrl,
    frameName: "top",
    source,
  };
}

function fingerprintForProviderCapture(input: {
  pageUrl: string;
  frameUrl: string;
  frameName: string;
  rect: HumanVerificationRect;
  source: ProviderCaptchaSource;
  image?: Buffer;
}): ProviderCaptchaFingerprint {
  return {
    pageUrl: input.pageUrl,
    frameUrl: input.frameUrl,
    frameIdentity: `${input.frameName}|${input.frameUrl}|${input.source.frameMarker}`,
    sourceMarker: input.source.sourceMarker,
    rect: input.rect,
    ...(input.source.naturalWidth > 0 ? { naturalWidth: input.source.naturalWidth } : {}),
    ...(input.source.naturalHeight > 0 ? { naturalHeight: input.source.naturalHeight } : {}),
    ...(input.image ? { imageHash: hashImage(input.image) } : {}),
  };
}

function calibratedSinopacSource(source: ProviderCaptchaSource | null) {
  return source?.naturalWidth === SINOPAC_CAPTCHA_NATURAL_WIDTH
    && source.naturalHeight === SINOPAC_CAPTCHA_NATURAL_HEIGHT;
}

async function captureSinopacCaptcha(
  withPage: ProviderVerificationPageRunner,
  session: string,
  contract: HumanAssistanceContract,
): Promise<ProviderCaptchaCapture | null> {
  if (!sinopacCaptchaContract(contract)) return null;
  return withPage(session, async (page) => {
    const inspected = await inspectSinopacCaptchaSource(page);
    if (!inspected || !calibratedSinopacSource(inspected.source)) return null;
    const sourceImage = imageFromDataUrl(inspected.source?.dataUrl);
    if (!sourceImage || !inspected.source) return null;
    return {
      image: sourceImage,
      source: "loaded-image",
      fingerprint: fingerprintForProviderCapture({
        pageUrl: inspected.pageUrl,
        frameUrl: inspected.frameUrl,
        frameName: inspected.frameName,
        rect: inspected.rect,
        source: inspected.source,
        image: sourceImage,
      }),
    };
  });
}

async function currentSinopacCaptureMatches(
  withPage: ProviderVerificationPageRunner,
  session: string,
  capture: ProviderCaptchaCapture,
) {
  return withPage(session, async (page) => {
    const inspected = await inspectSinopacCaptchaSource(page);
    if (!inspected || !calibratedSinopacSource(inspected.source)) return false;
    const sourceImage = imageFromDataUrl(inspected.source?.dataUrl);
    if (!sourceImage || !inspected.source) return false;
    const fingerprint = fingerprintForProviderCapture({
      pageUrl: inspected.pageUrl,
      frameUrl: inspected.frameUrl,
      frameName: inspected.frameName,
      rect: inspected.rect,
      source: inspected.source,
      image: sourceImage,
    });
    return fingerprint.pageUrl === capture.fingerprint.pageUrl
      && fingerprint.frameUrl === capture.fingerprint.frameUrl
      && fingerprint.frameIdentity === capture.fingerprint.frameIdentity
      && fingerprint.sourceMarker === capture.fingerprint.sourceMarker
      && rectMatches(fingerprint.rect, capture.fingerprint.rect)
      && fingerprint.imageHash === capture.fingerprint.imageHash;
  });
}

async function captureYuantaCaptcha(
  withPage: ProviderVerificationPageRunner,
  session: string,
  contract: HumanAssistanceContract,
): Promise<ProviderCaptchaCapture | null> {
  if (!yuantaBankCaptchaContract(contract)) return null;
  return withPage(session, async (page) => {
    const inspected = await inspectYuantaCaptchaSource(page);
    if (!inspected) return null;

    const sourceImage = imageFromDataUrl(inspected.source?.dataUrl);
    if (sourceImage && inspected.source) {
      return {
        image: sourceImage,
        source: "loaded-image",
        fingerprint: fingerprintForProviderCapture({
          pageUrl: inspected.pageUrl,
          frameUrl: inspected.frameUrl,
          frameName: inspected.frameName,
          rect: inspected.rect,
          source: inspected.source,
          image: sourceImage,
        }),
      };
    }

    // A screenshot is safe only after the live provider frame and image have
    // both been resolved. Never fall back to a stale contract rectangle.
    if (!inspected.source || typeof page.screenshot !== "function") return null;
    const fallback = await page.screenshot({ clip: inspected.rect, type: "png" }).catch(() => null);
    if (!fallback) return null;
    return {
      image: fallback,
      source: "screenshot",
      fingerprint: fingerprintForProviderCapture({
        pageUrl: inspected.pageUrl,
        frameUrl: inspected.frameUrl,
        frameName: inspected.frameName,
        rect: inspected.rect,
        source: inspected.source,
        image: fallback,
      }),
    };
  });
}

async function currentYuantaCaptureMatches(
  withPage: ProviderVerificationPageRunner,
  session: string,
  capture: ProviderCaptchaCapture,
) {
  return withPage(session, async (page) => {
    const inspected = await inspectYuantaCaptchaSource(page);
    if (!inspected?.source) return false;
    const fingerprint = fingerprintForProviderCapture({
      pageUrl: inspected.pageUrl,
      frameUrl: inspected.frameUrl,
      frameName: inspected.frameName,
      rect: inspected.rect,
      source: inspected.source,
      image: imageFromDataUrl(inspected.source.dataUrl) ?? undefined,
    });
    if (fingerprint.pageUrl !== capture.fingerprint.pageUrl
      || fingerprint.frameUrl !== capture.fingerprint.frameUrl
      || fingerprint.frameIdentity !== capture.fingerprint.frameIdentity
      || fingerprint.sourceMarker !== capture.fingerprint.sourceMarker
      || !rectMatches(fingerprint.rect, capture.fingerprint.rect)) {
      return false;
    }
    if (capture.source === "loaded-image") {
      return fingerprint.imageHash === capture.fingerprint.imageHash;
    }
    if (typeof page.screenshot !== "function" || !capture.fingerprint.imageHash) return false;
    const currentScreenshot = await page.screenshot({ clip: inspected.rect, type: "png" }).catch(() => null);
    return currentScreenshot
      ? hashImage(currentScreenshot) === capture.fingerprint.imageHash
      : false;
  });
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
      captureChallengeImage: (session, contract) =>
        captureSinopacCaptcha(withPage, session, contract),
      isChallengeImageCurrent: (session, contract, capture) =>
        sinopacCaptchaContract(contract)
          ? currentSinopacCaptureMatches(withPage, session, capture)
          : Promise.resolve(false),
      refreshTarget: (session, contract) => refreshSinopacCaptchaTarget(withPage, session, contract),
      inspectCompletion: async () => false,
      handleInput: sinopacInputHandler,
      shouldCheckCompletion: () => false,
      shouldAutoResume: () => false,
    },
    {
      owns: (contract) => contract.targets.some((target) => (
        target.semanticId.startsWith("yuanta-trade.")
        || target.semanticId.startsWith("yuanta-bank.")
      )),
      captureChallengeImage: (session, contract) =>
        captureYuantaCaptcha(withPage, session, contract),
      isChallengeImageCurrent: (session, contract, capture) =>
        yuantaBankCaptchaContract(contract)
          ? currentYuantaCaptureMatches(withPage, session, capture)
          : Promise.resolve(true),
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
  const challengeCaptures = new Map<string, {
    stageId: string;
    contractVersion: number;
    capture: ProviderCaptchaCapture;
  }>();

  const handlesChallengeImage = (contract: HumanAssistanceContract) =>
    (sinopacCaptchaContract(contract) || yuantaBankCaptchaContract(contract))
    && matchingAdapters(contract).some((adapter) => Boolean(adapter.captureChallengeImage));

  const captureChallengeImage = async (
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<Buffer | null> => {
    const adapter = matchingAdapters(contract).find((candidate) => candidate.captureChallengeImage);
    if (!adapter?.captureChallengeImage) {
      challengeCaptures.delete(session);
      return null;
    }
    const capture = await adapter.captureChallengeImage(session, contract);
    if (!capture) {
      challengeCaptures.delete(session);
      return null;
    }
    challengeCaptures.set(session, {
      stageId: contract.stageId,
      contractVersion: contract.version,
      capture,
    });
    return capture.image;
  };

  const isChallengeImageCurrent = async (
    session: string,
    contract: HumanAssistanceContract,
  ) => {
    const stored = challengeCaptures.get(session);
    if (!stored) return true;
    if (stored.stageId !== contract.stageId || stored.contractVersion !== contract.version) {
      return false;
    }
    const adapter = matchingAdapters(contract).find((candidate) => candidate.isChallengeImageCurrent);
    if (!adapter?.isChallengeImageCurrent) return false;
    return adapter.isChallengeImageCurrent(session, contract, stored.capture);
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
