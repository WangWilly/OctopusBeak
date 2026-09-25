import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  appWorkflowBrowserConnectionForSession,
  appWorkflowPageForSession,
  createAppWorkflowBrowserPort,
  withAppWorkflowBrowserPage,
} from "./app-browser-host.ts";

test("App worker attaches to its exact hosted page without creating workflow files", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-browser-host-cdp-"));
  const runId = "run-app-browser-host-cdp-check";
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
    launchPersistentContext: async (userDataDirectory, options) => {
      runtimeProfile = userDataDirectory;
      return await chromium.launchPersistentContext(userDataDirectory, {
        ...options,
        headless: true,
      });
    },
  });

  try {
    await browserPort.withPage(async (ownerPage) => {
      assert.equal(appWorkflowPageForSession(runId), ownerPage);
      await ownerPage.context().addCookies([{
        name: "session",
        value: "cookie-secret-marker",
        url: "http://127.0.0.1/",
      }]);
      await ownerPage.setContent('<input id="shared" value="owner">');
      const siblingPage = await ownerPage.context().newPage();
      await siblingPage.setContent('<input id="shared" value="sibling">');

      const connection = appWorkflowBrowserConnectionForSession(runId);
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
      assert.equal(appWorkflowPageForSession(runId), ownerPage);

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

    assert.equal(appWorkflowPageForSession(runId), null);
    assert.equal(appWorkflowBrowserConnectionForSession(runId), null);
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

test("an active page without loopback CDP metadata fails closed for worker access", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-browser-host-unavailable-"));
  const runId = "run-app-browser-host-unavailable-check";
  const page = {} as never;
  const browserPort = createAppWorkflowBrowserPort({
    taskId: "browser-host-check",
    taskRunId: runId,
    signal: new AbortController().signal,
    userDataDirectory: root,
    credentialCodec: null,
    launchPersistentContext: async () => ({
      pages: () => [page],
      close: async () => {},
    }) as never,
  });

  try {
    await browserPort.withPage(async () => {
      assert.throws(
        () => appWorkflowBrowserConnectionForSession(runId),
        /connection is unavailable/u,
      );
    });
    assert.equal(appWorkflowPageForSession(runId), null);
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
