import { CaptchaProviderRejectedError } from "../lib/automation/captcha-rejection.ts";
import type { Frame, Locator, Page } from "playwright";
import { errorCodeFromDialog, sanitizedDialogAlert } from "../lib/automation/fubon-dialog.ts";
import type { DialogSnapshot, PageMatch } from "../lib/automation/sign-in-prompt.ts";
import { activateControlWithoutPointer } from "./browser-interaction.ts";
import type { VerificationStage } from "../lib/automation/verification-stage.ts";
import { withAbort } from "./abort.ts";
import type { FrameScope } from "./frame-scope.ts";
import { locatePageMatch, type DialogDecision } from "./sign-in.ts";
import { FUBON_SOURCE } from "../lib/automation/server/sources/fubon.ts";
import {
  FUBON_CAPTCHA_IMAGE_SELECTOR,
  FUBON_CAPTCHA_IMAGE_SEMANTIC_ID,
  FUBON_CAPTCHA_INPUT_SEMANTIC_ID,
  FUBON_LOGIN_FRAME_NAME,
} from "../lib/automation/fubon-captcha.ts";

const FUBON_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";
const FUBON_AUTH_FRAME_NAME = "frame1";
const DEFAULT_OUTCOME_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const LOGIN_FORM_REJECTION_GRACE_MS = 10_000;
/** The in-frame CAPTCHA rejection the Fubon source definition declares. */
function declaredCaptchaRejection(): PageMatch {
  const evidence = FUBON_SOURCE.workflow.verification?.rejection;
  if (typeof evidence !== "object" || "dialog" in evidence) {
    throw new Error("The Fubon source must declare its CAPTCHA rejection as on-page text.");
  }
  return evidence;
}

const CAPTCHA_REJECTION = declaredCaptchaRejection();
const LOGIN_REFUSED: PageMatch = {
  frame: FUBON_LOGIN_FRAME_NAME,
  text: { pattern: /^請輸入身分證字號\s*請輸入使用者代碼\s*請輸入使用者密碼$/u },
};
const MARKER_PROBE_TIMEOUT_MS = 100;
const DEFAULT_LOGIN_FILL_TIMEOUT_MS = 60_000;
const DEFAULT_LOGIN_FILL_RETRY_INTERVAL_MS = 50;
const DEFAULT_CURRENT_FRAME_TRANSACTION_TIMEOUT_MS = 5_000;
const DEFAULT_LOGIN_DOCUMENT_TIMEOUT_MS = 60_000;
const DEFAULT_LOGIN_DOCUMENT_POLL_INTERVAL_MS = 50;
const DEFAULT_LOGIN_DOCUMENT_CONFIRMATION_MS = 250;

const LOGOUT_SELECTOR = "#header_form\\:header_logout";
const AUTHENTICATED_MARKER_SELECTOR = [
  "#menu_CDS",
  "#menu_CCC",
  "#menu_CLN",
  "a.task_CBOQU003.menu_CDS0102",
  "a.task_CCCQU002.menu_CCC02",
  "a.task_CLNQU001.menu_CLN02",
  "#form1",
].join(", ");
const LOGIN_FORM_SELECTOR =
  "#m1_userCaptcha, #m1_inputOTP, input[type='password']";

const frameIdentities = new WeakMap<object, string>();

function opaqueIdentity(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

function identityForFrame(frame: Frame): string {
  const object = frame as unknown as object;
  const existing = frameIdentities.get(object);
  if (existing) return existing;
  const identity = opaqueIdentity("frame");
  frameIdentities.set(object, identity);
  return identity;
}

export type FubonLoginSnapshot = Readonly<{
  loggedIn: boolean | undefined;
  result: boolean | undefined;
  errorCode: string | undefined;
  logoutAttached: boolean;
  logoutVisible: boolean;
  authenticatedMarker: boolean;
  loginAnchorVisible: boolean;
  loginFormVisible: boolean;
}>;

/** The sanitized alerts the dialog observer saw since the outcome window began, read by the outcome poll. */
export type FubonLoginDialogChannel = Readonly<{
  messages: readonly string[];
  beginOutcomeWindow: () => void;
}>;

export type FubonLoginProbeContext = Readonly<{
  signal: AbortSignal;
  timeoutMs: number;
}>;

export type FubonLoginCredentialValues = Readonly<{
  userId: string;
  account: string;
  password: string;
}>;

export type FubonLoginFillOptions = Readonly<{
  frameName?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}>;

export type FubonLoginDocumentOptions = Readonly<{
  frameName?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  confirmationMs?: number;
}>;

/** Non-sensitive evidence captured before the App requests CAPTCHA assistance. */
export type FubonLoginAssistanceSnapshot = Readonly<{
  frameName: string;
  frameIdentity: string;
  documentIdentity: string;
  documentUrl: string;
  visibleCredentialCount: number;
  visibleCredentialIdentities: readonly string[];
  captchaIdentity: string | undefined;
  captchaImageTimestamp: number | undefined;
  markerReady: boolean;
}>;

export type FubonLoginGenerationSnapshot = FubonLoginAssistanceSnapshot;

export type FubonPreparedLoginDocument = Readonly<{
  frame: Frame;
  snapshot: FubonLoginAssistanceSnapshot;
}>;

export type FubonCurrentFrameSubmitOptions = Readonly<{
  frameName?: string;
  timeoutMs?: number;
  before?: FubonLoginAssistanceSnapshot;
  assistanceBefore?: FubonLoginAssistanceSnapshot;
  beforeSnapshot?: FubonLoginAssistanceSnapshot;
  preSubmitIdle?: boolean;
  preSubmitErrorCode?: string | number;
}>;

export type FubonCurrentFrameSubmitResult = Readonly<{
  status:
    "submitted" | "reacquire-human-assistance" | "submit-outcome-uncertain";
  reason?:
    | "frame-missing"
    | "current-frame-changed"
    | "document-changed"
    | "input-identities-changed"
    | "captcha-identity-changed"
    | "idle-expired"
    | "captcha-missing"
    | "captcha-empty"
    | "captcha-changed"
    | "credential-fields-missing"
    | "credential-fields-ambiguous"
    | "credential-write-rejected"
    | "submit-missing"
    | "frame-detached"
    | "deadline"
    | "submit-threw";
}>;

export type FubonCaptchaAcquisitionDependencies = Readonly<{
  prepare: () => Promise<FubonLoginAssistanceSnapshot | void>;
  assistAndPause: () => Promise<void>;
  submit: () => Promise<FubonCurrentFrameSubmitResult>;
  maxAttempts?: number;
}>;

export type FubonCurrentFrameOtpResult = Readonly<{
  status: "ready" | "no-challenge" | "reacquire-human-assistance";
  reason?:
    | "frame-missing"
    | "current-frame-changed"
    | "document-changed"
    | "input-identities-changed"
    | "captcha-identity-changed"
    | "otp-empty"
    | "frame-detached"
    | "deadline";
}>;

export type FubonPostLoginOutcomeOptions = Readonly<{
  timeoutMs?: number;
  pollIntervalMs?: number;
  frameName?: string;
  silent?: boolean;
  dialogChannel?: FubonLoginDialogChannel;
  probe?: (
    page: Page,
    context: FubonLoginProbeContext,
  ) => Promise<FubonLoginSnapshot | undefined>;
}>;

export class FubonLoginRejectedError extends Error {
  readonly reason: string;
  readonly errorCode: string | undefined;

  constructor(reason: string, errorCode: string | undefined) {
    super(`Fubon login rejected${errorCode ? ` (error ${errorCode})` : ""}.`);
    this.name = "FubonLoginRejectedError";
    this.reason = reason;
    this.errorCode = errorCode;
  }
}

/**
 * The bank answered a submit carrying filled credentials as if all three were
 * empty. It happens when a login follows the previous session within seconds,
 * and a later attempt succeeds, so it takes the bounded CAPTCHA retry path.
 */
export class FubonLoginRefusedError extends CaptchaProviderRejectedError {
  constructor() {
    super();
    this.name = "FubonLoginRefusedError";
  }
}

export class FubonSubmitOutcomeUncertainError extends Error {
  readonly reason: string | undefined;

  constructor(reason: string | undefined) {
    super(
      "Fubon login submit outcome is uncertain; automatic resubmission was stopped.",
    );
    this.name = "FubonSubmitOutcomeUncertainError";
    this.reason = reason;
  }
}

export class FubonDuplicateLoginTerminalError extends Error {
  constructor() {
    super("Fubon returned the duplicate-login terminal page.");
    this.name = "FubonDuplicateLoginTerminalError";
  }
}

function isExactFubonDuplicateLoginTerminalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "ebank.taipeifubon.com.tw" &&
      url.pathname.endsWith("/NotAuth.jsp") &&
      url.searchParams.get("type") === "dupLogin"
    );
  } catch {
    return false;
  }
}

