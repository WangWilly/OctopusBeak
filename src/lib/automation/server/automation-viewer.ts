import type { Browser, ElementHandle, Frame, Page } from "playwright";
import type {
  HumanAssistanceContract,
  HumanAssistanceContractInput,
  HumanVerificationRect,
  HumanVerificationTarget,
  VerificationInteractionMode,
} from "../human-assistance.ts";
import { cdpEndpointForSession } from "./libretto-session.ts";

export type ViewerInput =
  | { type: "click"; x: number; y: number }
  | { type: "drag"; x: number; y: number; toX: number; toY: number }
  | { type: "type"; text: string }
  | { type: "press"; key: string };

export type ViewerPoint = { x: number; y: number };
export type InspectableTarget = {
  tagName: string;
  type: string;
  editable: boolean;
  disabled: boolean;
  readOnly: boolean;
};
export type ViewerInspectResult = {
  editable: boolean;
  rect: { x: number; y: number; width: number; height: number } | null;
  targetId?: string | null;
  contractVersion?: number;
  modes?: readonly VerificationInteractionMode[];
};
export type HumanAssistanceCompletionProbe = {
  checkboxChecked: boolean;
  challengeVisible: boolean;
  challengeSubmitVisible: boolean;
};
type InspectableRect = { x: number; y: number; width: number; height: number };
type InspectableTextTarget = InspectableTarget & { rect: InspectableRect };

const unsupportedInputError = "Unsupported viewer input.";
const allowedPressKeys = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);
const textInputTypes = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);

export function isClosedViewerSessionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No CDP endpoint available for Libretto session") ||
    /connect ECONNREFUSED 127\.0\.0\.1:\d+/.test(message);
}

function pixel(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(unsupportedInputError);
  const rounded = Math.round(value);
  if (rounded < 0) throw new Error(unsupportedInputError);
  return rounded;
}

export function normalizeViewerPoint(raw: unknown): ViewerPoint {
  if (!raw || typeof raw !== "object") throw new Error(unsupportedInputError);
  const point = raw as Record<string, unknown>;
  return { x: pixel(point.x), y: pixel(point.y) };
}

export function isInspectableTextTarget(target: InspectableTarget) {
  if (target.disabled || target.readOnly) return false;
  if (target.editable) return true;
  if (target.tagName === "TEXTAREA") return true;
  return target.tagName === "INPUT" && textInputTypes.has(target.type.toLowerCase());
}

export function selectInspectableTextTarget(
  targets: InspectableTextTarget[],
  point: ViewerPoint,
) {
  const textTargets = targets.filter(isInspectableTextTarget);
  const containing = textTargets.find((target) => (
    point.x >= target.rect.x &&
    point.x <= target.rect.x + target.rect.width &&
    point.y >= target.rect.y &&
    point.y <= target.rect.y + target.rect.height
  ));
  if (containing) return containing;
  return null;
}

export function viewerRectContainsPoint(rect: HumanVerificationRect, point: ViewerPoint) {
  return point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height;
}

