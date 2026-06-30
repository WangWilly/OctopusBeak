import type { Browser, Page } from "playwright";
import { cdpEndpointForSession } from "./libretto-session.ts";

export type ViewerInput =
  | { type: "click"; x: number; y: number }
  | { type: "drag"; x: number; y: number; toX: number; toY: number }
  | { type: "type"; text: string }
  | { type: "press"; key: string };

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

function pixel(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(unsupportedInputError);
  const rounded = Math.round(value);
  if (rounded < 0) throw new Error(unsupportedInputError);
  return rounded;
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
    (browser as unknown as { _connection?: { close(): void } })._connection?.close();
  }
}

export function captureSessionScreenshot(session: string) {
  return withPausedPage(session, (page) => (
    page.screenshot({ type: "jpeg", quality: 72, animations: "disabled" })
  ));
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
      await page.keyboard.type(input.text);
    } else {
      await page.keyboard.press(input.key);
    }
  });
}