export function hasFubonDuplicateLoginTerminal(page: Page): boolean {
  try {
    return page
      .frames()
      .some((frame) => isExactFubonDuplicateLoginTerminalUrl(frame.url()));
  } catch {
    return false;
  }
}

function isRecoverableLoginFrameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /detached|execution context was destroyed|target page, context or browser has been closed|stale|timeout/i.test(
    message,
  );
}

async function waitForLoginFrame(
  scope: FrameScope,
  frameName: string,
  deadline: number,
  retryIntervalMs: number,
): Promise<Frame> {
  const { page } = scope;
  while (Date.now() < deadline) {
    scope.signal.throwIfAborted();
    if (hasFubonDuplicateLoginTerminal(page)) {
      throw new FubonDuplicateLoginTerminalError();
    }
    const frame = page.frame({ name: frameName });
    if (frame) return frame;
    const remainingMs = deadline - Date.now();
    await scope.pause(Math.min(retryIntervalMs, remainingMs));
  }
  throw new Error(`Timed out waiting for Fubon login frame "${frameName}".`);
}

/**
 * Start authentication from the bank's public entry page.
 *
 * Product-specific navigation must happen only after this shared auth seam
 * has observed the authenticated state. In particular, do not activate a
 * deposit/card/loan menu or resolve a protected href while unauthenticated.
 */
async function openFubonLoginForm(scope: FrameScope): Promise<void> {
  const { page } = scope;
  await scope.withSignal((signal) => page.goto(FUBON_ENTRY_URL, { waitUntil: "domcontentloaded", signal }));
  if (hasFubonDuplicateLoginTerminal(page)) {
    throw new FubonDuplicateLoginTerminalError();
  }

  const deadline = Date.now() + DEFAULT_LOGIN_DOCUMENT_TIMEOUT_MS;
  const headerFrame = await waitForLoginFrame(
    scope,
    FUBON_AUTH_FRAME_NAME,
    deadline,
    DEFAULT_LOGIN_DOCUMENT_POLL_INTERVAL_MS,
  );
  const loginLink = headerFrame
    .locator("a")
    .filter({ hasText: "登入" })
    .first();
  await scope.withSignal((signal) => loginLink.waitFor({
    state: "attached",
    timeout: Math.max(1, deadline - Date.now()),
    signal,
  }));
  await scope.race(activateControlWithoutPointer(loginLink));

  await waitForLoginFrame(
    scope,
    FUBON_LOGIN_FRAME_NAME,
    deadline,
    DEFAULT_LOGIN_DOCUMENT_POLL_INTERVAL_MS,
  );
  if (hasFubonDuplicateLoginTerminal(page)) {
    throw new FubonDuplicateLoginTerminalError();
  }
}

async function boundedLocatorCount(
  locator: Locator,
  deadline: number,
): Promise<number> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Fubon login field count timed out.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      locator.count(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Fubon login field count timed out.")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type FubonLoginDocumentObservation = Readonly<{
  markerReady: boolean;
  generation: string;
  visibleCredentialCount: number;
  visibleCredentialIdentities: readonly string[];
  documentUrl: string;
  captchaIdentity: string | undefined;
  captchaImageTimestamp: number | undefined;
}>;

/**
 * Read only the current login generation. The identity values are opaque and
 * are deliberately generated inside the page; no credential or CAPTCHA value
 * leaves the browser context.
 */
