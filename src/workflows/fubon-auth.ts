import { pause } from "libretto";
import type { Dialog, Frame, Locator, Page } from "playwright";
import { activateControlWithoutPointer } from "./browser-interaction.ts";
import { emitHumanAssistanceStage } from "./human-assistance.ts";

const FUBON_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";
const FUBON_AUTH_FRAME_NAME = "frame1";
const FUBON_LOGIN_FRAME_NAME = "txnFrame";
const DEFAULT_OUTCOME_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
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

export type FubonLoginDialogChannel = Readonly<{
  messages: readonly string[];
  duplicateTakeoverAccepted: boolean;
  terminalReason: "duplicate-takeover-repeated" | "unknown-confirm" | undefined;
  beginOutcomeWindow: () => void;
  dispose: () => void;
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

/** Non-sensitive evidence captured before the browser is paused for CAPTCHA. */
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
  page: Page,
  frameName: string,
  deadline: number,
  retryIntervalMs: number,
): Promise<Frame> {
  while (Date.now() < deadline) {
    if (hasFubonDuplicateLoginTerminal(page)) {
      throw new FubonDuplicateLoginTerminalError();
    }
    const frame = page.frame({ name: frameName });
    if (frame) return frame;
    const remainingMs = deadline - Date.now();
    await page.waitForTimeout(Math.min(retryIntervalMs, remainingMs));
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
export async function openFubonLoginForm(page: Page): Promise<void> {
  await page.goto(FUBON_ENTRY_URL, { waitUntil: "domcontentloaded" });
  if (hasFubonDuplicateLoginTerminal(page)) {
    throw new FubonDuplicateLoginTerminalError();
  }

  const deadline = Date.now() + DEFAULT_LOGIN_DOCUMENT_TIMEOUT_MS;
  const headerFrame = await waitForLoginFrame(
    page,
    FUBON_AUTH_FRAME_NAME,
    deadline,
    DEFAULT_LOGIN_DOCUMENT_POLL_INTERVAL_MS,
  );
  const loginLink = headerFrame
    .locator("a")
    .filter({ hasText: "登入" })
    .first();
  await loginLink.waitFor({
    state: "attached",
    timeout: Math.max(1, deadline - Date.now()),
  });
  await activateControlWithoutPointer(loginLink);

  await waitForLoginFrame(
    page,
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
  page: Page,
  options: FubonLoginDocumentOptions = {},
): Promise<FubonLoginAssistanceSnapshot | undefined> {
  const frameName = options.frameName ?? FUBON_LOGIN_FRAME_NAME;
  const frame = page.frame({ name: frameName });
  if (!frame) return undefined;
  const observation = await frame.locator("html").evaluate(
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
    { timeout: Math.max(1, Math.min(1_000, options.timeoutMs ?? 1_000)) },
  );
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
  page: Page,
  options: FubonLoginDocumentOptions = {},
): Promise<FubonLoginAssistanceSnapshot> {
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
    if (hasFubonDuplicateLoginTerminal(page)) {
      throw new FubonDuplicateLoginTerminalError();
    }
    let current: FubonLoginAssistanceSnapshot | undefined;
    try {
      const remainingMs = deadline - Date.now();
      current = await readFubonLoginGeneration(page, {
        ...options,
        timeoutMs: Math.max(1, Math.min(1_000, remainingMs)),
      });
    } catch {
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
      await page.waitForTimeout(Math.min(pollIntervalMs, remainingMs));
  }
  throw new Error(
    "Timed out waiting for the Fubon login document to become ready.",
  );
}

export async function prepareFubonLoginDocument(
  page: Page,
  options: FubonLoginDocumentOptions = {},
): Promise<FubonPreparedLoginDocument> {
  const snapshot = await waitForFubonLoginDocument(page, options);
  const frame = page.frame({ name: snapshot.frameName });
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
  page: Page,
  frameName: string,
  frame: Frame,
  deadline: number,
): Promise<readonly string[] | undefined> {
  const values: string[] = [];
  for (let index = 0; index < LOGIN_FIELD_DEFINITIONS.length; index += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return undefined;
    try {
      const value = await frame
        .locator('input[type="password"]:visible')
        .nth(index)
        .inputValue({ timeout: remainingMs });
      values.push(value);
    } catch {
      return undefined;
    }

    const currentFrame = page.frame({ name: frameName });
    if (currentFrame !== frame) return undefined;
  }
  return values;
}

async function verifyCurrentLoginForm(
  page: Page,
  frameName: string,
  expectedValues: readonly string[],
  deadline: number,
  frame: Frame,
): Promise<boolean> {
  const readback = await readLoginFieldValues(page, frameName, frame, deadline);
  return (
    readback !== undefined &&
    loginValuesMatch(readback, expectedValues) &&
    page.frame({ name: frameName }) === frame
  );
}

/** Fill the three login fields with a bounded retry after an observed detach. */
export async function fillFubonLoginCredentials(
  page: Page,
  values: FubonLoginCredentialValues,
  options: FubonLoginFillOptions = {},
): Promise<void> {
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
      page,
      frameName,
      deadline,
      retryIntervalMs,
    );
    if (currentFrame && currentFrame !== frame) {
      const readinessRemainingMs = deadline - Date.now();
      if (readinessRemainingMs <= 0) break;
      await waitForFubonLoginDocument(page, {
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
      visibleFieldCount = await boundedLocatorCount(visibleFields, deadline);
    } catch (error) {
      lastError = error;
      const current = page.frame({ name: frameName });
      if (current && current !== frame) {
        const readinessRemainingMs = deadline - Date.now();
        if (readinessRemainingMs <= 0) break;
        await waitForFubonLoginDocument(page, {
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
      await waitForFubonLoginDocument(page, {
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
      await field.waitFor({
        state: "visible",
        timeout: Math.min(remainingMs, 5_000),
      });
      const fillTimeoutMs = deadline - Date.now();
      if (fillTimeoutMs <= 0) break;
      await field.fill(value, { timeout: fillTimeoutMs });
    } catch (error) {
      lastError = error;
      const current = page.frame({ name: frameName });
      if (current && current !== frame) {
        const readinessRemainingMs = deadline - Date.now();
        if (readinessRemainingMs <= 0) break;
        await waitForFubonLoginDocument(page, {
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
        await page.waitForTimeout(Math.min(retryIntervalMs, retryRemainingMs));
      }
      continue;
    }

    const current = page.frame({ name: frameName });
    if (current && current !== frame) {
      const readinessRemainingMs = deadline - Date.now();
      if (readinessRemainingMs <= 0) break;
      await waitForFubonLoginDocument(page, {
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
          page,
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
  page: Page,
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
  const frame = page.frame({ name: frameName });
  if (!frame) {
    return { status: "reacquire-human-assistance", reason: "frame-missing" };
  }
  const before =
    options.before ?? options.assistanceBefore ?? options.beforeSnapshot;
  let current: FubonLoginAssistanceSnapshot | undefined;
  try {
    current = await readFubonLoginGeneration(page, {
      frameName,
      timeoutMs,
    });
  } catch (error) {
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
    const prepared = await frame.locator("html").evaluate(
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
      { timeout: timeoutMs },
    );
    if (prepared.status !== "ready-to-submit") return prepared;

    // From this point onward the browser task may invoke the bank submit
    // handler. Any transport/detach/timeout rejection is therefore fenced as
    // uncertain, even if the browser cannot report whether click ran.
    submitInvocationStarted = true;
    return await frame.locator("html").evaluate(
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
      { timeout: timeoutMs },
    );
  } catch (error) {
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
  page: Page,
  options: FubonCurrentFrameSubmitOptions = {},
): Promise<FubonCurrentFrameOtpResult> {
  const frameName = options.frameName ?? FUBON_LOGIN_FRAME_NAME;
  const timeoutMs = Math.max(
    1,
    options.timeoutMs ?? DEFAULT_CURRENT_FRAME_TRANSACTION_TIMEOUT_MS,
  );
  const frame = page.frame({ name: frameName });
  if (!frame) {
    return { status: "reacquire-human-assistance", reason: "frame-missing" };
  }
  const before =
    options.before ?? options.assistanceBefore ?? options.beforeSnapshot;
  if (before) {
    let current: FubonLoginAssistanceSnapshot | undefined;
    try {
      current = await readFubonLoginGeneration(page, {
        frameName,
        timeoutMs,
      });
    } catch (error) {
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
    return await frame.locator("html").evaluate(
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
      { timeout: timeoutMs },
    );
  } catch (error) {
    return {
      status: "reacquire-human-assistance",
      reason: isRecoverableLoginFrameError(error)
        ? "frame-detached"
        : "deadline",
    };
  }
}

async function emitFubonCaptchaAssistance(page: Page): Promise<void> {
  const deadline = Date.now() + DEFAULT_LOGIN_FILL_TIMEOUT_MS;
  const frame = await waitForLoginFrame(
    page,
    FUBON_LOGIN_FRAME_NAME,
    deadline,
    DEFAULT_LOGIN_FILL_RETRY_INTERVAL_MS,
  );
  await frame.locator("#m1_userCaptcha").focus();
  await emitHumanAssistanceStage({
    stageId: "fubon-login-captcha",
    title: "Enter the Fubon CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "fubon.login.captcha-input",
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
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "fubon.login.captcha-image",
      locator: frame.locator('img[src*="captchaImage"]:visible').first(),
    },
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: {
      targetId: "captcha-input",
      contextRegionIds: ["captcha-challenge"],
      initialZoom: 1.15,
    },
  });
}

async function emitFubonOtpAssistance(page: Page): Promise<void> {
  const deadline = Date.now() + DEFAULT_LOGIN_FILL_TIMEOUT_MS;
  const frame = await waitForLoginFrame(
    page,
    FUBON_LOGIN_FRAME_NAME,
    deadline,
    DEFAULT_LOGIN_FILL_RETRY_INTERVAL_MS,
  );
  await emitHumanAssistanceStage({
    stageId: "fubon-login-otp",
    title: "Enter the Fubon OTP",
    targets: [
      {
        id: "otp-input",
        label: "OTP input",
        semanticId: "fubon.login.otp-input",
        modes: ["click", "type"],
        locator: frame.locator("#m1_inputOTP"),
      },
    ],
    contextRegions: [
      {
        id: "otp-challenge",
        label: "OTP instructions",
        semanticId: "fubon.login.otp-challenge",
      },
    ],
    completion: { mode: "inline", targetIds: ["otp-input"] },
    focus: {
      targetId: "otp-input",
      contextRegionIds: ["otp-challenge"],
      initialZoom: 1.15,
    },
  });
}

async function currentOtpChallengeVisible(
  page: Page,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frame({ name: FUBON_LOGIN_FRAME_NAME });
    if (
      frame &&
      (await frame
        .locator("#m1_inputOTP")
        .isVisible()
        .catch(() => false))
    ) {
      return true;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await page.waitForTimeout(Math.min(100, remainingMs));
    }
  }
  return false;
}

/** Shared human-authentication transaction for every Fubon product workflow. */
async function completeFubonHumanLoginAttempt(
  page: Page,
  session: string,
  values: FubonLoginCredentialValues,
): Promise<void> {
  const dialogs = captureFubonLoginDialogs(page);
  try {
    let outcomeWindowStarted = false;
    let assistanceBefore: FubonLoginAssistanceSnapshot | undefined;
    const submit = await runFubonCaptchaAcquisition({
      prepare: async () => {
        await prepareFubonLoginDocument(page);
        await fillFubonLoginCredentials(page, values);
        assistanceBefore = await readFubonLoginGeneration(page);
        if (!assistanceBefore) {
          throw new Error(
            "Fubon login frame disappeared while preparing assistance.",
          );
        }
        return assistanceBefore;
      },
      assistAndPause: async () => {
        if (!outcomeWindowStarted) {
          dialogs.beginOutcomeWindow();
          outcomeWindowStarted = true;
        }
        await emitFubonCaptchaAssistance(page);
        console.log(
          "manual-auth-required: enter the CAPTCHA in the browser, then run `npx libretto resume --session " +
            session +
            "`.",
        );
        await pause(session);
      },
      submit: async () => {
        if (
          dialogs.messages.length > 0 ||
          dialogs.terminalReason !== undefined
        ) {
          await waitForFubonPostLoginOutcome(page, {
            dialogChannel: dialogs,
          });
        }
        const result = await submitFubonCaptchaFromCurrentFrame(page, values, {
          before: assistanceBefore,
        });
        if (result.status === "reacquire-human-assistance") {
          console.log("fubon-login-human-reacquire", {
            stage: "captcha",
            reason: result.reason,
          });
        }
        return result;
      },
    });

    if (submit.status === "submit-outcome-uncertain") {
      throw new FubonSubmitOutcomeUncertainError(submit.reason);
    }
    if (submit.status !== "submitted") {
      throw new Error(
        `Fubon CAPTCHA assistance retry bound reached (${submit.reason ?? "reacquire"}).`,
      );
    }

    if (await currentOtpChallengeVisible(page)) {
      for (;;) {
        const otpBefore = await readFubonLoginGeneration(page);
        await emitFubonOtpAssistance(page);
        console.log(
          "manual-otp-required: complete OTP in the browser, then run `npx libretto resume --session " +
            session +
            "`.",
        );
        await pause(session);
        const otp = await inspectFubonOtpFromCurrentFrame(page, {
          before: otpBefore,
        });
        if (otp.status === "ready" || otp.status === "no-challenge") break;
        console.log("fubon-login-human-reacquire", {
          stage: "otp",
          reason: otp.reason,
        });
      }
    }

    await waitForFubonPostLoginOutcome(page, { dialogChannel: dialogs });
  } finally {
    dialogs.dispose();
  }
}

export async function completeFubonHumanLogin(
  page: Page,
  session: string,
  values: FubonLoginCredentialValues,
): Promise<void> {
  await completeFubonHumanLoginAttempt(page, session, values);
}

function emitOutcome(
  status: "success" | "rejected" | "timeout",
  reason: string,
) {
  console.log("fubon-login-outcome", { status, reason });
}

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value).padStart(4, "0");
  }
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  return /^\d{3,8}$/.test(code) ? code : undefined;
}

function errorCodeFromDialog(message: string): string | undefined {
  const labeled = message.match(
    /(?:errorCode|error code|錯誤代碼|錯誤碼)\s*[:=]?\s*(\d{3,8})/i,
  );
  return normalizeErrorCode(labeled?.[1]);
}

function latestDialogMessage(
  dialogChannel: FubonLoginDialogChannel | undefined,
): string | undefined {
  if (!dialogChannel || dialogChannel.messages.length === 0) return undefined;
  return dialogChannel.messages[dialogChannel.messages.length - 1];
}

type FubonDialogType = "alert" | "confirm" | "prompt" | "beforeunload";

function normalizeDialogText(message: string): string {
  return message
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/\s+/g, "");
}

/**
 * Fubon 0212 is the only confirm we are allowed to accept automatically. The
 * classifier intentionally requires duplicate-login semantics; a generic
 * confirmation must never be accepted on behalf of the account holder.
 */
function isFubonDuplicateLoginConfirm(message: string): boolean {
  const normalized = normalizeDialogText(message);
  const exact0212 =
    /(?:^|[^0-9a-z])0*212(?:$|[^0-9a-z])/.test(normalized) ||
    /(?:errorcode|錯誤代碼|錯誤碼)[:=]?0*212(?:$|[^0-9a-z])/.test(normalized);
  if (exact0212) return true;

  const hasExplicitAction =
    /是否|確定|確認|繼續|仍要|(?:^|[^a-z])(?:continue|proceed|confirm|yes)(?:$|[^a-z])/.test(
      normalized,
    );
  if (!hasExplicitAction) return false;

  const historicalOrEnded =
    /曾|曾經|歷史|過去|之前|先前|已登出|登出|previous|formerly|history|loggedout|signedout/.test(
      normalized,
    );
  if (historicalOrEnded) return false;

  const duplicateLoginSemantics = /重複登入|重覆登入|重複登錄|重覆登錄/.test(
    normalized,
  );
  if (duplicateLoginSemantics) return true;

  const otherDeviceLoginSemantics =
    /(?:其他|另一|別的)(?:裝置|設備|瀏覽器|地方|處).*(?:登入|登錄)/.test(
      normalized,
    ) ||
    /(?:登入|登錄).*(?:其他|另一|別的)(?:裝置|設備|瀏覽器|地方|處)/.test(
      normalized,
    ) ||
    /(?:another|other)(?:device|browser|session).*(?:login|loggedin)/.test(
      normalized,
    ) ||
    /(?:login|loggedin).*(?:another|other)(?:device|browser|session)/.test(
      normalized,
    ) ||
    /alreadyloggedin/.test(normalized);
  return otherDeviceLoginSemantics;
}

function sanitizedDialogAlert(message: string): string {
  const errorCode = errorCodeFromDialog(message);
  if (/操作逾時|頁面閒置過久/.test(normalizeDialogText(message))) {
    return "errorCode0240";
  }
  return errorCode ? `errorCode${errorCode}` : "dialog-alert";
}

function throwDialogTerminal(
  reason: "duplicate-takeover-repeated" | "unknown-confirm",
): never {
  emitOutcome("rejected", reason);
  throw new FubonLoginRejectedError(reason, undefined);
}

/**
 * Capture bank dialogs through login. Alerts are accepted to unblock the bank
 * and retained only as sanitized categories/codes. The one evidence-backed
 * Fubon 0212 duplicate-login confirm is accepted at most once; repeated or
 * unknown confirms are dismissed and become terminal. Raw dialog text never
 * leaves this handler.
 */
export function captureFubonLoginDialogs(page: Page): FubonLoginDialogChannel {
  const messages: string[] = [];
  let duplicateTakeoverAccepted = false;
  let terminalReason:
    "duplicate-takeover-repeated" | "unknown-confirm" | undefined;
  let disposed = false;
  const onDialog = async (dialog: Dialog): Promise<void> => {
    if (disposed) return;
    let message = "";
    let type: FubonDialogType | "unknown" = "unknown";
    try {
      message = dialog.message();
    } catch {
      // Keep the state machine fail-closed if the dialog disappears while it
      // is being inspected.
    }
    try {
      type = dialog.type() as FubonDialogType;
    } catch {
      type = "unknown";
    }

    if (type === "confirm") {
      if (isFubonDuplicateLoginConfirm(message) && !duplicateTakeoverAccepted) {
        // Mark before awaiting accept: a second event cannot cause a second
        // takeover attempt while the first browser dialog is being resolved.
        duplicateTakeoverAccepted = true;
        try {
          await dialog.accept();
        } catch {
          // The bank may close the dialog while the accept is in flight. The
          // at-most-once fence remains in force; outcome polling decides it.
        }
        return;
      }
      terminalReason = isFubonDuplicateLoginConfirm(message)
        ? "duplicate-takeover-repeated"
        : "unknown-confirm";
      try {
        await dialog.dismiss();
      } catch {
        // A concurrent navigation may have already dismissed it.
      }
      return;
    }

    if (type !== "alert") {
      terminalReason = "unknown-confirm";
      try {
        await dialog.dismiss();
      } catch {
        // A concurrent navigation may have already dismissed it.
      }
      return;
    }

    messages.push(sanitizedDialogAlert(message));
    try {
      await dialog.accept();
    } catch {
      // A concurrent navigation may have already dismissed it.
    }
  };

  page.on("dialog", onDialog);
  return {
    messages,
    get duplicateTakeoverAccepted() {
      return duplicateTakeoverAccepted;
    },
    get terminalReason() {
      return terminalReason;
    },
    beginOutcomeWindow: () => {
      messages.length = 0;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      page.off("dialog", onDialog);
    },
  };
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForFubonPostLoginOutcome(
  page: Page,
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
  const probe =
    options.probe ??
    ((actualPage: Page, context: FubonLoginProbeContext) =>
      probeFubonLoginPage(actualPage, context, options.frameName));

  while (Date.now() < deadline) {
    const terminalDialogReason = options.dialogChannel?.terminalReason;
    if (terminalDialogReason) {
      throwDialogTerminal(terminalDialogReason);
    }
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
      snapshot = await probe(page, {
        signal: controller.signal,
        timeoutMs: probeTimeoutMs,
      });
    } catch {
      snapshot = undefined;
    } finally {
      clearTimeout(timer);
    }

    const dialogMessage = latestDialogMessage(options.dialogChannel);
    const terminalDialogReasonAfterProbe =
      options.dialogChannel?.terminalReason;
    if (terminalDialogReasonAfterProbe) {
      throwDialogTerminal(terminalDialogReasonAfterProbe);
    }
    if (dialogMessage !== undefined) {
      throwDialogRejection(dialogMessage, snapshot);
    }

    const rejectionReason = rejectionForSnapshot(snapshot);
    if (rejectionReason) {
      emitOutcome("rejected", rejectionReason);
      throw new FubonLoginRejectedError(rejectionReason, snapshot?.errorCode);
    }

    if (authenticatedMarkerForSnapshot(snapshot)) {
      emitOutcome("success", "marker");
      return;
    }

    const remainingAfterProbe = deadline - Date.now();
    if (remainingAfterProbe <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingAfterProbe));
  }

  const terminalDialogReason = options.dialogChannel?.terminalReason;
  if (terminalDialogReason) {
    throwDialogTerminal(terminalDialogReason);
  }
  const dialogMessage = latestDialogMessage(options.dialogChannel);
  if (dialogMessage !== undefined) {
    throwDialogRejection(dialogMessage, undefined);
  }

  emitOutcome("timeout", "no-authenticated-outcome");
  throw new Error("Fubon post-login outcome timed out.");
}