export function focusPointForViewerRect(rect: HumanVerificationRect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export function humanVerificationTargetAtPoint(
  contract: HumanAssistanceContract,
  point: ViewerPoint,
) {
  return contract.targets.find((target) => target.rect && viewerRectContainsPoint(target.rect, point)) ?? null;
}

export function humanAssistanceCompletionSatisfied(
  semanticId: string,
  probe: HumanAssistanceCompletionProbe,
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

export function shouldAutoResumeYuantaTradeCaptcha(
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

export function shouldCheckYuantaTradeCompletion(
  inputType: unknown,
  semanticId: unknown,
) {
  if (inputType !== "click") return false;
  return semanticId === "yuanta-trade.login.captcha-checkbox"
    || semanticId === "yuanta-trade.login.challenge-submit";
}

export const YUANTA_TRADE_CAPTCHA_CHECKBOX_SELECTOR = "#chbYCaptchaV2";
export const YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR =
  "#modalYCaptchaV2, #captchaModal, .captcha-modal";
export const YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR =
  'button:has-text("驗證"), input[value*="驗"], [role="button"]:has-text("驗證"), a:has-text("驗證"), [aria-label*="驗"]';

export const VIEWER_SCREENSHOT_OPTIONS = {
  type: "jpeg",
  quality: 72,
  animations: "disabled",
  scale: "css",
} as const;

export function isNestedFrameElement(tagName: string) {
  return tagName === "IFRAME" || tagName === "FRAME";
}

function operationMode(input: ViewerInput): VerificationInteractionMode {
  return input.type;
}

function rawRecord(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new Error(unsupportedInputError);
  return raw as Record<string, unknown>;
}

export function normalizeHumanVerificationInput(
  raw: unknown,
  contract: HumanAssistanceContract,
) {
  const input = normalizeViewerInput(raw);
  const record = rawRecord(raw);
  if (record.contractVersion !== contract.version) {
    throw new Error("Human assistance contract is stale. Reload the current verification stage.");
  }
  if (typeof record.targetId !== "string") {
    throw new Error("Human verification target is required.");
  }
  const target = contract.targets.find((candidate) => candidate.id === record.targetId);
  if (!target) throw new Error("Human verification target is not declared for this stage.");
  if (!target.rect) throw new Error("Human verification target is not currently resolved.");
  const mode = operationMode(input);
  if (!target.modes.includes(mode)) {
    throw new Error(`Human verification mode is not allowed for target ${target.id}.`);
  }
  if (input.type === "click" && !viewerRectContainsPoint(target.rect, input)) {
    throw new Error("Viewer click is outside the declared human verification target.");
  }
  if (input.type === "drag" && !viewerRectContainsPoint(target.rect, input)) {
    throw new Error("Viewer drag must start inside the declared human verification target.");
  }
  return input;
}

export function normalizeViewerInput(raw: unknown): ViewerInput {
  if (!raw || typeof raw !== "object") throw new Error(unsupportedInputError);
  const input = raw as Record<string, unknown>;
  if (input.type === "click") return { type: "click", x: pixel(input.x), y: pixel(input.y) };
  if (input.type === "drag") {
    return {
      type: "drag",
      x: pixel(input.x),
      y: pixel(input.y),
      toX: pixel(input.toX),
      toY: pixel(input.toY),
    };
  }
  if (
    input.type === "type" &&
    typeof input.text === "string" &&
    input.text.length > 0 &&
    input.text.length <= 128
  ) {
    return { type: "type", text: input.text };
  }
  if (input.type === "press" && typeof input.key === "string" && allowedPressKeys.has(input.key)) {
    return { type: "press", key: input.key };
  }
  throw new Error(unsupportedInputError);
}

export function selectAllShortcut(platform = process.platform) {
  return platform === "darwin" ? "Meta+A" : "Control+A";
}

export function selectViewerPage<T extends { url(): string }>(pages: T[]) {
  const eligiblePages = pages.filter((candidate) => {
    const url = candidate.url();
    return url !== "about:blank" &&
      !url.startsWith("chrome://") &&
      !url.startsWith("devtools://") &&
      !url.startsWith("chrome-error://");
  });
  return eligiblePages[eligiblePages.length - 1] ?? null;
}

function visiblePage(browser: Browser, session: string) {
  const page = selectViewerPage(browser.contexts().flatMap((context) => context.pages()));
  if (!page) throw new Error(`No browser page available for Libretto session ${session}.`);
  return page;
}

async function withPausedPage<T>(session: string, action: (page: Page) => Promise<T>) {
  const endpoint = cdpEndpointForSession(session);
  if (!endpoint) {
    throw new Error(
      `No CDP endpoint available for Libretto session ${session}. Run npm run patch:libretto and restart the workflow.`,
    );
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    return await action(visiblePage(browser, session));
  } finally {
    await browser.close();
  }
}

export function captureSessionScreenshot(session: string) {
  return withPausedPage(session, (page) => (
    page.screenshot(VIEWER_SCREENSHOT_OPTIONS)
  ));
}

export async function inspectableFromElement(
  element: ElementHandle<HTMLElement>,
  offset: ViewerPoint = { x: 0, y: 0 },
): Promise<InspectableTextTarget | null> {
  try {
    const target = await element.evaluate((node) => {
      const style = getComputedStyle(node);
      const input = node instanceof HTMLInputElement ? node : null;
      const textarea = node instanceof HTMLTextAreaElement ? node : null;
      const rect = node.getBoundingClientRect();
      return {
        tagName: node.tagName,
        type: input?.type ?? "",
        editable: node.isContentEditable,
        disabled: Boolean(input?.disabled ?? textarea?.disabled),
        readOnly: Boolean(input?.readOnly ?? textarea?.readOnly),
        visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    });
    if (!target.visible || !target.rect.width || !target.rect.height) return null;
    return {
      tagName: target.tagName,
      type: target.type,
      editable: target.editable,
      disabled: target.disabled,
      readOnly: target.readOnly,
      rect: {
        x: target.rect.x + offset.x,
        y: target.rect.y + offset.y,
        width: target.rect.width,
        height: target.rect.height,
      },
    };
  } catch {
    return null;
  }
}

async function inspectFramePoint(
  frame: Frame,
  point: ViewerPoint,
  offset: ViewerPoint = { x: 0, y: 0 },
): Promise<InspectableTextTarget | null> {
  const handle = await frame.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), point);
  const element = handle.asElement() as ElementHandle<HTMLElement> | null;
  if (!element) {
    await handle.dispose();
    return null;
  }

  try {
    const embeddedFrame = await element.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { tagName: node.tagName, x: rect.x, y: rect.y };
    });
    const childFrame = isNestedFrameElement(embeddedFrame.tagName)
      ? await element.contentFrame()
      : null;
    if (isNestedFrameElement(embeddedFrame.tagName) && childFrame) {
      return inspectFramePoint(childFrame, {
        x: point.x - embeddedFrame.x,
        y: point.y - embeddedFrame.y,
      }, {
        x: offset.x + embeddedFrame.x,
        y: offset.y + embeddedFrame.y,
      });
    }

    return inspectableFromElement(element, offset);
  } finally {
    await handle.dispose();
  }
}

