import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { WorkflowBrowserPort } from "../workflow-executor.ts";
import {
  getAutomationCredentialCodec,
  type AutomationCredentialCodec,
} from "./config-files.ts";
import {
  browserRuntime,
  cookieResetDomainForBrowserProfile,
  type BrowserRuntime,
  type BrowserRuntimeIdentity,
  type BrowserRuntimeProfileId,
} from "./browser-runtime.ts";

export type {
  BrowserRuntimeIdentity,
  BrowserRuntimeProfileId,
} from "./browser-runtime.ts";

export type AppWorkflowBrowserConnection = Readonly<{
  endpoint: string;
  targetId: string;
}>;

export type AppWorkflowBrowserProfile = BrowserRuntimeProfileId;

export type AppWorkflowBrowserLaunchOptions = Readonly<{
  acceptDownloads: false;
  args: string[];
  headless: true;
  locale: "zh-TW";
  viewport: { width: 1280; height: 900 };
  userAgent?: string;
}>;

export type AppWorkflowBrowserHostInput = Readonly<{
  taskId: string;
  taskRunId: string;
  signal: AbortSignal;
  userDataDirectory: string;
  credentialCodec?: AutomationCredentialCodec | null;
  startUrl?: string;
  browserProfile?: AppWorkflowBrowserProfile;
  browserRuntime?: BrowserRuntime;
  onRuntimeIdentity?: (identity: BrowserRuntimeIdentity) => void;
  /** Suppress Playwright auto-dismiss in the host connection when a worker owns dialogs. */
  nativeDialogOwner?: "worker";
  launchPersistentContext?: (
    userDataDirectory: string,
    options: AppWorkflowBrowserLaunchOptions,
  ) => Promise<BrowserContext>;
}>;

type HostedPage = Readonly<{
  page: Page;
  connection: AppWorkflowBrowserConnection | null;
}>;

const hostedPages = new Map<string, HostedPage>();
const COOKIE_STATE_FORMAT = "octopusbeak.browser-auth.cookies.safeStorage.v1";
const COOKIE_STATE_MAX_BYTES = 1_048_576;
const COOKIE_STATE_MAX_COUNT = 512;
type AppBrowserCookie = Parameters<BrowserContext["addCookies"]>[0][number];

export function cookiesForAppWorkflowBrowserProfile(
  cookies: readonly AppBrowserCookie[],
  profile?: AppWorkflowBrowserProfile,
): AppBrowserCookie[] {
  const resetDomain = cookieResetDomainForBrowserProfile(profile);
  if (!resetDomain) return [...cookies];
  return cookies.filter((cookie) => {
    let domain = cookie.domain;
    if (!domain && cookie.url) {
      try { domain = new URL(cookie.url).hostname; } catch { return false; }
    }
    if (!domain) return false;
    domain = domain.replace(/^\./u, "").toLowerCase();
    return domain !== resetDomain && !domain.endsWith(`.${resetDomain}`);
  });
}
const remoteDebuggingArgs = [
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
];

function assertSafePathSegment(value: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(value)) {
    throw new Error("App browser host received an invalid identity.");
  }
}

/** The App viewer resolves its active page through this in-memory registry. */
export function appWorkflowPageForSession(session: string): Page | null {
  return hostedPages.get(session)?.page ?? null;
}

/** Returns a run-scoped CDP descriptor without persisting or logging it. */
export function appWorkflowBrowserConnectionForSession(
  session: string,
): AppWorkflowBrowserConnection | null {
  const hosted = hostedPages.get(session);
  if (!hosted) return null;
  if (!hosted.connection) {
    throw new Error("The App browser worker connection is unavailable for this active run.");
  }
  return { ...hosted.connection };
}

function registerHostedPage(
  session: string,
  page: Page,
  connection: AppWorkflowBrowserConnection | null,
) {
  if (hostedPages.has(session)) {
    throw new Error("An App browser page is already registered for this workflow run.");
  }
  const hosted = { page, connection };
  hostedPages.set(session, hosted);
  return () => {
    if (hostedPages.get(session) === hosted) hostedPages.delete(session);
  };
}

const launchOptions: AppWorkflowBrowserLaunchOptions = {
  headless: true,
  acceptDownloads: false,
  args: remoteDebuggingArgs,
  locale: "zh-TW",
  viewport: { width: 1280, height: 900 },
};

async function defaultPersistentContext(
  userDataDirectory: string,
  options: AppWorkflowBrowserLaunchOptions,
) {
  return await chromium.launchPersistentContext(userDataDirectory, {
    ...options,
    headless: true,
  });
}

async function removeDirectoryEntriesExcept(directory: string, retainedName: string) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (name === retainedName) continue;
    const path = join(directory, name);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await rm(path, { recursive: metadata.isDirectory() && !metadata.isSymbolicLink(), force: true });
  }
}

async function ensureDirectory(path: string) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      await rm(path, { recursive: metadata.isDirectory() && !metadata.isSymbolicLink(), force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path, { recursive: true });
  await chmod(path, 0o700);
}

