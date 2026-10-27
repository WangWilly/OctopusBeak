import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { chromium } from "playwright";
import { createPgliteOperationalProvider } from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { activeRunPageLookup, openActiveTaskRun } from "./active-task-run.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import { workflowBrowserProfileForTask } from "./app-workflow-registry.ts";
import {
  BrowserRuntimeConfigurationError,
  createBrowserRuntime,
} from "./browser-runtime.ts";
import {
  createAppWorkflowBrowserPort,
  cookiesForAppWorkflowBrowserProfile,
  withAppWorkflowBrowserPage,
} from "./app-browser-host.ts";

const database = await createTestPGlite("operational");
after(() => database.close());
const persistence = createPgliteOperationalProvider(new PGliteStore(database)).automation;

/** An Active run with one Workflow execution begun, and the App's page lookup over that run. */
async function openHostedExecution(taskId: string) {
  const { taskRunId } = await persistence.createTaskRun({
    taskId, kind: "crawler", status: "preparing", attempt: 1, maxAttempts: 1, startedAt: new Date().toISOString(),
  });
  const run = openActiveTaskRun({
    run: (await persistence.taskRunById(taskRunId))!,
    persistence,
    runtime: createAutomationRuntimeState(),
  });
  const execution = run.beginExecution("round-1");
  const pageForRun = activeRunPageLookup((id) => id === taskRunId ? run : null);
  return { run, execution, taskRunId, pageForRun };
}

test("CTBC profile drops retained CTBC cookies but preserves unrelated browser state", () => {
  const cookies = [
    { name: "bank-session", value: "one", domain: "www.ctbcbank.com", path: "/" },
    { name: "bank-root", value: "two", domain: ".ctbcbank.com", path: "/" },
    { name: "other", value: "three", domain: "example.com", path: "/" },
  ];
  assert.deepEqual(cookiesForAppWorkflowBrowserProfile(cookies, "ctbc-login"), [cookies[2]]);
  assert.deepEqual(cookiesForAppWorkflowBrowserProfile(cookies), cookies);
});

test("Cathay login drops retained Cathay session cookies but keeps the trusted-device cookie", () => {
  const cookies = [
    { name: "old-session", value: "one", domain: "www.cathaybk.com.tw", path: "/" },
    { name: "shared-bank", value: "two", domain: ".cathaybk.com.tw", path: "/" },
    { name: "unrelated", value: "three", domain: "example.com", path: "/" },
    { name: "CUB.eBank.DeviceId", value: "synthetic-device", domain: ".cathaybk.com.tw", path: "/" },
  ];
  assert.deepEqual(cookiesForAppWorkflowBrowserProfile(cookies, "cathay-login"), [cookies[2], cookies[3]]);
  assert.deepEqual(cookiesForAppWorkflowBrowserProfile([cookies[3]], "ctbc-login"), [cookies[3]]);
});

test("E.SUN App execution starts without stale E.SUN session cookies", () => {
  const profile = workflowBrowserProfileForTask("esun-credit-card-statements");
  const cookies = [
    { name: "old-session", value: "synthetic", domain: "ebank.esunbank.com.tw", path: "/" },
    { name: "shared-session", value: "synthetic", domain: ".esunbank.com.tw", path: "/" },
    { name: "unrelated", value: "synthetic", domain: "example.com", path: "/" },
  ];
  assert.deepEqual(cookiesForAppWorkflowBrowserProfile(cookies, profile), [cookies[2]]);
});

