import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { AutomationPersistenceProvider, AutomationTaskRun } from "../src/lib/automation/server/store.ts";
import { appWorkflowPageForSession } from "../src/lib/automation/server/app-browser-host.ts";
import {
  PACKAGED_BROWSER_FIXTURE_EVENT,
  PACKAGED_BROWSER_FIXTURE_MARKER,
  PACKAGED_BROWSER_FIXTURE_TASKS,
  packagedBrowserFixtureExpectedVersion,
  packagedBrowserFixtureStartUrl,
} from "../src/lib/automation/server/packaged-browser-fixture.ts";
import {
  cancelAutomationTask,
  startAutomationTask,
} from "../src/lib/automation/server/runner.ts";

export type PackagedBrowserFixtureRunResult = Readonly<{
  status: "completed" | "cancelled";
  browserRuntime: Readonly<{
    profileId: string;
    profileRevision: number;
    chromiumVersion: string;
  }>;
  actualBrowserVersion: string;
  navigatorChromeVersion: string;
  navigatorChromeMajor: number;
  browserContextClosed: true;
  hostPageReleased: true;
  runtimeProfileDirectoryRemoved: true;
  recordSanitized: true;
}>;

export type PackagedBrowserFixtureResult = Readonly<{
  status: "passed";
  success: PackagedBrowserFixtureRunResult;
  cancel: PackagedBrowserFixtureRunResult;
}>;

type FixtureDependencies = Readonly<{
  startTask?: typeof startAutomationTask;
  cancelTask?: typeof cancelAutomationTask;
  pageForRun?: (runId: string) => Page | null;
  pathExists?: typeof existsSync;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}>;

const FIXTURE_TIMEOUT_MS = 45_000;
const TERMINAL_STATUSES = new Set<AutomationTaskRun["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function defaultWait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function assertRuntimeIdentity(run: AutomationTaskRun, expectedVersion: string) {
  const identity = run.browserRuntime;
  if (
    !identity
    || identity.profileId !== "default"
    || identity.profileRevision !== 1
    || identity.chromiumVersion !== expectedVersion
  ) {
    throw new Error("Packaged browser fixture runtime identity did not match the installed Chromium.");
  }
  return identity;
}

async function inspectLiveBrowser(page: Page, expectedVersion: string) {
  const browser = page.context().browser();
  if (!browser) throw new Error("Packaged browser fixture page has no owning browser.");
  const actualBrowserVersion = browser.version();
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const navigatorChromeVersion = /(?:^|\s)Chrome\/(\d{2,3}\.\d+\.\d+\.\d+)(?:\s|$)/u.exec(userAgent)?.[1];
  if (
    actualBrowserVersion !== expectedVersion
    || navigatorChromeVersion !== expectedVersion
  ) {
    throw new Error("Packaged browser fixture engine and navigator versions did not match the package.");
  }
  return {
    actualBrowserVersion,
    navigatorChromeVersion,
    navigatorChromeMajor: Number(navigatorChromeVersion.split(".", 1)[0]),
  };
}

async function waitForFixturePage(
  provider: AutomationPersistenceProvider,
  taskRunId: string,
  expectedVersion: string,
  dependencies: Required<Pick<FixtureDependencies, "pageForRun" | "wait" | "now">>,
): Promise<{
  run: AutomationTaskRun;
  page: Page;
  evidence: Awaited<ReturnType<typeof inspectLiveBrowser>>;
}> {
  const deadline = dependencies.now() + FIXTURE_TIMEOUT_MS;
  while (dependencies.now() < deadline) {
    const run = await provider.automation.taskRunById(taskRunId);
    if (!run) throw new Error("Packaged browser fixture task run disappeared.");
    if (run.events.some((event) => event.code === PACKAGED_BROWSER_FIXTURE_EVENT)) {
      assertRuntimeIdentity(run, expectedVersion);
      const page = dependencies.pageForRun(taskRunId);
      if (page) {
        return { run, page, evidence: await inspectLiveBrowser(page, expectedVersion) };
      }
    }
    if (TERMINAL_STATUSES.has(run.status)) {
      throw new Error("Packaged browser fixture ended before its local page could be inspected.");
    }
    await dependencies.wait(20);
  }
  throw new Error("Timed out waiting for the packaged browser fixture page.");
}

async function waitForTerminalRun(
  provider: AutomationPersistenceProvider,
  taskRunId: string,
  dependencies: Required<Pick<FixtureDependencies, "wait" | "now">>,
): Promise<AutomationTaskRun> {
  const deadline = dependencies.now() + FIXTURE_TIMEOUT_MS;
  while (dependencies.now() < deadline) {
    const run = await provider.automation.taskRunById(taskRunId);
    if (!run) throw new Error("Packaged browser fixture task run disappeared.");
    if (TERMINAL_STATUSES.has(run.status)) return run;
    await dependencies.wait(20);
  }
  throw new Error("Timed out waiting for packaged browser fixture completion.");
}

