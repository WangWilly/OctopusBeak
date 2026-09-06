import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  openCanonicalDatabase,
} from "./cathay-domestic-deposit.ts";

const CONCURRENT_WRITER_CODE = `
const directory = process.argv[1];
const worker = Number(process.argv[2]);
const canonicalModule = process.argv[3];
const { commitCathayDomesticDeposit, CATHAY_DOMESTIC_DEPOSIT_FIXTURE } =
  await import(canonicalModule);
for (let iteration = 0; iteration < 12; iteration += 1) {
  const rawResponse = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replaceAll(
    "Synthetic Cathay",
    "Synthetic Worker " + worker + " Run " + iteration,
  );
  const observedAt =
    "2026-08-" +
    String(18 + iteration).padStart(2, "0") +
    "T" +
    String(worker).padStart(2, "0") +
    ":00:00+08:00";
  await commitCathayDomesticDeposit(
    directory,
    { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse, observedAt },
    {
      runtime: {
        busyTimeoutMs: 250,
        maxAttempts: 100,
        initialBackoffMs: 1,
        maxBackoffMs: 8,
      },
    },
  );
}
`;

function runConcurrentWriter(
  directory: string,
  canonicalModule: string,
  worker: number,
): Promise<{
  code: number | null;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        CONCURRENT_WRITER_CODE,
        directory,
        String(worker),
        canonicalModule,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("concurrent canonical writers keep retained lifecycle validation on one snapshot", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-projection-concurrency-"),
  );
  const canonicalModule = fileURLToPath(
    new URL("./cathay-domestic-deposit.ts", import.meta.url),
  );
  try {
    await commitCathayDomesticDeposit(
      directory,
      CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    );
    const results = await Promise.all(
      [1, 2, 3, 4].map((worker) =>
        runConcurrentWriter(directory, canonicalModule, worker),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.code),
      [0, 0, 0, 0],
      results.map((result) => result.stderr).join("\n"),
    );

    const db = openCanonicalDatabase(directory, { readOnly: true });
    try {
      const state = db
        .prepare(
          `SELECT generation.build_cutoff_commit_sequence AS cutoff,
                  (SELECT MAX(commit_sequence) FROM canonical_commits) AS latest,
                  (SELECT MAX(commit_sequence) FROM canonical_commits commit_row
                     WHERE commit_row.commit_kind <> 'projection_rebuild'
                       AND EXISTS (
                         SELECT 1 FROM source_captures capture
                          WHERE capture.commit_id = commit_row.commit_id
                       )) AS latest_evidence
             FROM projection_generations generation
            WHERE generation.status = 'active'`,
        )
        .get() as {
        cutoff?: number;
        latest?: number;
        latest_evidence?: number;
      };
      assert.equal(state.cutoff, state.latest);
      assert.equal(state.cutoff, state.latest_evidence);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