test("CTBC headless profile adds only the verified browser compatibility flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctbc-browser-profile-"));
  const observed: string[][] = [];
  const userAgents: string[] = [];
  const identities: unknown[] = [];
  const runtime = createBrowserRuntime({
    getChromiumVersion: async () => "151.0.7922.34",
    platform: "darwin",
  });
  try {
    for (const browserProfile of [undefined, "ctbc-login"] as const) {
      await createAppWorkflowBrowserPort({
        taskId: "ctbc-statements",
        taskRunId: browserProfile ? "ctbc-profile" : "default-profile",
        signal: new AbortController().signal,
        userDataDirectory: root,
        credentialCodec: null,
        browserRuntime: runtime,
        onRuntimeIdentity: (identity) => identities.push(identity),
        ...(browserProfile ? { browserProfile } : {}),
        launchPersistentContext: async (_directory, options) => {
          observed.push(options.args);
          userAgents.push(options.userAgent ?? "");
          return { pages: () => [{}], close: async () => {} } as never;
        },
      }).withPage(async () => undefined);
    }
    assert.equal(observed.length, 2);
    assert.equal(observed[0].includes("--disable-blink-features=AutomationControlled"), false);
    assert.equal(observed[1].includes("--disable-blink-features=AutomationControlled"), true);
    assert.equal(observed[1].filter((arg) => arg === "--disable-blink-features=AutomationControlled").length, 1);
    assert.equal(userAgents[0], userAgents[1]);
    assert.match(userAgents[0], /Chrome\/151\.0\.7922\.34/u);
    assert.deepEqual(identities, [
      { profileId: "default", profileRevision: 1, chromiumVersion: "151.0.7922.34" },
      { profileId: "ctbc-login", profileRevision: 1, chromiumVersion: "151.0.7922.34" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("App runtime identity is available before browser launch fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-browser-runtime-launch-fail-"));
  const identities: unknown[] = [];
  try {
    const port = createAppWorkflowBrowserPort({
      taskId: "browser-runtime-launch-fail",
      taskRunId: "run-browser-runtime-launch-fail",
      signal: new AbortController().signal,
      userDataDirectory: root,
      credentialCodec: null,
      browserRuntime: createBrowserRuntime({
        getChromiumVersion: async () => "151.0.7922.34",
        platform: "darwin",
      }),
      onRuntimeIdentity: (identity) => identities.push(identity),
      launchPersistentContext: async () => { throw new Error("synthetic launch failure"); },
    });

    await assert.rejects(port.withPage(async () => undefined), /synthetic launch failure/u);
    assert.deepEqual(identities, [
      { profileId: "default", profileRevision: 1, chromiumVersion: "151.0.7922.34" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported App browser profiles fail before launch with a sanitized code", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-browser-runtime-unsupported-"));
  let launchCalls = 0;
  let identityCalls = 0;
  try {
    const port = createAppWorkflowBrowserPort({
      taskId: "browser-runtime-unsupported",
      taskRunId: "run-browser-runtime-unsupported",
      signal: new AbortController().signal,
      userDataDirectory: root,
      credentialCodec: null,
      browserProfile: "future-login" as never,
      onRuntimeIdentity: () => { identityCalls += 1; },
      launchPersistentContext: async () => {
        launchCalls += 1;
        throw new Error("launch should not run");
      },
    });

    await assert.rejects(port.withPage(async () => undefined), (error: unknown) => {
      assert.ok(error instanceof BrowserRuntimeConfigurationError);
      assert.equal(error.code, "unsupported-profile");
      assert.equal(error.message, "browser-runtime/unsupported-profile");
      return true;
    });
    assert.equal(launchCalls, 0);
    assert.equal(identityCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the production App browser launches headlessly with a worker CDP target", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-browser-headless-"));
  const { execution, taskRunId } = await openHostedExecution("browser-headless-check");
  try {
    await createAppWorkflowBrowserPort({
      taskId: "browser-headless-check",
      taskRunId,
      signal: new AbortController().signal,
      userDataDirectory: root,
      credentialCodec: null,
      execution,
    }).withPage(async (page) => {
      await page.setContent("<title>headless-ready</title>");
      assert.equal(await page.title(), "headless-ready");
      assert.ok(execution.browserConnection());
    });
    assert.equal(execution.browserConnection(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("App worker attaches to its exact hosted page without creating workflow files", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-browser-host-cdp-"));
  const { execution, taskRunId: runId, pageForRun } = await openHostedExecution("browser-host-check");
  const browserStateDirectory = join(root, "data", "automation", "browser-state", "browser-host-check");
  const legacyCacheFile = join(browserStateDirectory, "Default", "Cache", "data_0");
  await mkdir(join(browserStateDirectory, "Default", "Cache"), { recursive: true });
  await writeFile(legacyCacheFile, "legacy raw response cache");
  const credentialCodec = {
    encrypt: (value: string) => `sealed:${Buffer.from(value, "utf8").toString("base64")}`,
    decrypt: (value: string) => Buffer.from(value.replace(/^sealed:/u, ""), "base64").toString("utf8"),
  };
  let runtimeProfile: string | null = null;
  const browserPort = createAppWorkflowBrowserPort({
    taskId: "browser-host-check",
    taskRunId: runId,
    signal: new AbortController().signal,
    userDataDirectory: root,
    credentialCodec,
    execution,
    launchPersistentContext: async (userDataDirectory, options) => {
      assert.equal(options.headless, true, "App workflow browser must default to headless");
      runtimeProfile = userDataDirectory;
      return await chromium.launchPersistentContext(userDataDirectory, {
        ...options,
        headless: true,
      });
    },
  });

  try {
    await browserPort.withPage(async (ownerPage) => {
      assert.equal(pageForRun(runId), ownerPage);
      await ownerPage.context().addCookies([{
        name: "session",
        value: "cookie-secret-marker",
        url: "http://127.0.0.1/",
      }]);
      await ownerPage.setContent('<input id="shared" value="owner">');
      const siblingPage = await ownerPage.context().newPage();
      await siblingPage.setContent('<input id="shared" value="sibling">');

      const connection = execution.browserConnection();
      assert.ok(connection);
      assert.match(connection.endpoint, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/u);
      assert.ok(connection.targetId.length > 0);

      const attachedValue = await withAppWorkflowBrowserPage(connection, async (workerPage) => {
        assert.equal(await workerPage.locator("#shared").inputValue(), "owner");
        await workerPage.locator("#shared").fill("worker");
        return await workerPage.locator("#shared").inputValue();
      });
      assert.equal(attachedValue, "worker");
      assert.equal(await ownerPage.locator("#shared").inputValue(), "worker");
      assert.equal(await siblingPage.locator("#shared").inputValue(), "sibling");
      assert.equal(pageForRun(runId), ownerPage);

      await assert.rejects(
        withAppWorkflowBrowserPage({ ...connection, targetId: "missing-target" }, async () => undefined),
        /exact App browser page is unavailable/u,
      );

      const downloadObserved = ownerPage.waitForEvent("download");
      await ownerPage.setContent('<a download="fixture.csv" href="data:text/csv,fixture">fixture</a>');
      await ownerPage.locator("a").click();
      const download = await downloadObserved;
      await assert.rejects(download.createReadStream(), /acceptDownloads/u);
    });

    assert.equal(pageForRun(runId), null);
    assert.equal(execution.browserConnection(), null);
    assert.deepEqual(await readdir(join(root, "data", "automation")), ["browser-state"]);
    const stateFiles = await readdir(join(root, "data", "automation", "browser-state", "browser-host-check"), {
      recursive: true,
    });
    assert.deepEqual(stateFiles.sort(), [
      "authentication",
      join("authentication", "cookies.safeStorage.json"),
    ]);
    const cookieState = await readFile(
      join(browserStateDirectory, "authentication", "cookies.safeStorage.json"),
      "utf8",
    );
    assert.match(cookieState, /sealed:/u);
    assert.doesNotMatch(cookieState, /cookie-secret-marker|session/u);
    assert.equal((await stat(join(browserStateDirectory, "authentication", "cookies.safeStorage.json"))).mode & 0o777, 0o600);
    assert.ok(runtimeProfile);
    assert.match(runtimeProfile, /browser-runtime/u);
    await assert.rejects(stat(runtimeProfile), { code: "ENOENT" });

    const secondRunId = "run-app-browser-host-cookie-restore";
    const restorePort = createAppWorkflowBrowserPort({
      taskId: "browser-host-check",
      taskRunId: secondRunId,
      signal: new AbortController().signal,
      userDataDirectory: root,
      credentialCodec,
      launchPersistentContext: async (userDataDirectory, options) =>
        await chromium.launchPersistentContext(userDataDirectory, {
          ...options,
          headless: true,
        }),
    });
    await restorePort.withPage(async (restoredPage) => {
      const restored = await restoredPage.context().cookies("http://127.0.0.1/");
      assert.equal(restored.find((cookie) => cookie.name === "session")?.value, "cookie-secret-marker");
    });
    assert.deepEqual(await readdir(join(root, "data", "automation")), ["browser-state"]);
    assert.deepEqual(
      (await readdir(browserStateDirectory, { recursive: true })).sort(),
      ["authentication", join("authentication", "cookies.safeStorage.json")],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an active page without loopback CDP metadata gives the worker no connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-browser-host-unavailable-"));
  const { execution, taskRunId: runId, pageForRun } = await openHostedExecution("browser-host-check");
  const page = {} as never;
  const browserPort = createAppWorkflowBrowserPort({
    taskId: "browser-host-check",
    taskRunId: runId,
    signal: new AbortController().signal,
    userDataDirectory: root,
    credentialCodec: null,
    execution,
    launchPersistentContext: async () => ({
      pages: () => [page],
      close: async () => {},
    }) as never,
  });

  try {
    await browserPort.withPage(async () => {
      assert.equal(pageForRun(runId), page);
      assert.equal(execution.browserConnection(), null);
    });
    assert.equal(pageForRun(runId), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid retained cookies are ignored and cookie symlinks are never followed", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-browser-host-cookie-guard-"));
  const runId = "run-app-browser-host-cookie-guard";
  const cookieStatePath = join(
    root,
    "data",
    "automation",
    "browser-state",
    "browser-host-check",
    "authentication",
    "cookies.safeStorage.json",
  );
  const external = join(root, "external-cookie-state");
  const codec = {
    encrypt: (value: string) => `sealed:${Buffer.from(value, "utf8").toString("base64")}`,
    decrypt: (value: string) => Buffer.from(value.replace(/^sealed:/u, ""), "base64").toString("utf8"),
  };
  const page = {} as never;
  let addCookiesCalls = 0;
  const context = {
    pages: () => [page],
    addCookies: async () => { addCookiesCalls += 1; },
    cookies: async () => [],
    close: async () => {},
  };
  const createPort = (taskRunId: string) => createAppWorkflowBrowserPort({
    taskId: "browser-host-check",
    taskRunId,
    signal: new AbortController().signal,
    userDataDirectory: root,
    credentialCodec: codec,
    launchPersistentContext: async () => context as never,
  });

  try {
    await mkdir(join(cookieStatePath, ".."), { recursive: true });
    await writeFile(cookieStatePath, JSON.stringify({
      format: "octopusbeak.browser-auth.cookies.safeStorage.v1",
      data: codec.encrypt(JSON.stringify({ cookies: [{ name: "partial", value: "invalid" }] })),
    }));
    await createPort(runId).withPage(async () => undefined);
    assert.equal(addCookiesCalls, 0, "incomplete cookie objects must be rejected as a whole");

    await writeFile(external, "external state must not be read");
    await rm(cookieStatePath, { force: true });
    await symlink(external, cookieStatePath);
    await createPort("run-app-browser-host-cookie-symlink").withPage(async () => undefined);
    assert.equal(addCookiesCalls, 0, "symlinked cookie state must be ignored");
    assert.equal(await readFile(external, "utf8"), "external state must not be read");
    assert.equal((await stat(cookieStatePath)).isFile(), true, "save replaces the symlink without following it");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("App connection leaves native dialogs to the attached worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-dialog-owner-"));
  const { execution, taskRunId: runId } = await openHostedExecution("sinopac-statements");
  try {
    await createAppWorkflowBrowserPort({
      taskId: "sinopac-statements", taskRunId: runId,
      signal: new AbortController().signal, userDataDirectory: root, credentialCodec: null,
      nativeDialogOwner: "worker", execution,
    }).withPage(async () => {
      const connection = execution.browserConnection();
      assert.ok(connection);
      await withAppWorkflowBrowserPage(connection, async (page) => {
        let dismissal!: Promise<void>;
        page.once("dialog", (dialog) => { dismissal = dialog.dismiss(); });
        await page.evaluate(() => alert("驗證碼失效或輸入錯誤，請重新輸入。"));
        await assert.doesNotReject(dismissal, "the host must not dismiss the worker's dialog first");
      });
    });
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("the App page lookup serves a page only to its own run while its execution holds it", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-browser-host-lookup-"));
  const { run, execution, taskRunId, pageForRun } = await openHostedExecution("browser-host-check");
  const other = await openHostedExecution("browser-host-check");
  const portFor = (holder: typeof execution) => createAppWorkflowBrowserPort({
    taskId: "browser-host-check",
    taskRunId,
    signal: new AbortController().signal,
    userDataDirectory: root,
    credentialCodec: null,
    execution: holder,
  });
  try {
    assert.equal(pageForRun(taskRunId), null, "no page before the host opens one");
    await portFor(execution).withPage(async (page) => {
      assert.equal(pageForRun(taskRunId), page);
      assert.equal(other.pageForRun(other.taskRunId), null, "another run's lookup never sees this page");
      assert.equal(pageForRun(other.taskRunId), null);
      execution.end();
      assert.equal(pageForRun(taskRunId), null, "ending the execution releases its page while the browser is still open");
      assert.equal(page.isClosed(), false);
    });
    assert.equal(pageForRun(taskRunId), null);

    await assert.rejects(
      portFor(execution).withPage(async () => assert.fail("an ended execution cannot host a page")),
      /round-1 has ended/u,
    );
    const second = run.beginExecution("round-2");
    assert.equal(pageForRun(taskRunId), null, "a later execution starts without the earlier page");
    await portFor(second).withPage(async (page) => {
      assert.equal(pageForRun(taskRunId), page);
    });
    assert.equal(pageForRun(taskRunId), null, "closing the page releases it");
    second.end();
  } finally {
    other.execution.end();
    await rm(root, { recursive: true, force: true });
  }
});
