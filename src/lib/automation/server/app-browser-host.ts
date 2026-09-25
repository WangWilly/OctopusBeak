import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { WorkflowBrowserPort } from "../workflow-executor.ts";

export type AppWorkflowBrowserHostInput = Readonly<{
  taskId: string;
  taskRunId: string;
  signal: AbortSignal;
  userDataDirectory: string;
  startUrl?: string;
  launchPersistentContext?: (userDataDirectory: string) => Promise<BrowserContext>;
}>;

const hostedPages = new Map<string, Page>();

function assertSafePathSegment(value: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(value)) {
    throw new Error("App browser host received an invalid identity.");
  }
}

/** The App viewer resolves its active page through this in-memory registry. */
export function appWorkflowPageForSession(session: string): Page | null {
  return hostedPages.get(session) ?? null;
}

function registerHostedPage(session: string, page: Page) {
  if (hostedPages.has(session)) {
    throw new Error("An App browser page is already registered for this workflow run.");
  }
  hostedPages.set(session, page);
  return () => {
    if (hostedPages.get(session) === page) hostedPages.delete(session);
  };
}

async function defaultPersistentContext(userDataDirectory: string) {
  return await chromium.launchPersistentContext(userDataDirectory, {
    headless: false,
    acceptDownloads: false,
    locale: "zh-TW",
    viewport: { width: 1280, height: 900 },
  });
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
      const context = await launch(userDataDirectory);
      if (input.signal.aborted) {
        await context.close().catch(() => {});
        input.signal.throwIfAborted();
      }
      const page = context.pages()[0] ?? await context.newPage();
      const unregister = registerHostedPage(input.taskRunId, page);
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
