import type { WorkflowContext, WorkflowDefinition } from "../workflow-executor.ts";

export const PACKAGED_BROWSER_FIXTURE_ENABLED_ENV = "OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE";
export const PACKAGED_BROWSER_FIXTURE_URL_ENV = "OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_URL";
export const PACKAGED_BROWSER_FIXTURE_EXPECTED_VERSION_ENV = "OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_EXPECTED_CHROMIUM_VERSION";
export const PACKAGED_BROWSER_FIXTURE_MARKER = "local-browser-ok";
export const PACKAGED_BROWSER_FIXTURE_EVENT = "fixture-page-verified";
export const PACKAGED_BROWSER_FIXTURE_RESULT_PREFIX = "OCTOPUSBEAK_PACKAGED_BROWSER_FIXTURE_RESULT ";
export const PACKAGED_BROWSER_FIXTURE_SUCCESS_SETTLE_MS = 1_000;

export const PACKAGED_BROWSER_FIXTURE_TASKS = [
  { taskId: "packaged-browser-fixture-success", workflowId: "packaged-browser-fixture-success" },
  { taskId: "packaged-browser-fixture-cancel", workflowId: "packaged-browser-fixture-cancel" },
] as const;

export type PackagedBrowserFixtureTask = typeof PACKAGED_BROWSER_FIXTURE_TASKS[number];

export function packagedBrowserFixtureEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[PACKAGED_BROWSER_FIXTURE_ENABLED_ENV] === "1";
}

/** Accept only the ephemeral loopback URL created by the packaged smoke harness. */
export function packagedBrowserFixtureStartUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!packagedBrowserFixtureEnabled(environment)) {
    throw new Error("Packaged browser fixture is disabled.");
  }
  const configured = environment[PACKAGED_BROWSER_FIXTURE_URL_ENV];
  if (!configured) throw new Error("Packaged browser fixture URL is missing.");
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("Packaged browser fixture URL is invalid.");
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("Packaged browser fixture URL must be an ephemeral loopback root URL.");
  }
  return url.href;
}

export function packagedBrowserFixtureExpectedVersion(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const version = environment[PACKAGED_BROWSER_FIXTURE_EXPECTED_VERSION_ENV];
  if (!version || !/^\d{2,3}\.\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error("Packaged browser fixture Chromium version is invalid.");
  }
  return version;
}

async function verifyFixturePage(context: WorkflowContext): Promise<void> {
  const marker = await context.browser.withPage(async (page) => {
    return await page.locator("#fixture").textContent();
  });
  if (marker !== PACKAGED_BROWSER_FIXTURE_MARKER) {
    throw new Error("Packaged browser fixture page verification failed.");
  }
  await context.event("collection", PACKAGED_BROWSER_FIXTURE_EVENT, {
    completed: 1,
    total: 1,
  });
}

async function waitForCancellation(context: WorkflowContext): Promise<never> {
  if (context.signal.aborted) context.signal.throwIfAborted();
  await new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    context.signal.addEventListener("abort", onAbort, { once: true });
  });
  context.signal.throwIfAborted();
  throw new Error("Packaged browser fixture cancellation was not observed.");
}

export function packagedBrowserFixtureDefinition(
  workflowId: PackagedBrowserFixtureTask["workflowId"],
): WorkflowDefinition {
  return {
    id: workflowId,
    requiresFinancialCommit: false,
    async run(context) {
      if (workflowId === "packaged-browser-fixture-success"
        && process.env.OCTOPUSBEAK_PACKAGED_RECOGNITION_FIXTURE === "1") {
        const { verifyPackagedRecognition } = await import("./packaged-recognition-fixture.ts");
        await verifyPackagedRecognition(context);
      }
      await verifyFixturePage(context);
      if (workflowId === "packaged-browser-fixture-cancel") {
        await waitForCancellation(context);
      }
      await new Promise((resolve) => setTimeout(resolve, PACKAGED_BROWSER_FIXTURE_SUCCESS_SETTLE_MS));
      return { status: "completed" };
    },
  };
}
