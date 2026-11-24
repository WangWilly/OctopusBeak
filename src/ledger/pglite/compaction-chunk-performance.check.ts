import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("./compaction-chunk-performance.ts", import.meta.url));

/**
 * Keeps a compaction chunk short (ADR 0154). The script is the one
 * definition of the budget; this check only runs it in CI.
 */
test("no compaction chunk holds the ledger past the budget, even one whose every copy is cited", () => {
  const run = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT], {
    encoding: "utf8",
    timeout: 10 * 60_000,
  });
  const ended = run.error ? `failed to run: ${run.error.message}` : run.signal ? `killed by ${run.signal}` : `exited ${run.status}`;
  assert.equal(run.status, 0, `The chunk timing script ${ended}.\n${run.stdout}\n${run.stderr}`);
});
