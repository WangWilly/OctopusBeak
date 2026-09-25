import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
  const browserPort = createAppWorkflowBrowserPort({
    taskId: "browser-host-check",
    taskRunId: runId,
    signal: new AbortController().signal,
    userDataDirectory: root,
    launchPersistentContext: async (userDataDirectory, options) =>
      await chromium.launchPersistentContext(userDataDirectory, {
        ...options,
        headless: true,
      }),
  });

  try {
    await browserPort.withPage(async (ownerPage) => {
      assert.equal(appWorkflowPageForSession(runId), ownerPage);
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
    assert.equal(stateFiles.some((path) => /(?:\.csv|\.jsonl)$/iu.test(path)), false);
    assert.equal(stateFiles.some((path) => /(^|[\\/])downloads?([\\/]|$)/iu.test(path)), false);
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
