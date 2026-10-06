import type { HumanAssistanceContract } from "../human-assistance.ts";
import {
  SINOPAC_CAPTCHA_IMAGE_SELECTOR,
  SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID,
  SINOPAC_CAPTCHA_INPUT_SELECTOR,
  SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID,
  SINOPAC_CAPTCHA_NATURAL_HEIGHT,
  SINOPAC_CAPTCHA_NATURAL_WIDTH,
  SINOPAC_DIALOG_DISMISS_TIMEOUT_MS,
  isSinopacCaptchaRejectionDialog,
} from "../sinopac-captcha.ts";
import { YUANTA_DIALOG_DISMISS_TIMEOUT_MS } from "../yuanta-captcha.ts";
import { POST_CAPTCHA_INPUT_SELECTOR, POST_CAPTCHA_INPUT_SEMANTIC_ID } from "../post-captcha.ts";
import {
  YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR,
  YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR,
} from "../yuanta-trade-captcha.ts";
import {
  sendHumanVerificationInput,
  withViewerPage,
  type ViewerDialogAccess,
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
const YUANTA_TRADE_AUDIO_SEMANTIC_ID = "yuanta-trade.login.audio-challenge";
const YUANTA_TRADE_AUDIO_PATH = "/NexusWebTrade/Login/VerificationCodeSound";
export const YUANTA_BANK_CAPTCHA_IMAGE_SELECTOR = 'img[src*="GOTP"]:visible';
export const FUBON_CAPTCHA_IMAGE_SELECTOR = 'img[src*="captchaImage"]:visible';
const FUBON_CAPTCHA_INPUT_SEMANTIC_ID = "fubon.login.captcha-input";
const FUBON_CAPTCHA_IMAGE_SEMANTIC_ID = "fubon.login.captcha-image";
const FUBON_CAPTCHA_FRAME_NAME = "txnFrame";
const FUBON_CAPTCHA_REJECTION_TEXT = /^0290\s*驗證碼輸入錯誤$/u;
const FUBON_POST_SUBMIT_OBSERVE_TIMEOUT_MS = 12_000;
const FUBON_POST_SUBMIT_POLL_MS = 75;
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
  inspectCompletion(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<boolean>;
  handleInput?: ViewerTargetInputHandler;
  probePostSubmit?: ProviderVerificationPostSubmitProbe;
};

export type ProviderVerificationPostSubmitOutcome =
  | "none"
  | "provider-rejected"
  | "unrecognized-dialog";

export type ProviderVerificationPostSubmitProbe = (
  session: string,
  contract: HumanAssistanceContract,
  resume: () => Promise<void>,
  cleanupSession?: () => Promise<void>,
) => Promise<ProviderVerificationPostSubmitOutcome>;

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
  probePostSubmit(
    session: string,
    contract: HumanAssistanceContract,
    resume: () => Promise<void>,
    cleanupSession?: () => Promise<void>,
  ): Promise<ProviderVerificationPostSubmitOutcome>;
  inspectCompletion(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<boolean>;
};

export type ProviderVerificationDependencies = {
  withPage?: ProviderVerificationPageRunner;
  sendInput?: ProviderVerificationInputForwarder;
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

function normalizeProviderDialogText(message: string) {
  return message
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/\s+/g, "");
}

/**
 * Only the evidence-backed CAPTCHA rejection wording for a provider may
 * advance the retry campaign. Other dialogs remain fail-closed and never
 * become retry signals.
 */
function classifyProviderPostSubmitDialog(
  dialog: ViewerDialogAccess,
  evidenceBackedMessage: string,
): ProviderVerificationPostSubmitOutcome {
  let type = "unknown";
  try {
    type = dialog.type();
  } catch {
    return "unrecognized-dialog";
  }
  if (type !== "alert") return "unrecognized-dialog";

  let message = "";
  try {
    message = normalizeProviderDialogText(dialog.message());
  } catch {
    return "unrecognized-dialog";
  }
  return message === normalizeProviderDialogText(evidenceBackedMessage)
    ? "provider-rejected"
    : "unrecognized-dialog";
}

function classifySinopacPostSubmitDialog(
  dialog: ViewerDialogAccess,
): ProviderVerificationPostSubmitOutcome {
  try {
    return isSinopacCaptchaRejectionDialog(dialog.type(), dialog.message())
      ? "provider-rejected"
      : "unrecognized-dialog";
  } catch {
    return "unrecognized-dialog";
  }
}

function classifyYuantaPostSubmitDialog(
  dialog: ViewerDialogAccess,
): ProviderVerificationPostSubmitOutcome {
  return classifyProviderPostSubmitDialog(
    dialog,
    "驗證碼不正確，請重新輸入",
  );
}

const PROVIDER_DIALOG_CLEANUP_TIMEOUT_MS = 5_000;
const PROVIDER_RESUME_JOIN_TIMEOUT_MS = 5_000;

async function settleProviderPromise<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then(
      (value) => ({ timedOut: false as const, value }),
      (error) => ({ timedOut: false as const, error }),
    ),
    new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

async function dismissProviderDialog(
  dialog: ViewerDialogAccess,
  timeoutMs: number,
) {
  const dismissal = Promise.resolve().then(() => dialog.dismiss());
  // A native dialog implementation can reject or remain pending.  Observe
  // the underlying promise even when the bounded wait expires so it cannot
  // become an unhandled rejection later.
  void dismissal.catch(() => undefined);
  const result = await settleProviderPromise(
    dismissal,
    timeoutMs,
  );
  return !result.timedOut && !("error" in result);
}

function createProviderPostSubmitProbe(
  withPage: ProviderVerificationPageRunner,
  classifyDialog: (dialog: ViewerDialogAccess) => ProviderVerificationPostSubmitOutcome,
  dismissTimeoutMs: number,
): ProviderVerificationPostSubmitProbe {
  return async (session, _contract, resume, cleanupSession) => withPage(session, async (page) => {
    // Without both the dialog observer and exact-session cleanup capability,
    // starting resume could leave a workflow blocked in its long navigation
    // wait with nobody able to classify or terminate it.
    if (!page.onDialog || !page.offDialog || !cleanupSession) {
      return "unrecognized-dialog";
    }

    let dialogStarted = false;
    let resolveDialog!: (dialog: {
      outcome: ProviderVerificationPostSubmitOutcome;
      settled: Promise<ProviderVerificationPostSubmitOutcome>;
    }) => void;
    const dialogObserved = new Promise<{
      outcome: ProviderVerificationPostSubmitOutcome;
      settled: Promise<ProviderVerificationPostSubmitOutcome>;
    }>(
      (resolve) => {
        resolveDialog = resolve;
      },
    );
    const dialogHandler = (dialog: ViewerDialogAccess) => {
      if (dialogStarted) return;
      dialogStarted = true;
      // The provider adapter is the sole owner of post-submit dialogs when a
      // host capability is present.  The dismissal is awaited (with a short
      // bound) before the outcome is visible to the retry coordinator.
      void (async () => {
        let classified: ProviderVerificationPostSubmitOutcome;
        try {
          classified = classifyDialog(dialog);
        } catch {
          classified = "unrecognized-dialog";
        }
        const settled = dismissProviderDialog(dialog, dismissTimeoutMs).then(
          (dismissed) => dismissed ? classified : "unrecognized-dialog",
          () => "unrecognized-dialog" as const,
        );
        resolveDialog({ outcome: classified, settled });
      })();
    };
    page.onDialog(dialogHandler);
    try {
      const resumePromise = Promise.resolve().then(resume);
      const resumed = resumePromise.then(
        () => ({ kind: "completed" as const }),
        (error) => ({ kind: "failed" as const, error }),
      );
      const result = await Promise.race([
        dialogObserved.then((outcome) => ({ kind: "dialog" as const, outcome })),
        resumed,
      ]);
      if (result.kind === "dialog") {
        const dialogOutcome = await result.outcome.settled;
        // A host-owned dialog is retryable only after the resumed execution
        // has been explicitly cleaned up and its process promise has settled.
        // Without the capability callback there is no safe way to prevent a
        // late resume from mutating the shared task-run owner, so fail closed.
        const cleanupResult = await settleProviderPromise(
          Promise.resolve().then(() => cleanupSession()),
          PROVIDER_DIALOG_CLEANUP_TIMEOUT_MS,
        );
        const resumeResult = await settleProviderPromise(
          resumed,
          PROVIDER_RESUME_JOIN_TIMEOUT_MS,
        );
        if (
          cleanupResult.timedOut ||
          ("error" in cleanupResult) ||
          resumeResult.timedOut
        ) {
          return "unrecognized-dialog";
        }
        return dialogOutcome;
      }
      if (result.kind === "failed") throw result.error;
      // A clean resume without a dialog is the ordinary success path. Any
      // resume failure remains fail-closed and is propagated above.
      return "none";
    } finally {
      page.offDialog(dialogHandler);
    }
  });
}

function createFubonPostSubmitProbe(
  withPage: ProviderVerificationPageRunner,
): ProviderVerificationPostSubmitProbe {
  return async (session, _contract, resume, cleanupSession) => withPage(session, async (page) => {
    // A missing observer or exact-session cleanup cannot safely start a
    // retryable post-submit execution.
    if (!page.frame || !cleanupSession) return "unrecognized-dialog";
    const frame = page.frame(FUBON_CAPTCHA_FRAME_NAME);
    if (!frame) return "unrecognized-dialog";
    const rejection = frame.getByText(FUBON_CAPTCHA_REJECTION_TEXT).first();
    // Only a newly appearing response can prove this submission was rejected.
    let alreadyVisible: boolean;
    try {
      alreadyVisible = await rejection.isVisible();
    } catch {
      return "unrecognized-dialog";
    }
    if (alreadyVisible) return "unrecognized-dialog";

    let observing = true;
    const observed = (async () => {
      const deadline = Date.now() + FUBON_POST_SUBMIT_OBSERVE_TIMEOUT_MS;
      while (observing && Date.now() < deadline) {
        try {
          // Resolve the frame again on every poll: the bank can replace the
          // login iframe while rendering the response.
          const currentFrame = page.frame?.(FUBON_CAPTCHA_FRAME_NAME);
          if (
            currentFrame &&
            await currentFrame.getByText(FUBON_CAPTCHA_REJECTION_TEXT).first().isVisible()
          ) return true;
        } catch {
          // A detached frame is transient; only a visible exact 0290 proves
          // the rejection.
        }
        await new Promise((resolve) => setTimeout(resolve, FUBON_POST_SUBMIT_POLL_MS));
      }
      return false;
    })();
    const resumed = Promise.resolve().then(resume).then(
      () => ({ kind: "completed" as const }),
      (error) => ({ kind: "failed" as const, error }),
    );
    try {
      const first = await Promise.race([
        observed.then((seen) => ({ kind: "observed" as const, seen })),
        resumed,
      ]);
      let providerRejected = first.kind === "observed" && first.seen;
      if (first.kind === "failed" && !providerRejected) {
        // The workflow can reject the login form immediately after the bank
        // renders 0290. Give the already-armed observer a bounded chance to
        // settle before the failure propagates.
        const lateObservation = await settleProviderPromise(observed, 500);
        providerRejected = !lateObservation.timedOut
          && !("error" in lateObservation)
          && lateObservation.value;
      }
      if (providerRejected) {
        const cleanupResult = await settleProviderPromise(
          Promise.resolve().then(cleanupSession),
          PROVIDER_DIALOG_CLEANUP_TIMEOUT_MS,
        );
        const resumeResult = await settleProviderPromise(
          resumed,
          PROVIDER_RESUME_JOIN_TIMEOUT_MS,
        );
        if (
          cleanupResult.timedOut ||
          ("error" in cleanupResult) ||
          resumeResult.timedOut
        ) return "unrecognized-dialog";
        return "provider-rejected";
      }
      if (first.kind === "failed") throw first.error;
      const finalResume = await resumed;
      if (finalResume.kind === "failed") throw finalResume.error;
      return "none";
    } finally {
      observing = false;
    }
  });
}

function createSinopacPostSubmitProbe(
  withPage: ProviderVerificationPageRunner,
): ProviderVerificationPostSubmitProbe {
  return createProviderPostSubmitProbe(
    withPage,
    classifySinopacPostSubmitDialog,
    SINOPAC_DIALOG_DISMISS_TIMEOUT_MS,
  );
}

function createYuantaPostSubmitProbe(
  withPage: ProviderVerificationPageRunner,
): ProviderVerificationPostSubmitProbe {
  const probe = createProviderPostSubmitProbe(
    withPage,
    classifyYuantaPostSubmitDialog,
    YUANTA_DIALOG_DISMISS_TIMEOUT_MS,
  );
  return async (session, contract, resume, cleanupSession) => {
    // The Yuanta adapter also owns the trade checkbox/image-selection stages.
    // Only the bank's six-digit login CAPTCHA has evidence-backed rejection
    // wording; trade stages keep their existing workflow behavior.
    if (!yuantaBankCaptchaContract(contract)) {
      await resume();
      return "none";
    }
    return probe(session, contract, resume, cleanupSession);
  };
}

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
      id: "post",
      owns: contract => contract.stageId === "ipost-login-captcha"
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
      probePostSubmit: createFubonPostSubmitProbe(withPage),
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
      probePostSubmit: createSinopacPostSubmitProbe(withPage),
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
      probePostSubmit: createYuantaPostSubmitProbe(withPage),
    },
  ];
}