export async function readFubonLoginGeneration(
  scope: FrameScope,
  options: FubonLoginDocumentOptions = {},
): Promise<FubonLoginAssistanceSnapshot | undefined> {
  const frameName = options.frameName ?? FUBON_LOGIN_FRAME_NAME;
  const frame = scope.page.frame({ name: frameName });
  if (!frame) return undefined;
  const observation = await scope.withSignal((signal) => frame.locator("html").evaluate(
    () => {
      type TrackedDocument = Document & {
        __librettoFubonLoginGeneration?: string;
      };
      type TrackedInput = HTMLInputElement & {
        __librettoFubonCredentialIdentity?: string;
      };
      type TrackedCaptcha = HTMLInputElement & {
        __librettoFubonCaptchaIdentity?: string;
      };
      const trackedDocument = document as TrackedDocument;
      const newIdentity = (prefix: string) =>
        `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
      if (!trackedDocument.__librettoFubonLoginGeneration) {
        Object.defineProperty(
          trackedDocument,
          "__librettoFubonLoginGeneration",
          { value: newIdentity("document") },
        );
      }
      const visible = (element: HTMLElement) => {
        const style = globalThis.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          (element.offsetWidth > 0 ||
            element.offsetHeight > 0 ||
            element.getClientRects().length > 0)
        );
      };
      const marker =
        document.querySelector<HTMLInputElement>("#m1_userCaptcha");
      const fields = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
      ).filter(visible);
      const identities = fields.map((field) => {
        const trackedField = field as TrackedInput;
        if (!trackedField.__librettoFubonCredentialIdentity) {
          Object.defineProperty(
            trackedField,
            "__librettoFubonCredentialIdentity",
            { value: newIdentity("input") },
          );
        }
        return trackedField.__librettoFubonCredentialIdentity ?? "";
      });
      let captchaIdentity: string | undefined;
      if (marker) {
        const trackedCaptcha = marker as TrackedCaptcha;
        if (!trackedCaptcha.__librettoFubonCaptchaIdentity) {
          Object.defineProperty(
            trackedCaptcha,
            "__librettoFubonCaptchaIdentity",
            { value: newIdentity("captcha") },
          );
        }
        captchaIdentity = trackedCaptcha.__librettoFubonCaptchaIdentity;
      }
      const captchaImage = Array.from(
        document.querySelectorAll<HTMLImageElement>("img[src]"),
      ).find((image) => image.getAttribute("src")?.includes("captchaImage"));
      const rawTimestamp = captchaImage
        ?.getAttribute("src")
        ?.match(/[?&]timestamp=(\d+)/i)?.[1];
      const numericTimestamp = rawTimestamp ? Number(rawTimestamp) : undefined;
      return {
        markerReady: Boolean(marker?.isConnected && visible(marker)),
        generation: trackedDocument.__librettoFubonLoginGeneration ?? "",
        visibleCredentialCount: fields.length,
        visibleCredentialIdentities: identities,
        documentUrl: (() => {
          try {
            return `${location.origin}${location.pathname}`;
          } catch {
            return "unknown";
          }
        })(),
        captchaIdentity,
        captchaImageTimestamp:
          numericTimestamp !== undefined &&
          Number.isSafeInteger(numericTimestamp)
            ? numericTimestamp
            : undefined,
      } satisfies FubonLoginDocumentObservation;
    },
    undefined,
    { timeout: Math.max(1, Math.min(1_000, options.timeoutMs ?? 1_000)), signal },
  ));
  return {
    frameName,
    frameIdentity: identityForFrame(frame),
    documentIdentity: observation.generation,
    documentUrl: observation.documentUrl,
    visibleCredentialCount: observation.visibleCredentialCount,
    visibleCredentialIdentities: observation.visibleCredentialIdentities,
    captchaIdentity: observation.captchaIdentity,
    captchaImageTimestamp: observation.captchaImageTimestamp,
    markerReady: observation.markerReady,
  };
}

/** Wait for the evidence-backed 0/multi-tab -> stable-three-field state. */
export async function waitForFubonLoginDocument(
  scope: FrameScope,
  options: FubonLoginDocumentOptions = {},
): Promise<FubonLoginAssistanceSnapshot> {
  const { page } = scope;
  const timeoutMs = Math.max(
    1,
    options.timeoutMs ?? DEFAULT_LOGIN_DOCUMENT_TIMEOUT_MS,
  );
  const pollIntervalMs = Math.max(
    1,
    options.pollIntervalMs ?? DEFAULT_LOGIN_DOCUMENT_POLL_INTERVAL_MS,
  );
  const confirmationMs = Math.max(
    0,
    options.confirmationMs ?? DEFAULT_LOGIN_DOCUMENT_CONFIRMATION_MS,
  );
  const deadline = Date.now() + timeoutMs;
  let candidate: FubonLoginAssistanceSnapshot | undefined;
  let since = 0;
  while (Date.now() < deadline) {
    scope.signal.throwIfAborted();
    if (hasFubonDuplicateLoginTerminal(page)) {
      throw new FubonDuplicateLoginTerminalError();
    }
    let current: FubonLoginAssistanceSnapshot | undefined;
    try {
      const remainingMs = deadline - Date.now();
      current = await readFubonLoginGeneration(scope, {
        ...options,
        timeoutMs: Math.max(1, Math.min(1_000, remainingMs)),
      });
    } catch {
      scope.signal.throwIfAborted();
      current = undefined;
    }
    const key = current
      ? JSON.stringify([
          current.frameIdentity,
          current.documentIdentity,
          current.documentUrl,
          current.visibleCredentialCount,
          current.visibleCredentialIdentities,
          current.captchaIdentity,
          current.captchaImageTimestamp,
        ])
      : "";
    const candidateKey = candidate
      ? JSON.stringify([
          candidate.frameIdentity,
          candidate.documentIdentity,
          candidate.documentUrl,
          candidate.visibleCredentialCount,
          candidate.visibleCredentialIdentities,
          candidate.captchaIdentity,
          candidate.captchaImageTimestamp,
        ])
      : "";
    if (current?.markerReady && current.visibleCredentialCount > 0) {
      if (!candidate || key !== candidateKey) {
        candidate = current;
        since = Date.now();
      } else if (Date.now() - since >= confirmationMs) {
        if (current.visibleCredentialCount !== 3) {
          throw new Error(
            "Fubon login credential field set is ambiguous; expected exactly three visible fields.",
          );
        }
        return current;
      }
    } else {
      candidate = undefined;
      since = 0;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0)
      await scope.pause(Math.min(pollIntervalMs, remainingMs));
  }
  throw new Error(
    "Timed out waiting for the Fubon login document to become ready.",
  );
}

export async function prepareFubonLoginDocument(
  scope: FrameScope,
  options: FubonLoginDocumentOptions = {},
): Promise<FubonPreparedLoginDocument> {
  const snapshot = await waitForFubonLoginDocument(scope, options);
  const frame = scope.page.frame({ name: snapshot.frameName });
  if (!frame || identityForFrame(frame) !== snapshot.frameIdentity) {
    throw new Error("Fubon login frame changed while preparing assistance.");
  }
  return { frame, snapshot };
}

type LoginField = (typeof LOGIN_FIELD_DEFINITIONS)[number];

const LOGIN_FIELD_DEFINITIONS = ["user ID", "account", "password"] as const;

function loginFieldValues(
  values: FubonLoginCredentialValues,
): readonly [string, string, string] {
  return [values.userId, values.account, values.password];
}

function loginValuesMatch(
  actualValues: readonly string[],
  expectedValues: readonly string[],
): boolean {
  return (
    actualValues.length === expectedValues.length &&
    actualValues.every((value, index) => value === expectedValues[index])
  );
}

async function readLoginFieldValues(
  scope: FrameScope,
  frameName: string,
  frame: Frame,
  deadline: number,
): Promise<readonly string[] | undefined> {
  const values: string[] = [];
  for (let index = 0; index < LOGIN_FIELD_DEFINITIONS.length; index += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return undefined;
    try {
      const value = await scope.withSignal((signal) => frame
        .locator('input[type="password"]:visible')
        .nth(index)
        .inputValue({ timeout: remainingMs, signal }));
      values.push(value);
    } catch {
      scope.signal.throwIfAborted();
      return undefined;
    }

    const currentFrame = scope.page.frame({ name: frameName });
    if (currentFrame !== frame) return undefined;
  }
  return values;
}

async function verifyCurrentLoginForm(
  scope: FrameScope,
  frameName: string,
  expectedValues: readonly string[],
  deadline: number,
  frame: Frame,
): Promise<boolean> {
  const readback = await readLoginFieldValues(scope, frameName, frame, deadline);
  return (
    readback !== undefined &&
    loginValuesMatch(readback, expectedValues) &&
    scope.page.frame({ name: frameName }) === frame
  );
}

/** Fill the three login fields with a bounded retry after an observed detach. */
export async function fillFubonLoginCredentials(
  scope: FrameScope,
  values: FubonLoginCredentialValues,
  options: FubonLoginFillOptions = {},
): Promise<void> {
  const { page } = scope;
  const frameName = options.frameName ?? FUBON_LOGIN_FRAME_NAME;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_FILL_TIMEOUT_MS;
  const retryIntervalMs =
    options.retryIntervalMs ?? DEFAULT_LOGIN_FILL_RETRY_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  const fields = loginFieldValues(values);
  const fieldNames: readonly LoginField[] = LOGIN_FIELD_DEFINITIONS;
  let currentFrame: Frame | undefined;
  let fieldIndex = 0;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const frame = await waitForLoginFrame(
      scope,
      frameName,
      deadline,
      retryIntervalMs,
    );
    if (currentFrame && currentFrame !== frame) {
      const readinessRemainingMs = deadline - Date.now();
      if (readinessRemainingMs <= 0) break;
      await waitForFubonLoginDocument(scope, {
        frameName,
        timeoutMs: readinessRemainingMs,
        pollIntervalMs: retryIntervalMs,
      });
    }
    if (currentFrame !== frame) {
      currentFrame = frame;
      fieldIndex = 0;
    }

    const fieldName = fieldNames[fieldIndex] ?? fieldNames[0];
    const value = fields[fieldIndex] ?? fields[0];
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const visibleFields = frame.locator('input[type="password"]:visible');
    let visibleFieldCount: number;
    try {
      visibleFieldCount = await scope.race(boundedLocatorCount(visibleFields, deadline));
    } catch (error) {
      scope.signal.throwIfAborted();
      lastError = error;
      const current = page.frame({ name: frameName });
      if (current && current !== frame) {
        const readinessRemainingMs = deadline - Date.now();
        if (readinessRemainingMs <= 0) break;
        await waitForFubonLoginDocument(scope, {
          frameName,
          timeoutMs: readinessRemainingMs,
          pollIntervalMs: retryIntervalMs,
        });
        currentFrame = current;
        fieldIndex = 0;
        continue;
      }
      throw new Error(
        "Fubon login credential field set was not ready before the bounded wait ended.",
      );
    }
    if (visibleFieldCount !== fields.length) {
      const readinessRemainingMs = deadline - Date.now();
      if (readinessRemainingMs <= 0) break;
      await waitForFubonLoginDocument(scope, {
        frameName,
        timeoutMs: readinessRemainingMs,
        pollIntervalMs: retryIntervalMs,
      });
      currentFrame = undefined;
      fieldIndex = 0;
      continue;
    }
    const field = visibleFields.nth(fieldIndex);
    try {
      await scope.withSignal((signal) => field.waitFor({
        state: "visible",
        timeout: Math.min(remainingMs, 5_000),
        signal,
      }));
      const fillTimeoutMs = deadline - Date.now();
      if (fillTimeoutMs <= 0) break;
      await scope.withSignal((signal) => field.fill(value, { timeout: fillTimeoutMs, signal }));
    } catch (error) {
      scope.signal.throwIfAborted();
      lastError = error;
      const current = page.frame({ name: frameName });
      if (current && current !== frame) {
        const readinessRemainingMs = deadline - Date.now();
        if (readinessRemainingMs <= 0) break;
        await waitForFubonLoginDocument(scope, {
          frameName,
          timeoutMs: readinessRemainingMs,
          pollIntervalMs: retryIntervalMs,
        });
        currentFrame = current;
        fieldIndex = 0;
        continue;
      }
      if (!isRecoverableLoginFrameError(error)) {
        throw new Error(
          `Fubon login ${fieldName} field was not ready before the bounded wait ended.`,
        );
      }
      const retryRemainingMs = deadline - Date.now();
      if (retryRemainingMs > 0) {
        await scope.pause(Math.min(retryIntervalMs, retryRemainingMs));
      }
      continue;
    }

    const current = page.frame({ name: frameName });
    if (current && current !== frame) {
      const readinessRemainingMs = deadline - Date.now();
      if (readinessRemainingMs <= 0) break;
      await waitForFubonLoginDocument(scope, {
        frameName,
        timeoutMs: readinessRemainingMs,
        pollIntervalMs: retryIntervalMs,
      });
      currentFrame = current;
      fieldIndex = 0;
      continue;
    }

    fieldIndex += 1;
    if (fieldIndex >= fields.length) {
      if (
        !(await verifyCurrentLoginForm(
          scope,
          frameName,
          fields,
          deadline,
          frame,
        ))
      ) {
        currentFrame = undefined;
        fieldIndex = 0;
        continue;
      }
      return;
    }
  }

  throw new Error(
    `Timed out filling the Fubon login form before all credential fields were ready${
      lastError instanceof Error && isRecoverableLoginFrameError(lastError)
        ? " after an observed current-frame change"
        : ""
    }.`,
  );
}

function snapshotChangeReason(
  before: FubonLoginAssistanceSnapshot,
  current: FubonLoginAssistanceSnapshot,
): FubonCurrentFrameSubmitResult["reason"] {
  if (before.frameIdentity !== current.frameIdentity) {
    return "current-frame-changed";
  }
  if (
    before.documentIdentity !== current.documentIdentity ||
    before.documentUrl !== current.documentUrl
  ) {
    return "document-changed";
  }
  if (
    before.visibleCredentialIdentities.length !==
      current.visibleCredentialIdentities.length ||
    before.visibleCredentialIdentities.some(
      (identity, index) =>
        identity !== current.visibleCredentialIdentities[index],
    )
  ) {
    return "input-identities-changed";
  }
  if (before.captchaIdentity !== current.captchaIdentity) {
    return "captcha-identity-changed";
  }
  if (before.captchaImageTimestamp !== current.captchaImageTimestamp) {
    return "captcha-identity-changed";
  }
  return undefined;
}

/**
 * Resume CAPTCHA in the currently observed generation. A stable generation
 * submits without credential mutations; a stable generation with empty fields
 * refills exactly three fields. Any observed generation change requires new
 * human assistance; a stale CAPTCHA is never submitted.
 */
export async function submitFubonCaptchaFromCurrentFrame(
  scope: FrameScope,
  values: FubonLoginCredentialValues,
  options: FubonCurrentFrameSubmitOptions = {},
): Promise<FubonCurrentFrameSubmitResult> {
  const frameName = options.frameName ?? FUBON_LOGIN_FRAME_NAME;
  const timeoutMs = Math.max(
    1,
    options.timeoutMs ?? DEFAULT_CURRENT_FRAME_TRANSACTION_TIMEOUT_MS,
  );
  if (
    options.preSubmitIdle ||
    String(options.preSubmitErrorCode ?? "").padStart(4, "0") === "0240"
  ) {
    return { status: "reacquire-human-assistance", reason: "idle-expired" };
  }
  const frame = scope.page.frame({ name: frameName });
  if (!frame) {
    return { status: "reacquire-human-assistance", reason: "frame-missing" };
  }
  const before =
    options.before ?? options.assistanceBefore ?? options.beforeSnapshot;
  let current: FubonLoginAssistanceSnapshot | undefined;
  try {
    current = await readFubonLoginGeneration(scope, {
      frameName,
      timeoutMs,
    });
  } catch (error) {
    scope.signal.throwIfAborted();
    if (before) {
      return {
        status: "reacquire-human-assistance",
        reason: isRecoverableLoginFrameError(error)
          ? "frame-detached"
          : "deadline",
      };
    }
    current = undefined;
  }
  if (current) {
    if (!current.markerReady) {
      return {
        status: "reacquire-human-assistance",
        reason: "captcha-missing",
      };
    }
    if (current.visibleCredentialCount !== 3) {
      return {
        status: "reacquire-human-assistance",
        reason: "credential-fields-ambiguous",
      };
    }
    if (before) {
      const changed = snapshotChangeReason(before, current);
      if (changed) {
        return { status: "reacquire-human-assistance", reason: changed };
      }
    }
  }

  let submitInvocationStarted = false;
  try {
    const prepared = await scope.withSignal((signal) => frame.locator("html").evaluate(
      (_root, credentials) => {
        const expectedDocumentIdentity = (
          credentials as FubonLoginCredentialValues & {
            __expectedDocumentIdentity?: string;
          }
        ).__expectedDocumentIdentity;
        const actualDocumentIdentity = (
          document as Document & { __librettoFubonLoginGeneration?: string }
        ).__librettoFubonLoginGeneration;
        if (
          expectedDocumentIdentity &&
          actualDocumentIdentity &&
          expectedDocumentIdentity !== actualDocumentIdentity
        ) {
          return {
            status: "reacquire-human-assistance",
            reason: "document-changed",
          } as const;
        }
        const captcha =
          document.querySelector<HTMLInputElement>("#m1_userCaptcha");
        if (!captcha) {
          return {
            status: "reacquire-human-assistance",
            reason: "captcha-missing",
          } as const;
        }
        const captchaValue = captcha.value.trim();
        if (!captchaValue) {
          return {
            status: "reacquire-human-assistance",
            reason: "captcha-empty",
          } as const;
        }

        const visibleCredentialFields = () =>
          Array.from(
            document.querySelectorAll<HTMLInputElement>(
              'input[type="password"]',
            ),
          ).filter((field) => field.offsetParent !== null);
        const fields = visibleCredentialFields();
        if (fields.length !== 3) {
          return {
            status: "reacquire-human-assistance",
            reason: "credential-fields-ambiguous",
          } as const;
        }
        const sameCredentialSet = () => {
          const current = visibleCredentialFields();
          return (
            current.length === fields.length &&
            current.every((field, index) => field === fields[index])
          );
        };
        if (!sameCredentialSet()) {
          return {
            status: "reacquire-human-assistance",
            reason: "credential-fields-ambiguous",
          } as const;
        }

        const expected = [
          credentials.userId,
          credentials.account,
          credentials.password,
        ];
        const credentialsPresent = fields.every((field) => field.value.trim());
        if (!credentialsPresent) {
          const valueSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set;
          if (!valueSetter) {
            return {
              status: "reacquire-human-assistance",
              reason: "credential-write-rejected",
            } as const;
          }
          for (let index = 0; index < expected.length; index += 1) {
            if (!sameCredentialSet()) {
              return {
                status: "reacquire-human-assistance",
                reason: "credential-fields-ambiguous",
              } as const;
            }
            const field = fields[index];
            valueSetter.call(field, expected[index]);
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));
            if (field.value !== expected[index]) {
              return {
                status: "reacquire-human-assistance",
                reason: "credential-write-rejected",
              } as const;
            }
            if (
              !captcha.isConnected ||
              document.querySelector("#m1_userCaptcha") !== captcha ||
              captcha.value.trim() !== captchaValue
            ) {
              return {
                status: "reacquire-human-assistance",
                reason: "captcha-changed",
              } as const;
            }
          }
        }

        const submit = document.querySelector<HTMLElement>("#btnLogin2");
        if (!submit || !submit.isConnected) {
          return {
            status: "reacquire-human-assistance",
            reason: "submit-missing",
          } as const;
        }
        if (
          !captcha.isConnected ||
          document.querySelector("#m1_userCaptcha") !== captcha ||
          captcha.value.trim() !== captchaValue
        ) {
          return {
            status: "reacquire-human-assistance",
            reason: "captcha-changed",
          } as const;
        }

        return { status: "ready-to-submit" } as const;
      },
      {
        ...values,
        __expectedDocumentIdentity: current?.documentIdentity,
      },
      { timeout: timeoutMs, signal },
    ));
    if (prepared.status !== "ready-to-submit") return prepared;

    // From this point onward the browser task may invoke the bank submit
    // handler. Any transport/detach/timeout rejection is therefore fenced as
    // uncertain, even if the browser cannot report whether click ran.
    submitInvocationStarted = true;
    return await scope.withSignal((signal) => frame.locator("html").evaluate(
      () => {
        const submit = document.querySelector<HTMLElement>("#btnLogin2");
        if (!submit || !submit.isConnected) {
          return {
            status: "reacquire-human-assistance",
            reason: "submit-missing",
          } as const;
        }
        submit.click();
        return { status: "submitted" } as const;
      },
      undefined,
      { timeout: timeoutMs, signal },
    ));
  } catch (error) {
    scope.signal.throwIfAborted();
    if (submitInvocationStarted) {
      return {
        status: "submit-outcome-uncertain",
        reason: isRecoverableLoginFrameError(error)
          ? "frame-detached"
          : "submit-threw",
      };
    }
    return {
      status: "reacquire-human-assistance",
      reason: isRecoverableLoginFrameError(error)
        ? "frame-detached"
        : "deadline",
    };
  }
}

/**
 * Repeat assistance only while the transaction proves that no submit
 * invocation began. An uncertain submit is a terminal fence.
 */
export async function runFubonCaptchaAcquisition(
  dependencies: FubonCaptchaAcquisitionDependencies,
): Promise<FubonCurrentFrameSubmitResult> {
  await dependencies.prepare();
  const maxAttempts = Math.max(1, dependencies.maxAttempts ?? 3);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await dependencies.assistAndPause();
    const result = await dependencies.submit();
    if (result.status !== "reacquire-human-assistance") return result;
    if (attempt + 1 < maxAttempts) await dependencies.prepare();
    else return result;
  }
  return { status: "reacquire-human-assistance", reason: "deadline" };
}

/** Inspect the OTP only in the current document. No OTP value leaves it. */
export async function inspectFubonOtpFromCurrentFrame(
  scope: FrameScope,
  options: FubonCurrentFrameSubmitOptions = {},
): Promise<FubonCurrentFrameOtpResult> {
  const frameName = options.frameName ?? FUBON_LOGIN_FRAME_NAME;
  const timeoutMs = Math.max(
    1,
    options.timeoutMs ?? DEFAULT_CURRENT_FRAME_TRANSACTION_TIMEOUT_MS,
  );
  const frame = scope.page.frame({ name: frameName });
  if (!frame) {
    return { status: "reacquire-human-assistance", reason: "frame-missing" };
  }
  const before =
    options.before ?? options.assistanceBefore ?? options.beforeSnapshot;
  if (before) {
    let current: FubonLoginAssistanceSnapshot | undefined;
    try {
      current = await readFubonLoginGeneration(scope, {
        frameName,
        timeoutMs,
      });
    } catch (error) {
      scope.signal.throwIfAborted();
      return {
        status: "reacquire-human-assistance",
        reason: isRecoverableLoginFrameError(error)
          ? "frame-detached"
          : "deadline",
      };
    }
    if (!current) {
      return { status: "reacquire-human-assistance", reason: "frame-missing" };
    }
    const changed = snapshotChangeReason(before, current);
    if (changed) {
      return {
        status: "reacquire-human-assistance",
        reason:
          changed === "input-identities-changed" ||
          changed === "captcha-identity-changed"
            ? changed
            : changed === "current-frame-changed"
              ? "current-frame-changed"
              : "document-changed",
      };
    }
  }

  try {
    return await scope.withSignal((signal) => frame.locator("html").evaluate(
      () => {
        const otp = document.querySelector<HTMLInputElement>("#m1_inputOTP");
        if (!otp) return { status: "no-challenge" } as const;
        if (!otp.isConnected || !otp.value.trim()) {
          return {
            status: "reacquire-human-assistance",
            reason: "otp-empty",
          } as const;
        }
        if (
          !otp.isConnected ||
          document.querySelector("#m1_inputOTP") !== otp
        ) {
          return {
            status: "reacquire-human-assistance",
            reason: "current-frame-changed",
          } as const;
        }
        return { status: "ready" } as const;
      },
      undefined,
      { timeout: timeoutMs, signal },
    ));
  } catch (error) {
    scope.signal.throwIfAborted();
    return {
      status: "reacquire-human-assistance",
      reason: isRecoverableLoginFrameError(error)
        ? "frame-detached"
        : "deadline",
    };
  }
}

export function fubonCaptchaAssistanceStage(
  frame: Frame,
): VerificationStage {
  return {
    stageId: "fubon-login-captcha",
    title: "Enter the Fubon CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: FUBON_CAPTCHA_INPUT_SEMANTIC_ID,
        modes: ["click", "type"],
        locator: frame.locator("#m1_userCaptcha"),
      },
    ],
    contextRegions: [
      {
        id: "captcha-challenge",
        label: "CAPTCHA challenge and instructions",
        semanticId: "fubon.login.captcha-challenge",
      },
    ],
    challengeKind: "text-captcha",
    charset: "digits",
    ocrPageSegmentationMode: "single-word",
    ocrAttemptPlan: [
      {
        imagePreprocessing: [],
        ocrPageSegmentationMode: "single-word",
      },
      {
        imagePreprocessing: ["fubon-luminance-foreground"],
        ocrPageSegmentationMode: "single-word",
      },
      {
        imagePreprocessing: ["fubon-min-channel-foreground"],
        ocrPageSegmentationMode: "single-word",
      },
    ],
    solveAcceptancePolicy: { mode: "agreement-only" },
    expectedAnswerLength: 6,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: FUBON_CAPTCHA_IMAGE_SEMANTIC_ID,
      locator: frame.locator(FUBON_CAPTCHA_IMAGE_SELECTOR).first(),
    },
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: {
      targetId: "captcha-input",
      contextRegionIds: ["captcha-challenge"],
      initialZoom: 1.15,
    },
  };
}

async function currentOtpChallengeVisible(
  scope: FrameScope,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    scope.signal.throwIfAborted();
    const frame = scope.page.frame({ name: FUBON_LOGIN_FRAME_NAME });
    if (
      frame &&
      (await scope.race(frame
        .locator("#m1_inputOTP")
        .isVisible()
        .catch(() => false)))
    ) {
      return true;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await scope.pause(Math.min(100, remainingMs));
    }
  }
  return false;
}


type FubonLogin = Readonly<{
  run: (scope: FrameScope) => Promise<void>;
  observe: (dialog: DialogSnapshot) => DialogDecision;
}>;

/**
 * Fubon's `own` sign-in and the step's dialog observer for it. They share one
 * channel built per sign-in, so an alert the observer accepted during the
 * outcome window still ends the login as `dialog-alert`.
 */
export function fubonLogin(
  values: FubonLoginCredentialValues,
  complete: (stage: VerificationStage) => Promise<void>,
): FubonLogin {
  const messages: string[] = [];
  const dialogs: FubonLoginDialogChannel = {
    messages,
    beginOutcomeWindow: () => {
      messages.length = 0;
    },
  };
  return {
    run: (scope) => runFubonLogin(scope, values, { complete, dialogs }),
    observe: (dialog) => {
      if (dialog.type !== "alert") {
        emitOutcome("rejected", "unknown-confirm");
        return new FubonLoginRejectedError("unknown-confirm", undefined);
      }
      messages.push(sanitizedDialogAlert(dialog.message));
      return "accept";
    },
  };
}

async function runFubonLogin(
  scope: FrameScope,
  values: FubonLoginCredentialValues,
  options: Readonly<{
    complete(stage: VerificationStage): Promise<void>;
    dialogs: FubonLoginDialogChannel;
  }>,
): Promise<void> {
  const { complete, dialogs } = options;
  await openFubonLoginForm(scope);

  let outcomeWindowStarted = false;
  let assistanceBefore: FubonLoginAssistanceSnapshot | undefined;
  const submit = await runFubonCaptchaAcquisition({
    prepare: async () => {
      scope.signal.throwIfAborted();
      await prepareFubonLoginDocument(scope);
      await fillFubonLoginCredentials(scope, values);
      assistanceBefore = await readFubonLoginGeneration(scope);
      if (!assistanceBefore)
        throw new Error("Fubon login frame disappeared while preparing assistance.");
      return assistanceBefore;
    },
    assistAndPause: async () => {
      if (!outcomeWindowStarted) {
        dialogs.beginOutcomeWindow();
        outcomeWindowStarted = true;
      }
      const frame = await waitForLoginFrame(
        scope,
        FUBON_LOGIN_FRAME_NAME,
        Date.now() + DEFAULT_LOGIN_FILL_TIMEOUT_MS,
        DEFAULT_LOGIN_FILL_RETRY_INTERVAL_MS,
      );
      await scope.withSignal((signal) => frame.locator("#m1_userCaptcha").focus({ signal }));
      await withAbort(complete(fubonCaptchaAssistanceStage(frame)), scope.signal);
    },
    submit: async () => {
      scope.signal.throwIfAborted();
      if (dialogs.messages.length > 0) {
        await waitForFubonPostLoginOutcome(scope, { dialogChannel: dialogs, silent: true });
      }
      return await submitFubonCaptchaFromCurrentFrame(scope, values, {
        before: assistanceBefore,
      });
    },
  });

  if (submit.status === "submit-outcome-uncertain")
    throw new FubonSubmitOutcomeUncertainError(submit.reason);
  if (submit.status !== "submitted")
    throw new Error(`Fubon CAPTCHA assistance retry bound reached (${submit.reason ?? "reacquire"}).`);

  if (await currentOtpChallengeVisible(scope)) {
    for (;;) {
      scope.signal.throwIfAborted();
      const otpBefore = await readFubonLoginGeneration(scope);
      const frame = await waitForLoginFrame(
        scope,
        FUBON_LOGIN_FRAME_NAME,
        Date.now() + DEFAULT_LOGIN_FILL_TIMEOUT_MS,
        DEFAULT_LOGIN_FILL_RETRY_INTERVAL_MS,
      );
      await complete({
        stageId: "fubon-login-otp",
        title: "Enter the Fubon OTP",
        targets: [{
          id: "otp-input",
          label: "OTP input",
          semanticId: "fubon.login.otp-input",
          modes: ["click", "type"],
          locator: frame.locator("#m1_inputOTP"),
        }],
        contextRegions: [{ id: "otp-challenge", label: "OTP instructions", semanticId: "fubon.login.otp-challenge" }],
        completion: { mode: "inline", targetIds: ["otp-input"] },
        focus: { targetId: "otp-input", contextRegionIds: ["otp-challenge"], initialZoom: 1.15 },
      });
      const otp = await inspectFubonOtpFromCurrentFrame(scope, { before: otpBefore });
      if (otp.status === "ready" || otp.status === "no-challenge") break;
    }
  }

  await waitForFubonPostLoginOutcome(scope, { dialogChannel: dialogs, silent: true });
}

function emitOutcome(
  status: "success" | "rejected" | "timeout",
  reason: string,
) {
  console.log("fubon-login-outcome", { status, reason });
}

function latestDialogMessage(
  dialogChannel: FubonLoginDialogChannel | undefined,
): string | undefined {
  if (!dialogChannel || dialogChannel.messages.length === 0) return undefined;
  return dialogChannel.messages[dialogChannel.messages.length - 1];
}

type BankAuthGlobals = {
  loggedIn?: unknown;
  result?: unknown;
  loginResult?: unknown;
  errorCode?: unknown;
};

type ReadBankAuthState = {
  loggedIn: boolean | undefined;
  result: boolean | undefined;
  errorCode: string | undefined;
};

async function readBankAuthState(
  frame: Frame,
  context: FubonLoginProbeContext,
): Promise<ReadBankAuthState> {
  const handle = await frame.waitForFunction(
    () => {
      const bankWindow = globalThis as typeof globalThis & BankAuthGlobals;
      const directResult = bankWindow.result;
      const directResultObject =
        typeof directResult === "object" && directResult !== null
          ? (directResult as { result?: unknown; errorCode?: unknown })
          : undefined;
      const loginResult = bankWindow.loginResult;
      const loginResultObject =
        typeof loginResult === "object" && loginResult !== null
          ? (loginResult as { result?: unknown; errorCode?: unknown })
          : undefined;
      const resultValue =
        directResultObject?.result ??
        directResult ??
        loginResultObject?.result ??
        loginResult;
      const errorCodeValue =
        bankWindow.errorCode ??
        directResultObject?.errorCode ??
        loginResultObject?.errorCode;
      const toBoolean = (value: unknown): boolean | undefined => {
        if (value === true || value === false) return value;
        if (value === "true" || value === "false") return value === "true";
        return undefined;
      };
      const toErrorCode = (value: unknown): string | undefined => {
        if (
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0
        ) {
          return String(value).padStart(4, "0");
        }
        if (typeof value !== "string") return undefined;
        const code = value.trim();
        return /^\d{3,8}$/.test(code) ? code : undefined;
      };
      return {
        loggedIn: toBoolean(bankWindow.loggedIn),
        result: toBoolean(resultValue),
        errorCode: toErrorCode(errorCodeValue),
      };
    },
    undefined,
    {
      timeout: context.timeoutMs,
      signal: context.signal,
    },
  );
  try {
    return (await handle.jsonValue()) as ReadBankAuthState;
  } finally {
    await handle.dispose();
  }
}

async function hasAttachedOrVisible(
  locator: Locator,
  state: "attached" | "visible",
  context: FubonLoginProbeContext,
): Promise<boolean> {
  try {
    await locator.first().waitFor({
      state,
      timeout: context.timeoutMs,
      signal: context.signal,
    });
    return true;
  } catch {
    return false;
  }
}

async function probeFubonLoginPage(
  page: Page,
  context: FubonLoginProbeContext,
  frameName = FUBON_AUTH_FRAME_NAME,
): Promise<FubonLoginSnapshot | undefined> {
  const frame = page.frame({ name: frameName });
  if (!frame) return undefined;

  try {
    const logout = frame.locator(LOGOUT_SELECTOR).first();
    const loginAnchor = frame.locator("a").filter({ hasText: "登入" }).first();
    const [
      bankState,
      logoutAttached,
      logoutVisible,
      authenticatedMarker,
      loginAnchorVisible,
      loginFormVisible,
    ] = await Promise.all([
      readBankAuthState(frame, context),
      hasAttachedOrVisible(logout, "attached", context),
      hasAttachedOrVisible(logout, "visible", context),
      hasAttachedOrVisible(
        frame.locator(AUTHENTICATED_MARKER_SELECTOR).first(),
        "attached",
        context,
      ),
      hasAttachedOrVisible(loginAnchor, "visible", context),
      hasAttachedOrVisible(
        frame.locator(LOGIN_FORM_SELECTOR).first(),
        "visible",
        context,
      ),
    ]);

    return {
      ...bankState,
      logoutAttached,
      logoutVisible,
      authenticatedMarker,
      loginAnchorVisible,
      loginFormVisible,
    };
  } catch {
    // The current frame can change between lookup and probe; the next bounded
    // poll obtains a fresh frame instead of retaining a stale locator.
    return undefined;
  }
}

function rejectionForSnapshot(
  snapshot: FubonLoginSnapshot | undefined,
): string | undefined {
  if (snapshot?.result === false) return "result-false";
  if (
    snapshot?.loggedIn === false &&
    (snapshot.loginAnchorVisible || snapshot.loginFormVisible)
  ) {
    return "login-form-visible";
  }
  return undefined;
}

function authenticatedMarkerForSnapshot(
  snapshot: FubonLoginSnapshot | undefined,
): boolean {
  return Boolean(
    snapshot?.loggedIn === true &&
    (snapshot.logoutAttached ||
      snapshot.logoutVisible ||
      snapshot.authenticatedMarker),
  );
}

function throwDialogRejection(
  dialogMessage: string,
  snapshot: FubonLoginSnapshot | undefined,
): never {
  const errorCode = snapshot?.errorCode ?? errorCodeFromDialog(dialogMessage);
  emitOutcome("rejected", "dialog-alert");
  throw new FubonLoginRejectedError("dialog-alert", errorCode);
}

/** Fubon renders login responses inline in the login frame, not as dialogs. */
async function fubonLoginResponseVisible(scope: FrameScope, response: PageMatch): Promise<boolean> {
  try {
    const found = locatePageMatch(scope.page, response);
    if (!found) return false;
    return await scope.race(found.match.first().isVisible().catch(() => false));
  } catch {
    scope.signal.throwIfAborted();
    return false;
  }
}

export async function waitForFubonPostLoginOutcome(
  scope: FrameScope,
  options: FubonPostLoginOutcomeOptions = {},
): Promise<void> {
  const timeoutMs = Math.max(
    0,
    options.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS,
  );
  const pollIntervalMs = Math.max(
    1,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  const deadline = Date.now() + timeoutMs;
  const loginFormRejectionAfter = Math.min(
    deadline,
    Date.now() + LOGIN_FORM_REJECTION_GRACE_MS,
  );
  let lastRejectionReason: string | undefined;
  let lastErrorCode: string | undefined;
  const probe =
    options.probe ??
    ((actualPage: Page, context: FubonLoginProbeContext) =>
      probeFubonLoginPage(actualPage, context, options.frameName));

  while (Date.now() < deadline) {
    scope.signal.throwIfAborted();
    const dialogBeforeProbe = latestDialogMessage(options.dialogChannel);
    if (dialogBeforeProbe !== undefined) {
      throwDialogRejection(dialogBeforeProbe, undefined);
    }

    const remainingMs = deadline - Date.now();
    const probeTimeoutMs = Math.min(
      MARKER_PROBE_TIMEOUT_MS,
      Math.max(1, remainingMs),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    let snapshot: FubonLoginSnapshot | undefined;
    try {
      snapshot = await probe(scope.page, {
        signal: AbortSignal.any([controller.signal, scope.signal]),
        timeoutMs: probeTimeoutMs,
      });
    } catch {
      snapshot = undefined;
    } finally {
      clearTimeout(timer);
    }
    scope.signal.throwIfAborted();

    const dialogMessage = latestDialogMessage(options.dialogChannel);
    if (dialogMessage !== undefined) {
      throwDialogRejection(dialogMessage, snapshot);
    }

    if (await fubonLoginResponseVisible(scope, CAPTCHA_REJECTION)) {
      if (!options.silent) emitOutcome("rejected", "captcha-rejected");
      throw new CaptchaProviderRejectedError();
    }
    if (await fubonLoginResponseVisible(scope, LOGIN_REFUSED)) {
      if (!options.silent) emitOutcome("rejected", "login-refused");
      throw new FubonLoginRefusedError();
    }

    const rejectionReason = rejectionForSnapshot(snapshot);
    lastRejectionReason = rejectionReason;
    lastErrorCode = snapshot?.errorCode;
    if (rejectionReason) {
      // The login form is also visible immediately after the click. Give the
      // bank time to emit its actual post-submit result or dialog before
      // interpreting that unchanged form as a rejection.
      if (
        rejectionReason !== "login-form-visible" ||
        Date.now() >= loginFormRejectionAfter
      ) {
        if (!options.silent) emitOutcome("rejected", rejectionReason);
        throw new FubonLoginRejectedError(rejectionReason, snapshot?.errorCode);
      }
    }

    if (authenticatedMarkerForSnapshot(snapshot)) {
      if (!options.silent) emitOutcome("success", "marker");
      return;
    }

    const remainingAfterProbe = deadline - Date.now();
    if (remainingAfterProbe <= 0) break;
    await scope.pause(Math.min(pollIntervalMs, remainingAfterProbe));
  }

  const dialogMessage = latestDialogMessage(options.dialogChannel);
  if (dialogMessage !== undefined) {
    throwDialogRejection(dialogMessage, undefined);
  }

  if (lastRejectionReason === "login-form-visible") {
    if (!options.silent) emitOutcome("rejected", lastRejectionReason);
    throw new FubonLoginRejectedError(lastRejectionReason, lastErrorCode);
  }

  if (!options.silent) emitOutcome("timeout", "no-authenticated-outcome");
  throw new Error("Fubon post-login outcome timed out.");
}
