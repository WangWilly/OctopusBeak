import type { Browser, ElementHandle, Frame, Page } from "playwright";
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

  let nearest: { target: InspectableTextTarget; distance: number } | null = null;
  for (const target of textTargets) {
    const dx = point.x < target.rect.x
      ? target.rect.x - point.x
      : Math.max(0, point.x - (target.rect.x + target.rect.width));
    const dy = point.y < target.rect.y
      ? target.rect.y - point.y
      : Math.max(0, point.y - (target.rect.y + target.rect.height));
    if (dx > 220 || dy > 24) continue;
    const distance = Math.hypot(dx, dy);
    if (!nearest || distance < nearest.distance) nearest = { target, distance };
  }
  return nearest?.target ?? null;
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
    page.screenshot({ type: "jpeg", quality: 72, animations: "disabled" })
  ));
}

async function inspectableFromElement(element: ElementHandle<HTMLElement>): Promise<InspectableTextTarget | null> {
  try {
    const box = await element.boundingBox();
    if (!box?.width || !box.height) return null;
    const target = await element.evaluate((node) => {
      const style = getComputedStyle(node);
      const input = node instanceof HTMLInputElement ? node : null;
      const textarea = node instanceof HTMLTextAreaElement ? node : null;
      return {
        tagName: node.tagName,
        type: input?.type ?? "",
        editable: node.isContentEditable,
        disabled: Boolean(input?.disabled ?? textarea?.disabled),
        readOnly: Boolean(input?.readOnly ?? textarea?.readOnly),
        visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0,
      };
    });
    if (!target.visible) return null;
    return {
      tagName: target.tagName,
      type: target.type,
      editable: target.editable,
      disabled: target.disabled,
      readOnly: target.readOnly,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  } catch {
    return null;
  }
}

async function frameTextTargets(frame: Frame): Promise<InspectableTextTarget[]> {
  let handles: ElementHandle<HTMLElement>[];
  try {
    handles = await frame.$$("input, textarea, [contenteditable='true'], [contenteditable='']") as ElementHandle<HTMLElement>[];
  } catch {
    return [];
  }
  const targets: InspectableTextTarget[] = [];
  for (const handle of handles) {
    try {
      const target = await inspectableFromElement(handle);
      if (target) targets.push(target);
    } finally {
      await handle.dispose();
    }
  }
  return targets;
}

async function pageTextTargets(page: Page): Promise<InspectableTextTarget[]> {
  const targets = await Promise.all(page.frames().map(async (frame) => {
    try {
      return await frameTextTargets(frame);
    } catch {
      return [];
    }
  }));
  return targets.flat();
}

async function inspectFramePoint(frame: Frame, point: ViewerPoint): Promise<InspectableTextTarget | null> {
  const handle = await frame.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), point);
  const element = handle.asElement() as ElementHandle<HTMLElement> | null;
  if (!element) {
    await handle.dispose();
    return null;
  }

  try {
    const iframe = await element.evaluate((node) => {
      if (node.tagName !== "IFRAME") return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    });
    const childFrame = iframe ? await element.contentFrame() : null;
    if (iframe && childFrame) {
      return inspectFramePoint(childFrame, { x: point.x - iframe.x, y: point.y - iframe.y });
    }

    return inspectableFromElement(element);
  } finally {
    await handle.dispose();
  }
}

export async function inspectViewerPoint(session: string, rawPoint: unknown): Promise<ViewerInspectResult> {
  const point = normalizeViewerPoint(rawPoint);
  return withPausedPage(session, async (page) => {
    const target = await inspectFramePoint(page.mainFrame(), point);
    if (target && isInspectableTextTarget(target)) return { editable: true, rect: target.rect };
    const fallback = selectInspectableTextTarget(await pageTextTargets(page), point);
    return fallback ? { editable: true, rect: fallback.rect } : { editable: false, rect: target?.rect ?? null };
  });
}

export async function sendViewerInput(session: string, rawInput: unknown) {
  const input = normalizeViewerInput(rawInput);
  await withPausedPage(session, async (page) => {
    if (input.type === "click") {
      await page.mouse.click(input.x, input.y);
    } else if (input.type === "drag") {
      await page.mouse.move(input.x, input.y);
      await page.mouse.down();
      await page.mouse.move(input.toX, input.toY);
      await page.mouse.up();
    } else if (input.type === "type") {
      await page.keyboard.press(selectAllShortcut());
      await page.keyboard.type(input.text);
    } else {
      await page.keyboard.press(input.key);
    }
  });
}