async function readRetainedCookies(
  path: string,
  codec: AutomationCredentialCodec | null,
): Promise<AppBrowserCookie[]> {
  if (!codec) return [];
  let contents: string;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > COOKIE_STATE_MAX_BYTES) return [];
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
  try {
    const envelope = JSON.parse(contents) as { format?: unknown; data?: unknown };
    if (envelope.format !== COOKIE_STATE_FORMAT || typeof envelope.data !== "string") return [];
    const state = JSON.parse(codec.decrypt(envelope.data)) as { cookies?: unknown };
    if (!Array.isArray(state.cookies) || state.cookies.length > COOKIE_STATE_MAX_COUNT) return [];
    const cookies: AppBrowserCookie[] = [];
    for (const value of state.cookies) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const cookie = value as Record<string, unknown>;
      if (
        typeof cookie.name !== "string" || cookie.name.length === 0 || cookie.name.length > 4_096 ||
        typeof cookie.value !== "string" || Buffer.byteLength(cookie.value, "utf8") > COOKIE_STATE_MAX_BYTES ||
        typeof cookie.domain !== "string" || cookie.domain.length === 0 || cookie.domain.length > 2_048 ||
        typeof cookie.path !== "string" || cookie.path.length === 0 || cookie.path.length > 4_096
      ) return [];
      if (cookie.expires !== undefined && (typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires))) return [];
      if (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean") return [];
      if (cookie.secure !== undefined && typeof cookie.secure !== "boolean") return [];
      if (cookie.sameSite !== undefined && !["Strict", "Lax", "None"].includes(String(cookie.sameSite))) return [];
      if (cookie.partitionKey !== undefined && typeof cookie.partitionKey !== "string") return [];
      cookies.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        ...(typeof cookie.expires === "number" ? { expires: cookie.expires } : {}),
        ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
        ...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
        ...(cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None"
          ? { sameSite: cookie.sameSite }
          : {}),
        ...(typeof cookie.partitionKey === "string" ? { partitionKey: cookie.partitionKey } : {}),
      });
    }
    return cookies;
  } catch {
    // Invalid or unavailable retained authentication simply starts a clean login.
    return [];
  }
}

async function writeRetainedCookies(
  path: string,
  cookies: readonly AppBrowserCookie[],
  codec: AutomationCredentialCodec | null,
) {
  if (!codec || cookies.length > COOKIE_STATE_MAX_COUNT) return;
  const serialized = JSON.stringify({ cookies });
  if (Buffer.byteLength(serialized, "utf8") > COOKIE_STATE_MAX_BYTES) return;
  const envelope = JSON.stringify({
    format: COOKIE_STATE_FORMAT,
    data: codec.encrypt(serialized),
  });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, envelope, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function removeEmptyDirectory(path: string) {
  await rmdir(path).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOTDIR") throw error;
  });
}

