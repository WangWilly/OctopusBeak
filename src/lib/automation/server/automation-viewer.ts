import type { Dialog, ElementHandle, Frame, Locator, Page } from "playwright";
import type {
  HumanAssistanceContract,
  HumanVerificationRect,
  HumanVerificationTarget,
  VerificationInteractionMode,
} from "../human-assistance.ts";
import type { VerificationSelectionPoint } from "./verification-solver.ts";
import { appWorkflowPageForSession } from "./app-browser-host.ts";

export type ViewerInput =
  | { type: "click"; x: number; y: number }
  | { type: "drag"; x: number; y: number; toX: number; toY: number }
  | { type: "type"; text: string }
  | { type: "press"; key: string };

/** Provider-owned post-submit probes may classify and dismiss one dialog. */
export type ViewerDialogAccess = Pick<Dialog, "type" | "message" | "dismiss">;

/** The smallest browser seam provider adapters need: selector-backed access. */
export type ViewerPageAccess = {
  locator(selector: string): Locator;
  /** The live top-level frame used by provider adapters that need DOM pixels. */
  mainFrame?: () => Frame;
  /** Resolve a named provider frame without exposing the Playwright Page. */
  frame?: (name: string) => Frame | null;
  /** The current page URL, used to bind provider-owned captures to navigation. */
  url?: () => string;
  /** Run code in the page context (same-origin fetch, session cookies). */
  evaluate?: <T>(pageFunction: (arg: string) => T | Promise<T>, arg: string) => Promise<T>;
  /** Capture a page-relative region without exposing the Playwright Page. */
  screenshot(options: { clip: HumanVerificationRect; type: "png" }): Promise<Buffer>;
  /** Attach a short-lived provider-owned observer to native browser dialogs. */
  onDialog?: (handler: (dialog: ViewerDialogAccess) => void) => void;
  offDialog?: (handler: (dialog: ViewerDialogAccess) => void) => void;
};

/**
 * A provider adapter may take over an operation whose target needs a
 * provider-specific DOM interaction. Returning true means that the adapter
 * performed the operation; returning false lets the generic viewer use its
 * coordinate/keyboard mechanics.
 */
export type ViewerTargetInputHandler = (
  page: ViewerPageAccess,
  input: ViewerInput,
  target: HumanVerificationTarget,
) => Promise<boolean>;

export type ViewerPoint = { x: number; y: number };
export type ViewerScreenshotErrorKind = "unavailable" | "transient" | "failed";

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
const editableTargetSelector = [
  "input:not([disabled]):not([readonly])",
  "textarea:not([disabled]):not([readonly])",
  '[contenteditable="true"]',
].join(", ");

export function viewerScreenshotErrorKind(error: unknown): ViewerScreenshotErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No active App browser page is available for this workflow run.")
    || /connect ECONNREFUSED 127\.0\.0\.1:\d+/.test(message)) {
    return "unavailable";
  }
  if (/ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|Target (?:page|context|browser) .*closed|browser has been closed/i.test(message)) {
    return "transient";
  }
  return "failed";
}

function pixel(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(unsupportedInputError);
  const rounded = Math.round(value);
  if (rounded < 0) throw new Error(unsupportedInputError);
  return rounded;
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

async function withPausedPage<T>(session: string, action: (page: Page) => Promise<T>) {
  const page = appWorkflowPageForSession(session);
  if (!page) throw new Error("No active App browser page is available for this workflow run.");
  return action(page);
}

export function withViewerPage<T>(
  session: string,
  action: (page: ViewerPageAccess) => Promise<T>,
) {
  return withPausedPage(session, (page) => action({
    locator: page.locator.bind(page),
    mainFrame: () => page.mainFrame(),
    frame: (name) => page.frame({ name }),
    url: () => page.url(),
    evaluate: (pageFunction, arg) => page.evaluate(pageFunction, arg),
    screenshot: (options) => page.screenshot(options),
    onDialog: (handler) => page.on("dialog", handler as (dialog: Dialog) => void),
    offDialog: (handler) => page.off("dialog", handler as (dialog: Dialog) => void),
  }));
}

export async function sendHumanVerificationInput(
  session: string,
  rawInput: unknown,
  contract: HumanAssistanceContract,
  targetInputHandler?: ViewerTargetInputHandler,
) {
  const input = normalizeHumanVerificationInput(rawInput, contract);
  const targetId = rawRecord(rawInput).targetId as string;
  const target = contract.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("Human verification target is not declared for this stage.");
  return sendNormalizedViewerInput(session, input, target, targetInputHandler);
}

export async function focusHumanVerificationTarget(page: Page, target: HumanVerificationTarget) {
  if (!target.rect) throw new Error("Human verification target is not currently resolved.");
  const point = focusPointForViewerRect(target.rect);
  const focused = await page.evaluate((focusPoint) => {
    const element = document.elementsFromPoint(focusPoint.x, focusPoint.y)
      .map((candidate) => candidate instanceof HTMLElement
        ? candidate.closest(
          'input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
        )
        : null)
      .find((candidate) => candidate instanceof HTMLElement);
    if (!(element instanceof HTMLElement)) return false;
    element.focus({ preventScroll: true });
    return document.activeElement === element;
  }, point);
  if (focused) return;
  if (!target.modes.includes("click")) {
    throw new Error("Human verification target does not permit pointer focus.");
  }
  await page.mouse.click(point.x, point.y);
}

async function editableElementAtViewerPoint(
  frame: Frame,
  point: ViewerPoint,
): Promise<ElementHandle<HTMLElement> | null> {
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
      return editableElementAtViewerPoint(childFrame, {
        x: point.x - embeddedFrame.x,
        y: point.y - embeddedFrame.y,
      });
    }

    const editableHandle = await frame.evaluateHandle(({ x, y, selector }) => (
      document.elementsFromPoint(x, y)
        .map((node) => node instanceof HTMLElement ? node.closest(selector) : null)
        .find((node): node is HTMLElement => node instanceof HTMLElement) ?? null
    ), { ...point, selector: editableTargetSelector });
    const editable = editableHandle.asElement() as ElementHandle<HTMLElement> | null;
    if (!editable) await editableHandle.dispose();
    return editable;
  } finally {
    await handle.dispose();
  }
}

