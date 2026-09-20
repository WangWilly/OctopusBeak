import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AutomationCredentialStateError,
  type AutomationCredentialStateSource,
  createAutomationCredentialStateCache,
  toAutomationCredentialStateDto,
} from "./automation-credential-state.ts";

function syntheticCredentialKey(...parts: string[]) {
  return parts.join("_");
}

test("credential DTO copies only sanitized allowlisted fields", () => {
  const dto = toAutomationCredentialStateDto({
    status: { USER: true, PASSWORD: false },
    fileNames: { CERT: "client.p12" },
    invalidFileKeys: ["CERT"],
    invalidFileReasons: { CERT: "missing-or-unreadable" },
  }, 7);
  assert.deepEqual(dto, {
    revision: 7,
    status: { USER: true, PASSWORD: false },
    fileNames: { CERT: "client.p12" },
    invalidFileKeys: ["CERT"],
    invalidFileReasons: { CERT: "missing-or-unreadable" },
  });
  assert.equal(Object.hasOwn(dto, "credentials"), false);
  assert.equal(Object.hasOwn(dto, "encryptedPayload"), false);
});

test("credential DTO keeps Gmail state sanitized and explicit", () => {
  const dto = toAutomationCredentialStateDto({
    status: {},
    fileNames: {},
    invalidFileKeys: [],
    invalidFileReasons: {},
    cathayGmailOtp: {
      enabled: true,
      connectedEmail: "  user@example.test ",
      needsAuthorization: false,
      connectionError: "authorization-failed",
    },
  }, 2);
  assert.deepEqual(dto.cathayGmailOtp, {
    enabled: true,
    connectedEmail: "  user@example.test ",
    needsAuthorization: false,
    connectionError: "authorization-failed",
  });
  assert.equal(Object.hasOwn(dto, "refreshToken"), false);
  assert.equal(Object.hasOwn(dto, "encryptedPayload"), false);
});

test("same credential revision shares one in-flight read", async () => {
  let reads = 0;
  const cache = createAutomationCredentialStateCache(() => {
    reads += 1;
    return {
      status: { USER: true },
      fileNames: {},
      invalidFileKeys: [],
      invalidFileReasons: {},
    };
  });
  const first = cache.prewarm();
  const second = cache.read();
  assert.equal(first, second);
  assert.equal(reads, 0);
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(await cache.read(), await cache.read());
});

test("a newer refresh wins when an older read settles later", async () => {
  const source = (value: boolean) => ({
    status: { REVISION: value },
    fileNames: {},
    invalidFileKeys: [],
    invalidFileReasons: {},
  }) satisfies AutomationCredentialStateSource;
  let releaseOld!: (value: AutomationCredentialStateSource) => void;
  let releaseNew!: (value: AutomationCredentialStateSource) => void;
  const oldSource = new Promise<AutomationCredentialStateSource>((resolve) => {
    releaseOld = resolve;
  });
  const newSource = new Promise<AutomationCredentialStateSource>((resolve) => {
    releaseNew = resolve;
  });
  let reads = 0;
  const cache = createAutomationCredentialStateCache(async () => {
    reads += 1;
    return reads === 1 ? oldSource : newSource;
  });
  const oldRead = cache.prewarm();
  await Promise.resolve();
  const newRead = cache.refresh();
  await Promise.resolve();
  releaseOld(source(true));
  const oldState = await oldRead;
  assert.equal(oldState.revision, 0);
  const staleResult = await Promise.race([
    cache.read().then(() => "published"),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
  ]);
  assert.equal(staleResult, "pending");
  releaseNew(source(false));
  const newState = await newRead;
  assert.equal(newState.revision, 1);
  assert.deepEqual((await cache.read()).status, { REVISION: false });
});

test("credential snapshot mapping has a durable P95 synchronous budget", () => {
  const samples: number[] = [];
  const source: AutomationCredentialStateSource = {
    status: { USER: true, PASSWORD: true },
    fileNames: { CERT: "client.p12" },
    invalidFileKeys: [],
    invalidFileReasons: {},
  };
  for (let index = 0; index < 200; index += 1) {
    const startedAt = performance.now();
    toAutomationCredentialStateDto(source, index);
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;
  assert.ok(p95 <= 50, `credential snapshot mapping P95 was ${p95.toFixed(3)}ms`);
});

test("main credential snapshot and mapping stay within the 50ms P95 budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-credential-performance-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(directory);
    writeFileSync("settings.json", "{}\n");
    writeFileSync("credentials.json", JSON.stringify({
      [syntheticCredentialKey("LIBRETTO", "CLOUD", "FUBON", "USER", "ID")]: "synthetic-user",
      [syntheticCredentialKey("LIBRETTO", "CLOUD", "FUBON", "ACCOUNT")]: "synthetic-account",
      [syntheticCredentialKey("LIBRETTO", "CLOUD", "FUBON", "PASSWORD")]: "synthetic-password",
    }));
    const configFiles = await import("../src/lib/automation/server/config-files.ts");
    configFiles.setAutomationCredentialCodec(null);
    const desktopApi = await import("../src/lib/automation/server/desktop-api.ts");
    const samples: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const startedAt = performance.now();
      const source = desktopApi.readAutomationCredentialState();
      toAutomationCredentialStateDto(source, index);
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;
    assert.ok(p95 <= 50, `credential snapshot/mapping P95 was ${p95.toFixed(3)}ms`);
  } finally {
    process.chdir(originalCwd);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("credential read failures become a stable retryable error and redacted log", async () => {
  const events: Record<string, string>[] = [];
  const cache = createAutomationCredentialStateCache(
    () => { throw new Error("secret path /Users/example/private.pem"); },
    (event) => events.push(event),
  );
  await assert.rejects(cache.read(), (error: unknown) => {
    assert.equal(error instanceof AutomationCredentialStateError, true);
    assert.equal((error as Error).message, "Unable to read automation credentials.");
    return true;
  });
  assert.deepEqual(events, [{
    code: "credential-state-unavailable",
    stage: "snapshot",
    message: "credential state read failed",
  }]);
});