async function loopbackDevToolsEndpoint(
  userDataDirectory: string,
  signal: AbortSignal,
  waitForEndpoint: boolean,
): Promise<string | null> {
  const activePortFile = join(userDataDirectory, "DevToolsActivePort");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const contents = await readFile(activePortFile, "utf8");
      const portLine = contents.split(/\r?\n/u)[0];
      if (!portLine || !/^[1-9]\d{0,4}$/u.test(portLine)) {
        throw new Error("The App browser did not publish a valid loopback endpoint.");
      }
      const port = Number(portLine);
      if (port > 65_535) throw new Error("The App browser did not publish a valid loopback endpoint.");
      return `http://127.0.0.1:${port}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!waitForEndpoint) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return null;
}

async function targetIdForPage(context: BrowserContext, page: Page): Promise<string> {
  const session = await context.newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    if (targetInfo.type !== "page" || typeof targetInfo.targetId !== "string" || !targetInfo.targetId) {
      throw new Error("The App browser page did not expose a valid target.");
    }
    return targetInfo.targetId;
  } finally {
    await session.detach().catch(() => {});
  }
}

function assertLoopbackConnection(connection: AppWorkflowBrowserConnection) {
  let endpoint: URL;
  try {
    endpoint = new URL(connection.endpoint);
  } catch {
    throw new Error("The App browser worker connection is invalid.");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    !connection.targetId ||
    connection.targetId.length > 200
  ) {
    throw new Error("The App browser worker connection is invalid.");
  }
}

/** Attaches to the exact App-owned page and disconnects without closing it. */
export async function withAppWorkflowBrowserPage<T>(
  connection: AppWorkflowBrowserConnection,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  assertLoopbackConnection(connection);
  let browser;
  try {
    browser = await chromium.connectOverCDP(connection.endpoint, { timeout: 5_000 });
  } catch {
    throw new Error("The active App browser endpoint is unavailable.");
  }

  try {
    let exactPage: Page | null = null;
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const session = await context.newCDPSession(page).catch(() => null);
        if (!session) continue;
        let targetId: string | null = null;
        try {
          const { targetInfo } = await session.send("Target.getTargetInfo");
          if (targetInfo.type === "page" && typeof targetInfo.targetId === "string") {
            targetId = targetInfo.targetId;
          }
        } catch {
          // Pages may close while the App is shutting down; keep searching active targets.
        } finally {
          await session.detach().catch(() => {});
        }
        if (targetId === connection.targetId) {
          exactPage = page;
          break;
        }
      }
      if (exactPage) break;
    }
    if (!exactPage) throw new Error("The exact App browser page is unavailable.");
    return await run(exactPage);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Opens one App-managed, headless Playwright page. Browser state is confined to
 * the existing 30-day cleanup root and is never exposed as a workflow file.
 */
export function createAppWorkflowBrowserPort(
  input: AppWorkflowBrowserHostInput,
): WorkflowBrowserPort {
  assertSafePathSegment(input.taskId);
  assertSafePathSegment(input.taskRunId);
  const browserStateDirectory = join(
    input.userDataDirectory,
    "data",
    "automation",
    "browser-state",
    input.taskId,
  );
  const authenticationDirectory = join(browserStateDirectory, "authentication");
  const cookieStatePath = join(authenticationDirectory, "cookies.safeStorage.json");
  const browserRuntimeRoot = join(input.userDataDirectory, "data", "automation", "browser-runtime");
  const browserRuntimeTaskDirectory = join(browserRuntimeRoot, input.taskId);
  const browserRuntimeDirectory = join(browserRuntimeTaskDirectory, input.taskRunId);
  const credentialCodec = input.credentialCodec === undefined
    ? getAutomationCredentialCodec()
    : input.credentialCodec;
  const launch = input.launchPersistentContext ?? defaultPersistentContext;
  const runtime = input.browserRuntime ?? browserRuntime;

  return {
    async withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
      let context: BrowserContext | null = null;
      let unregister = () => {};
      const closeOnAbort = () => {
        void context?.close().catch(() => {});
      };
      try {
        input.signal.throwIfAborted();
        const profileConfiguration = await runtime.resolve(input.browserProfile);
        input.onRuntimeIdentity?.(profileConfiguration.identity);
        await ensureDirectory(browserStateDirectory);
        await removeDirectoryEntriesExcept(browserStateDirectory, "authentication");
        await ensureDirectory(authenticationDirectory);
        await removeDirectoryEntriesExcept(authenticationDirectory, "cookies.safeStorage.json");
        const retainedCookies = await readRetainedCookies(cookieStatePath, credentialCodec);
        await ensureDirectory(browserRuntimeRoot);
        await ensureDirectory(browserRuntimeTaskDirectory);
        await rm(browserRuntimeDirectory, { recursive: true, force: true });
        await ensureDirectory(browserRuntimeDirectory);
        context = await launch(browserRuntimeDirectory, {
          ...launchOptions,
          args: [...launchOptions.args, ...profileConfiguration.args],
          userAgent: profileConfiguration.userAgent,
        });
        input.signal.throwIfAborted();
        const page = context.pages()[0] ?? await context.newPage();
        const cookiesToRestore = cookiesForAppWorkflowBrowserProfile(retainedCookies, input.browserProfile);
        if (cookiesToRestore.length > 0) {
          try {
            await context.addCookies(cookiesToRestore);
          } catch {
            // A rejected cookie jar is discarded for this run; the workflow may log in again.
          }
        }
        let connection: AppWorkflowBrowserConnection | null = null;
        const endpoint = await loopbackDevToolsEndpoint(
          browserRuntimeDirectory,
          input.signal,
          !input.launchPersistentContext,
        );
        if (!endpoint && !input.launchPersistentContext) {
          throw new Error("The App browser did not expose its required loopback worker endpoint.");
        }
        if (endpoint) {
          connection = { endpoint, targetId: await targetIdForPage(context, page) };
        }
        if (connection && input.nativeDialogOwner === "worker") {
          // Each CDP connection otherwise independently auto-dismisses dialogs.
          // The worker/provider observer supplies classification and dismissal.
          page.on("dialog", () => {});
        }
        unregister = registerHostedPage(input.taskRunId, page, connection);
        input.signal.addEventListener("abort", closeOnAbort, { once: true });
        input.signal.throwIfAborted();
        if (input.startUrl) {
          await page.goto(input.startUrl, { waitUntil: "domcontentloaded" });
          input.signal.throwIfAborted();
        }
        return await run(page);
      } finally {
        input.signal.removeEventListener("abort", closeOnAbort);
        unregister();
        if (credentialCodec && context) {
          try {
            const cookies = await context.cookies();
            await writeRetainedCookies(cookieStatePath, cookies, credentialCodec);
          } catch {
            // Never fall back to writing browser state in clear text.
          }
        }
        await context?.close().catch(() => {});
        const lastUsed = new Date();
        if (context) await utimes(browserStateDirectory, lastUsed, lastUsed).catch(() => {});
        await rm(browserRuntimeDirectory, { recursive: true, force: true }).catch(() => {});
        await removeEmptyDirectory(browserRuntimeTaskDirectory);
        await removeEmptyDirectory(browserRuntimeRoot);
      }
    },
  };
}
