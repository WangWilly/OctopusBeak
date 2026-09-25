import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupExpiredBrowserStates,
  DEFAULT_BROWSER_STATE_RETENTION_MS,
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
