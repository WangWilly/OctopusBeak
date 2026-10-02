import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { parseAppWorkflowWorkerOutboundFrame } from "./app-workflow-worker-protocol.ts";
import {
  appendWorkflowFailureDiagnostic,
  captureSafeWorkflowFailureError,
  sanitizeSafeWorkflowFailureError,
  workflowFailureDiagnosticRepoRoot,
} from "./workflow-failure-diagnostics.ts";

const repository = "/Volumes/projects02/libretto-playground";

test("error snapshots keep repo-local stack locations while dropping messages, paths, and arbitrary codes", () => {
  const rootCause = new TypeError("account=private-account password=private-password");
  rootCause.stack = [
    "TypeError: account=private-account password=private-password",
    "    at validateContract (/Volumes/projects02/libretto-playground/src/ledger/pglite/source-admission-validation.ts:417:23)",
    "    at privateUserFunction (/Users/private-user/Downloads/source.json:8:4)",
  ].join("\n");
  Object.defineProperty(rootCause, "code", { value: "private-account-1234" });
  const outer = new Error("private source payload with token=private-token", { cause: rootCause });
  outer.stack = [
    "Error: private source payload with token=private-token",
    "    at commit (/Volumes/projects02/libretto-playground/build-electron/app-workflow-worker.cjs:701:31)",
  ].join("\n");

  const snapshot = captureSafeWorkflowFailureError(outer, repository);
  assert.deepEqual(snapshot.chain, [
    {
      type: "Error",
      frames: [{ file: "build-electron/app-workflow-worker.cjs", line: 701, column: 31 }],
    },
    {
      type: "TypeError",
      frames: [{ file: "src/ledger/pglite/source-admission-validation.ts", line: 417, column: 23 }],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-account|private-password|private-user|private-token|Downloads|source\.json/u);
});

test("PostgreSQL details retain only allowlisted SQLSTATE codes", () => {
  const error = new Error("INSERT INTO accounts VALUES ('private-account')");
  Object.defineProperty(error, "name", { value: "PostgresError" });
  Object.defineProperty(error, "code", { value: "23505", configurable: true });
  const safe = captureSafeWorkflowFailureError(error, repository);
  assert.equal(safe.chain[0]?.sqlState, "23505");

  Object.defineProperty(error, "code", { value: "private-account-23505", configurable: true });
  assert.equal(captureSafeWorkflowFailureError(error, repository).chain[0]?.sqlState, undefined);
});

test("actual PGlite constraint failures retain their SQLSTATE despite the library error name", async () => {
  const database = await PGlite.create();
  try {
    await database.exec("CREATE TABLE diagnostic_probe (value TEXT UNIQUE); INSERT INTO diagnostic_probe VALUES ('x');");
    let original: unknown;
    try {
      await database.exec("INSERT INTO diagnostic_probe VALUES ('x');");
    } catch (error) {
      original = error;
    }
    assert.ok(original instanceof Error);
    assert.equal(original.name, "error");
    const safe = captureSafeWorkflowFailureError(original, repository);
    assert.equal(safe.chain[0]?.sqlState, "23505");
    assert.doesNotMatch(JSON.stringify(safe), /INSERT|diagnostic_probe|private/u);
  } finally {
    await database.close();
  }
});

test("worker diagnostic parsing copies only bounded safe fields", () => {
  const safe = sanitizeSafeWorkflowFailureError({
    chain: [{
      type: "PostgresError",
      sqlState: "23505",
      frames: [
        { file: "electron/pglite-financial-registry.ts", line: 744, column: 11 },
        { file: "/Users/private-user/private-file.ts", line: 1, column: 1 },
        { file: "../../private-file.ts", line: 1, column: 1 },
      ],
      message: "private payload",
    }],
    message: "private payload",
  });
  assert.deepEqual(safe, {
    chain: [{
      type: "PostgresError",
      sqlState: "23505",
      frames: [{ file: "electron/pglite-financial-registry.ts", line: 744, column: 11 }],
    }],
  });
});

test("hashed Electron chunks survive worker capture and host protocol validation only when built", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "octopus-workflow-bundle-diagnostic-"));
  const chunk = "yuanta-all-workflow-BoZ9jVGz.cjs";
  const chunkPath = join(appRoot, "build-electron", chunk);
  try {
    await mkdir(join(appRoot, "build-electron"), { recursive: true });
    await writeFile(chunkPath, "bundled fixture", "utf8");

    const error = new Error("private source response");
    error.stack = [
      "Error: private source response",
      `    at collect (${chunkPath}:107:12)`,
    ].join("\n");
    const captured = captureSafeWorkflowFailureError(error, appRoot);
    const expectedFrame = { file: `build-electron/${chunk}`, line: 107, column: 12 };
    assert.deepEqual(captured.chain[0]?.frames, [expectedFrame]);
    assert.deepEqual(sanitizeSafeWorkflowFailureError(captured, appRoot), captured);

    const revalidated = parseAppWorkflowWorkerOutboundFrame({
      protocolVersion: 2,
      kind: "failed",
      taskRunId: "worker-run-1",
      errorCode: "workflow-failed",
      diagnostic: {
        chain: [{
          type: "Error",
          frames: [
            expectedFrame,
            { file: "build-electron/missing-workflow-ABCD1234.cjs", line: 1, column: 1 },
            { file: "/Users/private-user/private-account.json", line: 2, column: 3 },
            { file: "build-electron/not-a-hashed-chunk.cjs", line: 4, column: 5 },
          ],
          message: "private source detail",
        }],
        message: "private response body",
      },
    }, appRoot);
    assert.equal(revalidated.kind, "failed");
    if (revalidated.kind !== "failed") assert.fail("the failure frame should remain a failure");
    assert.deepEqual(revalidated.diagnostic?.chain[0]?.frames, [expectedFrame]);
    assert.doesNotMatch(JSON.stringify(revalidated), /private-user|private-account|private source detail|private response body/u);

    const previousAppRoot = process.env.OCTOPUSBEAK_APP_ROOT;
    const ambientRoot = join(appRoot, "different-ambient-app-root");
    const filePath = join(appRoot, "workflow-failures.jsonl");
    assert.deepEqual(sanitizeSafeWorkflowFailureError(captured, ambientRoot).chain[0]?.frames, []);
    process.env.OCTOPUSBEAK_APP_ROOT = ambientRoot;
    try {
      assert.equal(await appendWorkflowFailureDiagnostic(filePath, {
        workflowId: "yuanta-all-statements",
        taskRunId: "chunk-test-run",
        source: "workflow-worker",
        errorCode: "workflow-failed",
        safeError: captured,
      }, { repoRoot: appRoot }), true);
      const record = JSON.parse((await readFile(filePath, "utf8")).trim()) as {
        error: { chain: Array<{ frames: Array<{ file: string; line: number; column: number }> }> };
      };
      assert.deepEqual(record.error.chain[0]?.frames, [expectedFrame]);
    } finally {
      if (previousAppRoot === undefined) delete process.env.OCTOPUSBEAK_APP_ROOT;
      else process.env.OCTOPUSBEAK_APP_ROOT = previousAppRoot;
    }
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

test("App root keeps bundled frames available after Electron changes cwd to userData", async () => {
  const userData = await mkdtemp(join(tmpdir(), "octopus-user-data-cwd-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(userData);
    const appRoot = workflowFailureDiagnosticRepoRoot({ OCTOPUSBEAK_APP_ROOT: repository });
    const error = new Error("private");
    error.stack = [
      "Error: private",
      "    at commit (/Volumes/projects02/libretto-playground/build-electron/main.cjs:235:9)",
    ].join("\n");
    assert.equal(appRoot, repository);
    assert.deepEqual(captureSafeWorkflowFailureError(error, appRoot).chain[0]?.frames, [
      { file: "build-electron/main.cjs", line: 235, column: 9 },
    ]);
  } finally {
    process.chdir(originalCwd);
    await rm(userData, { recursive: true, force: true });
  }
});

test("diagnostic sink is opt-in, private, correlated, and never stores raw error text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octopus-workflow-failure-diagnostic-"));
  const filePath = join(directory, "workflow-failures.jsonl");
  try {
    assert.equal(await appendWorkflowFailureDiagnostic(undefined, {
      workflowId: "ctbc-statements",
      taskRunId: "test-run-123",
      source: "workflow-worker",
      errorCode: "source-validation-failed",
      stage: "validation",
      error: new Error("private account=private-account"),
    }, { repoRoot: repository }), false);

    const error = new Error("private account=private-account");
    error.stack = [error.message, "    at validate (/Volumes/projects02/libretto-playground/src/workflows/ctbc.ts:88:9)"].join("\n");
    assert.equal(await appendWorkflowFailureDiagnostic(filePath, {
      workflowId: "ctbc-statements",
      taskRunId: "test-run-123",
      source: "workflow-worker",
      errorCode: "source-validation-failed",
      stage: "validation",
      error,
    }, { repoRoot: repository, now: () => new Date("2026-10-01T00:00:00.000Z") }), true);

    const text = await readFile(filePath, "utf8");
    const record = JSON.parse(text.trim()) as Record<string, unknown>;
    assert.equal(record.workflowId, "ctbc-statements");
    assert.equal(record.taskRunId, "test-run-123");
    assert.equal(record.errorCode, "source-validation-failed");
    assert.equal(record.stage, "validation");
    assert.doesNotMatch(text, /private account|private-account/u);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid sink locations are ignored and report failure without throwing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octopus-workflow-failure-diagnostic-"));
  try {
    assert.equal(await appendWorkflowFailureDiagnostic(directory, {
      workflowId: "ctbc-statements",
      taskRunId: "test-run-123",
      source: "workflow-host",
      errorCode: "workflow-failed",
      error: new Error("private detail"),
    }, { repoRoot: repository }), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("HTTP failures retain only fixed status codes through safe snapshot revalidation", () => {
  const error = new Error("SECRET response body and URL");
  Object.defineProperty(error, "status", { value: 422, configurable: true });
  const safe = captureSafeWorkflowFailureError(error, repository);
  assert.equal(safe.chain[0]?.httpStatus, 422);
  assert.deepEqual(sanitizeSafeWorkflowFailureError(safe, repository), safe);
  Object.defineProperty(error, "status", { value: "SECRET" });
  assert.equal(captureSafeWorkflowFailureError(error, repository).chain[0]?.httpStatus, undefined);
  assert.doesNotMatch(JSON.stringify(safe), /SECRET|response|URL/u);
});