export function createProviderVerificationHost(
  dependencies: ProviderVerificationDependencies = {},
): ProviderVerificationHost {
  const withPage = dependencies.withPage ?? withViewerPage;
  const forwardInput = dependencies.sendInput ?? sendHumanVerificationInput;
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

  const probePostSubmit = async (
    session: string,
    contract: HumanAssistanceContract,
    resume: () => Promise<void>,
    cleanupSession?: () => Promise<void>,
  ): Promise<ProviderVerificationPostSubmitOutcome> => {
    const adapter = matchingAdapters(contract).find(
      (candidate) => candidate.probePostSubmit,
    );
    if (!adapter?.probePostSubmit) {
      await resume();
      return "none";
    }
    return adapter.probePostSubmit(session, contract, resume, cleanupSession);
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
    handlesChallengeAudio,
    captureChallengeAudio,
    sendInput,
    injectAnswer,
    probePostSubmit,
    inspectCompletion,
  };
}

const defaultHost = createProviderVerificationHost();

export const captureProviderVerificationImage = defaultHost.captureChallengeImage;
export const isProviderVerificationImageCurrent = defaultHost.isChallengeImageCurrent;
export const providerVerificationHandlesChallengeImage = defaultHost.handlesChallengeImage;
export const captureProviderVerificationAudio = defaultHost.captureChallengeAudio;
export const injectProviderVerificationAnswer = defaultHost.injectAnswer;
export const probeProviderVerificationPostSubmit = defaultHost.probePostSubmit;