export async function inspectViewerPoint(session: string, rawPoint: unknown): Promise<ViewerInspectResult> {
  const point = normalizeViewerPoint(rawPoint);
  return withPausedPage(session, async (page) => {
    const target = await inspectFramePoint(page.mainFrame(), point);
    if (target && isInspectableTextTarget(target)) return { editable: true, rect: target.rect };
    return { editable: false, rect: target?.rect ?? null };
  });
}

export async function inspectHumanVerificationPoint(
  session: string,
  rawPoint: unknown,
  contract: HumanAssistanceContract,
): Promise<ViewerInspectResult> {
  const point = normalizeViewerPoint(rawPoint);
  const target = humanVerificationTargetAtPoint(contract, point);
  const inspected = await inspectViewerPoint(session, point);
  const liveHit = Boolean(inspected.rect && viewerRectContainsPoint(inspected.rect, point));
  const contractOnlyControl = Boolean(
    target
    && target.modes.length > 0
    && target.modes.every((mode) => mode === "click" || mode === "press"),
  );
  const resolvedTarget = target && (liveHit || contractOnlyControl) ? target : null;
  const modes = resolvedTarget?.modes ?? [];
  return {
    editable: Boolean(resolvedTarget && modes.includes("type") && inspected.editable),
    rect: resolvedTarget?.rect ?? null,
    targetId: resolvedTarget?.id ?? null,
    contractVersion: contract.version,
    modes,
  };
}