function summarizeFixtureRun(
  run: AutomationTaskRun,
  expectedStatus: "completed" | "cancelled",
  expectedVersion: string,
  userDataDirectory: string,
  startUrl: string,
  observedPage: Page,
  evidence: Awaited<ReturnType<typeof inspectLiveBrowser>>,
  dependencies: Required<Pick<FixtureDependencies, "pageForRun" | "pathExists">>,
): PackagedBrowserFixtureRunResult {
  const identity = assertRuntimeIdentity(run, expectedVersion);
  if (run.status !== expectedStatus) {
    throw new Error("Packaged browser fixture reached an unexpected terminal status.");
  }
  if (expectedStatus === "cancelled" && run.appWorkflowOutcome?.errorCode !== "cancelled") {
    throw new Error("Packaged browser fixture worker did not preserve its cancelled outcome.");
  }
  if (
    expectedStatus === "completed"
    && (run.appWorkflowOutcome?.errorCode !== null
      || run.appWorkflowOutcome.summary?.status !== "completed")
  ) {
    throw new Error("Packaged browser fixture success worker did not preserve its completed outcome.");
  }
  const browserContextClosed = observedPage.isClosed();
  const hostPageReleased = dependencies.pageForRun(run.taskRunId) === null;
  const runtimeDirectory = join(
    userDataDirectory,
    "data",
    "automation",
    "browser-runtime",
    run.taskId,
    run.taskRunId,
  );
  const runtimeProfileDirectoryRemoved = !dependencies.pathExists(runtimeDirectory);
  let recordIdentity: unknown;
  try {
    recordIdentity = (JSON.parse(run.recordJson) as { browserRuntime?: unknown }).browserRuntime;
  } catch {
    recordIdentity = undefined;
  }
  const recordSanitized =
    !!recordIdentity
    && typeof recordIdentity === "object"
    && !Array.isArray(recordIdentity)
    && Object.keys(recordIdentity).sort().join(",") === "chromiumVersion,profileId,profileRevision"
    && (recordIdentity as Record<string, unknown>).profileId === identity.profileId
    && (recordIdentity as Record<string, unknown>).profileRevision === identity.profileRevision
    && (recordIdentity as Record<string, unknown>).chromiumVersion === identity.chromiumVersion
    && !run.recordJson.includes(startUrl)
    && !run.recordJson.includes(PACKAGED_BROWSER_FIXTURE_MARKER)
    && !run.recordJson.includes("userAgent")
    && !run.recordJson.includes("launchArgs");
  if (!browserContextClosed || !hostPageReleased || !runtimeProfileDirectoryRemoved || !recordSanitized) {
    throw new Error("Packaged browser fixture cleanup or privacy assertion failed.");
  }
  return {
    status: expectedStatus,
    browserRuntime: {
      profileId: identity.profileId,
      profileRevision: identity.profileRevision,
      chromiumVersion: identity.chromiumVersion,
    },
    ...evidence,
    browserContextClosed: true,
    hostPageReleased: true,
    runtimeProfileDirectoryRemoved: true,
    recordSanitized: true,
  };
}

/** Run two synthetic workflows through the real App task runner and browser host. */
export async function runPackagedBrowserWorkerFixture(
  provider: AutomationPersistenceProvider,
  userDataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: FixtureDependencies = {},
): Promise<PackagedBrowserFixtureResult> {
  const expectedVersion = packagedBrowserFixtureExpectedVersion(environment);
  const startUrl = packagedBrowserFixtureStartUrl(environment);
  const startTask = dependencies.startTask ?? startAutomationTask;
  const cancelTask = dependencies.cancelTask ?? cancelAutomationTask;
  const requiredDependencies = {
    pageForRun: dependencies.pageForRun ?? appWorkflowPageForSession,
    pathExists: dependencies.pathExists ?? existsSync,
    wait: dependencies.wait ?? defaultWait,
    now: dependencies.now ?? Date.now,
  };

  const successTask = PACKAGED_BROWSER_FIXTURE_TASKS[0].taskId;
  const successStarted = await startTask(successTask, provider);
  const { page: successPage, evidence: successEvidence } = await waitForFixturePage(
    provider,
    successStarted.runId,
    expectedVersion,
    requiredDependencies,
  );
  const successRun = await waitForTerminalRun(provider, successStarted.runId, requiredDependencies);
  const success = summarizeFixtureRun(
    successRun,
    "completed",
    expectedVersion,
    userDataDirectory,
    startUrl,
    successPage,
    successEvidence,
    requiredDependencies,
  );

  const cancelTaskId = PACKAGED_BROWSER_FIXTURE_TASKS[1].taskId;
  const cancelStarted = await startTask(cancelTaskId, provider);
  const { page: cancelPage, evidence: cancelEvidence } = await waitForFixturePage(
    provider,
    cancelStarted.runId,
    expectedVersion,
    requiredDependencies,
  );
  await cancelTask(cancelTaskId, provider);
  const cancelledRun = await waitForTerminalRun(provider, cancelStarted.runId, requiredDependencies);
  const cancel = summarizeFixtureRun(
    cancelledRun,
    "cancelled",
    expectedVersion,
    userDataDirectory,
    startUrl,
    cancelPage,
    cancelEvidence,
    requiredDependencies,
  );
  return { status: "passed", success, cancel };
}
