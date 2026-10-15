import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext, Request } from "playwright";
import { PNG } from "pngjs";
import type { WorkflowBrowserPort } from "../../src/lib/automation/workflow-executor.ts";
import { PreviewSourceFailure } from "../../src/lib/preview-sources/source-kit.ts";
import { deniedBy, type CalibrationBankSpec, type DenyRule, type ObservedRequest } from "./banks.ts";
import { appendCapture } from "./corpus.ts";

export const MAX_CONSECUTIVE_FAILURES = 3;

export type DeniedRequest = Readonly<{ rule: string; method: string; path: string }>;

export class DeniedRequestError extends Error {
  readonly denied: DeniedRequest;

  constructor(denied: DeniedRequest) {
    super(`Calibration stopped: the capture sent a denied request (${denied.rule}: ${denied.method} ${denied.path}).`);
    this.name = "DeniedRequestError";
    this.denied = denied;
  }
}

export type CollectOptions = Readonly<{
  bank: CalibrationBankSpec;
  count: number;
  delayMs: number;
  corpusDirectory: string;
  browser: WorkflowBrowserPort;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => string;
  log?: (line: string) => void;
}>;

export type CollectResult = Readonly<{ captured: number; failed: number }>;

function observe(request: Request): ObservedRequest {
  return { method: request.method(), url: request.url(), body: request.postData() };
}

/**
 * The route aborts a denied request; the request listener also sees requests
 * a route cannot intercept (such as one already paused by another CDP client),
 * so a denial is recorded even when the abort did not happen.
 */
async function guardContext(context: BrowserContext, rules: readonly DenyRule[], record: (denied: DeniedRequest) => void) {
  const check = (request: ObservedRequest) => {
    const rule = deniedBy(rules, request);
    if (rule) record({ rule: rule.name, method: request.method, path: new URL(request.url).pathname });
    return rule;
  };
  context.on("request", (request) => { check(observe(request)); });
  await context.route("**/*", async (route) => {
    if (check(observe(route.request()))) await route.abort("blockedbyclient");
    else await route.fallback();
  });
}

export function guardedBrowser(browser: WorkflowBrowserPort, rules: readonly DenyRule[], record: (denied: DeniedRequest) => void): WorkflowBrowserPort {
  const guarded = new WeakSet<BrowserContext>();
  return {
    withPage: (run) => browser.withPage(async (page) => {
      const context = page.context();
      if (!guarded.has(context)) {
        guarded.add(context);
        await guardContext(context, rules, record);
      }
      return run(page);
    }),
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 2).toString("latin1") === "BM") return "image/bmp";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

async function decodeToPng(browser: WorkflowBrowserPort, bytes: Buffer, mediaType: string): Promise<Buffer> {
  const dataUrl = await browser.withPage((page) => page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png");
  }, `data:${mediaType};base64,${bytes.toString("base64")}`));
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

export async function normalizeToPng(browser: WorkflowBrowserPort, bytes: Buffer) {
  const sourceMediaType = sniffImageType(bytes);
  if (!sourceMediaType) throw new Error("The CAPTCHA image is not a PNG, JPEG, GIF, BMP, or WebP image.");
  const png = sourceMediaType === "image/png" ? bytes : await decodeToPng(browser, bytes, sourceMediaType);
  const { width, height } = PNG.sync.read(png);
  return { png, sourceMediaType, width, height };
}

function failureClass(error: unknown): string {
  if (error instanceof PreviewSourceFailure) return `${error.name}(${error.reason})`;
  return error instanceof Error ? error.name : typeof error;
}

export async function collectCorpus(options: CollectOptions): Promise<CollectResult> {
  const { bank, count, signal } = options;
  const sleep = options.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort }));
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? (() => {});
  const denials: DeniedRequest[] = [];
  const browser = guardedBrowser(options.browser, bank.denyRules, (request) => { denials.push(request); });
  let captured = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  for (let index = 0; index < count; index += 1) {
    if (index > 0) await sleep(options.delayMs, signal);
    signal.throwIfAborted();
    let failure: unknown = null;
    try {
      const challenge = await bank.capture(browser, signal);
      if (denials[0]) throw new DeniedRequestError(denials[0]);
      const { png, sourceMediaType, width, height } = await normalizeToPng(browser, challenge.image);
      const id = randomUUID();
      await appendCapture(options.corpusDirectory, {
        id,
        capturedAt: now(),
        width,
        height,
        sourceMediaType,
        method: bank.method,
        ...(challenge.declaredLength === undefined ? {} : { declaredLength: challenge.declaredLength }),
      }, png);
      captured += 1;
      consecutiveFailures = 0;
      log(`capture ${index + 1}/${count} ${id} ${sourceMediaType} ${width}x${height}`);
    } catch (error) {
      if (signal.aborted) throw error;
      failure = error;
    }
    if (denials[0]) throw new DeniedRequestError(denials[0]);
    if (failure === null) continue;
    failed += 1;
    consecutiveFailures += 1;
    log(`capture ${index + 1}/${count} failed: ${failureClass(failure)}`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(`stopping after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
      break;
    }
  }
  return { captured, failed };
}