export async function inspectHumanAssistanceCompletion(
  session: string,
  contract: HumanAssistanceContract,
) {
  if (contract.completion.mode !== "independent") return false;
  return withPausedPage(session, async (page) => {
    const checkbox = page.locator(YUANTA_TRADE_CAPTCHA_CHECKBOX_SELECTOR).first();
    const challenge = page.locator(YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR).first();
    const checkboxChecked = await checkbox.evaluate((node) => {
      if (node instanceof HTMLInputElement) return node.checked;
      return node.getAttribute("aria-checked") === "true"
        || node.classList.contains("checked")
        || node.classList.contains("is-checked")
        || node.parentElement?.getAttribute("aria-checked") === "true";
    }).catch(() => false);
    const challengeVisible = await challenge
      .isVisible()
      .catch(() => false);
    const challengeSubmitVisible = await challenge.locator(YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR).first()
      .isVisible()
      .catch(() => false);
    const probe = { checkboxChecked, challengeVisible, challengeSubmitVisible };
    return contract.completion.targetIds.every((targetId) => {
      const target = contract.targets.find((candidate) => candidate.id === targetId);
      return target ? humanAssistanceCompletionSatisfied(target.semanticId, probe) : false;
    });
  });
}

export async function waitForHumanAssistanceCompletion(
  session: string,
  contract: HumanAssistanceContract,
  attempts = 12,
  intervalMs = 100,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await inspectHumanAssistanceCompletion(session, contract)) return true;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export async function refreshYuantaTradeChallengeSubmitTarget(
  session: string,
  contract: HumanAssistanceContract,
): Promise<HumanAssistanceContractInput | null> {
  const isChallengeStage = contract.targets.some(
    (target) => target.semanticId === "yuanta-trade.login.challenge-control",
  );
  const alreadyDeclared = contract.targets.some((target) => target.id === "challenge-submit");
  if (!isChallengeStage || alreadyDeclared) return null;

  const submitRect = await withPausedPage(session, async (page) => {
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
  };
}

export async function sendViewerInput(session: string, rawInput: unknown) {
  const input = normalizeViewerInput(rawInput);
  return sendNormalizedViewerInput(session, input);
}

export async function sendHumanVerificationInput(
  session: string,
  rawInput: unknown,
  contract: HumanAssistanceContract,
) {
  const input = normalizeHumanVerificationInput(rawInput, contract);
  const targetId = rawRecord(rawInput).targetId as string;
  const target = contract.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("Human verification target is not declared for this stage.");
  return sendNormalizedViewerInput(session, input, target);
}

async function focusHumanVerificationTarget(page: Page, target: HumanVerificationTarget) {
  if (!target.rect) throw new Error("Human verification target is not currently resolved.");
  const focused = await page.evaluate((point) => {
    const element = document.elementsFromPoint(point.x, point.y)
      .map((candidate) => candidate instanceof HTMLElement
        ? candidate.closest(
          'input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
        )
        : null)
      .find((candidate) => candidate instanceof HTMLElement);
    if (!(element instanceof HTMLElement)) return false;
    element.focus({ preventScroll: true });
    return document.activeElement === element;
  }, focusPointForViewerRect(target.rect));
  if (!focused) {
    throw new Error("Human verification target could not be focused. Reload the current verification stage.");
  }
}

async function sendNormalizedViewerInput(
  session: string,
  input: ViewerInput,
  target?: HumanVerificationTarget,
) {
  await withPausedPage(session, async (page) => {
    if (input.type === "click") {
      await page.mouse.click(input.x, input.y);
    } else if (input.type === "drag") {
      await page.mouse.move(input.x, input.y);
      await page.mouse.down();
      await page.mouse.move(input.toX, input.toY);
      await page.mouse.up();
    } else if (input.type === "type") {
      if (target) await focusHumanVerificationTarget(page, target);
      await page.keyboard.press(selectAllShortcut());
      await page.keyboard.type(input.text);
    } else {
      if (target) await focusHumanVerificationTarget(page, target);
      await page.keyboard.press(input.key);
    }
  });
}
