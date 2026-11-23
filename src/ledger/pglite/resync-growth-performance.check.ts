import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("./resync-growth-performance.ts", import.meta.url));

/**
 * Keeps ADR 0152 from regressing: every domain command's unchanged re-sync
 * must stay within the growth budget the script enforces. The script is the
 * one definition of the budget; this check only runs it in CI.
 */
test("an unchanged re-sync stays within the growth budget for every domain command", () => {
  const run = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, PGLITE_RESYNC_MODE: "all" },
    timeout: 10 * 60_000,
  });
  // The script's exit code is the contract: it exits 1 when any table or the store grows past the budget.
  const ended = run.error ? `failed to run: ${run.error.message}` : run.signal ? `killed by ${run.signal}` : `exited ${run.status}`;
  assert.equal(run.status, 0, `The growth script ${ended}.\n${run.stdout}\n${run.stderr}`);
});