async function fillHumanVerificationTarget(
  page: Page,
  target: HumanVerificationTarget,
  text: string,
): Promise<boolean> {
  if (!target.rect) throw new Error("Human verification target is not currently resolved.");
  const element = await editableElementAtViewerPoint(page.mainFrame(), focusPointForViewerRect(target.rect));
  if (!element) return false;
  try {
    await element.fill(text);
    return true;
  } finally {
    await element.dispose();
  }
}

async function sendNormalizedViewerInput(
  session: string,
  input: ViewerInput,
  target: HumanVerificationTarget,
  targetInputHandler?: ViewerTargetInputHandler,
) {
  await withPausedPage(session, async (page) => {
    if (input.type === "click") {
      if (targetInputHandler && await targetInputHandler(page, input, target)) return;
      await page.mouse.click(input.x, input.y);
    } else if (input.type === "drag") {
      await page.mouse.move(input.x, input.y);
      await page.mouse.down();
      await page.mouse.move(input.toX, input.toY);
      await page.mouse.up();
    } else if (input.type === "type") {
      if (targetInputHandler && await targetInputHandler(page, input, target)) return;
      if (!await fillHumanVerificationTarget(page, target, input.text)) {
        throw new Error("Human verification target moved. Reload the current verification stage.");
      }
    } else {
      await focusHumanVerificationTarget(page, target);
      await page.keyboard.press(input.key);
    }
  });
}

export async function captureChallengeImageForContract(
  session: string,
  contract: HumanAssistanceContract,
): Promise<Buffer | null> {
  const rect = contract.challengeImageRegion?.rect;
  if (!rect) return null;
  try {
    return await withPausedPage(session, (page) =>
      page.screenshot({
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        type: "png",
      }),
    );
  } catch (error) {
    if (viewerScreenshotErrorKind(error) === "unavailable") throw error;
    return null;
  }
}

export async function clickVerificationTarget(
  session: string,
  contract: HumanAssistanceContract,
  targetId: string,
) {
  const target = contract.targets.find((candidate) => candidate.id === targetId);
  if (!target?.rect) {
    throw new Error("Verification target is not resolved for the solver click.");
  }
  const point = focusPointForViewerRect(target.rect);
  await sendNormalizedViewerInput(session, { type: "click", x: point.x, y: point.y }, target);
}

export async function clickVerificationSelectionsOnPage(
  page: Page,
  rect: HumanVerificationRect,
  selections: readonly VerificationSelectionPoint[],
) {
  for (const selection of selections) {
    await page.mouse.click(
      Math.round(rect.x + selection.x),
      Math.round(rect.y + selection.y),
    );
  }
}

export async function injectVerificationSelections(
  session: string,
  contract: HumanAssistanceContract,
  selections: readonly VerificationSelectionPoint[],
) {
  const rect = contract.challengeImageRegion?.rect;
  if (!rect) {
    throw new Error("Verification contract declares no challenge image region for the solver selections.");
  }
  await withPausedPage(session, (page) =>
    clickVerificationSelectionsOnPage(page, rect, selections),
  );
}
