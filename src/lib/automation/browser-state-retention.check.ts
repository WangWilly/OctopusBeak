import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupAbandonedBrowserRuntimeProfiles,
  cleanupExpiredBrowserStates,
  DEFAULT_BROWSER_STATE_RETENTION_MS,
  startBrowserStateCleanup,
} from "./browser-state-retention.ts";

test("browser state cleanup removes expired inactive entries only", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-state-retention-"));
  const old = join(root, "old-profile");
  const active = join(root, "active-profile");
  const fresh = join(root, "fresh-profile");
  const external = join(root, "external-target");
  const link = join(root, "old-link");
  const now = Date.parse("2026-09-25T00:00:00.000Z");
  try {
    await Promise.all([mkdir(old), mkdir(active), mkdir(fresh)]);
    await writeFile(external, "keep");
    await symlink(external, link);
    const expired = new Date(now - DEFAULT_BROWSER_STATE_RETENTION_MS - 1_000);
    await Promise.all([utimes(old, expired, expired), utimes(active, expired, expired)]);
    const removed = await cleanupExpiredBrowserStates({
      directory: root,
      now: () => now,
      isActive: (name) => name === "active-profile",
    });
    assert.equal(removed, 1);
    assert.deepEqual((await readdir(root)).sort(), [
      "active-profile", "external-target", "fresh-profile", "old-link",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser state cleanup immediately removes abandoned runtime profiles and keeps active profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-runtime-retention-"));
  const active = join(root, "active-task");
  const abandoned = join(root, "abandoned-task");
  const external = join(root, "external-target");
  const link = join(root, "abandoned-link");
  try {
    await Promise.all([mkdir(active), mkdir(abandoned)]);
    await writeFile(join(active, "profile.lock"), "active");
    await writeFile(join(abandoned, "Cache"), "disposable browser cache");
    await writeFile(external, "keep");
    await symlink(external, link);

    const removed = await cleanupAbandonedBrowserRuntimeProfiles({
      directory: root,
      isActive: (name) => name === "active-task",
    });

    assert.equal(removed, 1);
    assert.deepEqual((await readdir(root)).sort(), [
      "abandoned-link", "active-task", "external-target",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the scheduled cleanup sweeps stale runtime profiles on startup without deleting active tasks", async () => {
  const automationRoot = await mkdtemp(join(tmpdir(), "browser-runtime-startup-cleanup-"));
  const stateRoot = join(automationRoot, "browser-state");
  const runtimeRoot = join(automationRoot, "browser-runtime");
  await Promise.all([
    mkdir(stateRoot, { recursive: true }),
    mkdir(join(runtimeRoot, "active-task"), { recursive: true }),
    mkdir(join(runtimeRoot, "abandoned-task"), { recursive: true }),
  ]);
  const stop = startBrowserStateCleanup({
    directory: stateRoot,
    runtimeDirectory: runtimeRoot,
    isActive: (name) => name === "active-task",
  });
  try {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (!(await readdir(runtimeRoot)).includes("abandoned-task")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual((await readdir(runtimeRoot)).sort(), ["active-task"]);
  } finally {
    stop();
    await rm(automationRoot, { recursive: true, force: true });
  }
});
