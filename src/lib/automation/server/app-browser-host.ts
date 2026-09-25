import { mkdir, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { WorkflowBrowserPort } from "../workflow-executor.ts";

export type AppWorkflowBrowserConnection = Readonly<{
  endpoint: string;
  targetId: string;
}>;

export type AppWorkflowBrowserLaunchOptions = Readonly<{
  acceptDownloads: false;
  args: string[];
  headless: false;
  locale: "zh-TW";
  viewport: { width: 1280; height: 900 };
}>;

export type AppWorkflowBrowserHostInput = Readonly<{
  taskId: string;
  taskRunId: string;
  signal: AbortSignal;
  userDataDirectory: string;
  startUrl?: string;
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
  headless: false,
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
    headless: false,
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
 * Opens one App-managed, visible Playwright page. Browser state is confined to
 * the existing 30-day cleanup root and is never exposed as a workflow file.
 */
export function createAppWorkflowBrowserPort(
  input: AppWorkflowBrowserHostInput,
): WorkflowBrowserPort {
  assertSafePathSegment(input.taskId);
  assertSafePathSegment(input.taskRunId);
  const userDataDirectory = join(
    input.userDataDirectory,
    "data",
    "automation",
    "browser-state",
    input.taskId,
  );
  const launch = input.launchPersistentContext ?? defaultPersistentContext;

  return {
    async withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
      input.signal.throwIfAborted();
      await mkdir(userDataDirectory, { recursive: true });
      await rm(join(userDataDirectory, "DevToolsActivePort"), { force: true });
      const context = await launch(userDataDirectory, {
        ...launchOptions,
        args: [...launchOptions.args],
      });
      if (input.signal.aborted) {
        await context.close().catch(() => {});
        input.signal.throwIfAborted();
      }
      const page = context.pages()[0] ?? await context.newPage();
      let connection: AppWorkflowBrowserConnection | null = null;
      try {
        const endpoint = await loopbackDevToolsEndpoint(
          userDataDirectory,
          input.signal,
          !input.launchPersistentContext,
        );
        if (!endpoint && !input.launchPersistentContext) {
          throw new Error("The App browser did not expose its required loopback worker endpoint.");
        }
        if (endpoint) {
          connection = { endpoint, targetId: await targetIdForPage(context, page) };
        }
      } catch (error) {
        await context.close().catch(() => {});
        throw error;
      }
      const unregister = registerHostedPage(input.taskRunId, page, connection);
      const closeOnAbort = () => {
        void context.close().catch(() => {});
      };
      input.signal.addEventListener("abort", closeOnAbort, { once: true });
      try {
        input.signal.throwIfAborted();
        if (input.startUrl) {
          await page.goto(input.startUrl, { waitUntil: "domcontentloaded" });
          input.signal.throwIfAborted();
        }
        return await run(page);
      } finally {
        input.signal.removeEventListener("abort", closeOnAbort);
        unregister();
        await context.close().catch(() => {});
        const lastUsed = new Date();
        await utimes(userDataDirectory, lastUsed, lastUsed).catch(() => {});
      }
    },
  };
}
