import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { agentHelperProcessEnv } from "../src/lib/agent/server/process-environment.ts";

const protocolVersion = "apple-system-model/v1";
const source = new URL("../electron/apple-system-model-helper.swift", import.meta.url);
const qualifiesRealProvider = process.env.OCTOPUSBEAK_FOUNDATION_MODELS_QUALIFICATION === "1";
const supportsAppleHelper = process.platform === "darwin"
  && Number.parseInt(release().split(".")[0] ?? "0", 10) >= 25;
const appleHelperTestOptions = { skip: !supportsAppleHelper };
const swiftArchitecture = process.arch === "arm64" ? "arm64" : "x86_64";
const swiftTarget = `${swiftArchitecture}-apple-macosx26.0`;

if (qualifiesRealProvider && !supportsAppleHelper) {
  throw new Error("Apple Foundation Models qualification requires macOS.");
}

function waitForEventWithTimeout(emitter, event, description, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const onEvent = (...values) => {
      clearTimeout(timeout);
      resolve(values);
    };
    const timeout = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`timed out waiting for ${description}`));
    }, timeoutMs);
    emitter.once(event, onEvent);
  });
}

function compileAndLaunchHelper(temporaryPrefix) {
  const root = mkdtempSync(join(tmpdir(), temporaryPrefix));
  const executable = join(root, "apple-system-model-helper");
  const compiled = spawnSync("xcrun", [
    "swiftc",
    "-parse-as-library",
    "-target",
    swiftTarget,
    "-module-cache-path",
    join(root, "module-cache"),
    "-o",
    executable,
    source.pathname,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      DEVELOPER_DIR: process.env.DEVELOPER_DIR
        ?? "/Applications/Xcode.app/Contents/Developer",
    },
  });
  assert.equal(compiled.status, 0, compiled.stderr);

  const child = spawn(executable, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: agentHelperProcessEnv({ ...process.env, TMPDIR: root }),
  });
  const lines = createInterface({ input: child.stdout });
  return {
    child,
    lines,
    cleanup() {
      child.kill("SIGTERM");
      lines.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("production Apple system model helper compiles and emits the versioned handshake", {
  ...appleHelperTestOptions,
}, async () => {
  const fixture = compileAndLaunchHelper("apple-system-model-helper-");
  const { child, lines } = fixture;
  try {
    const [line] = await waitForEventWithTimeout(lines, "line", "helper handshake");
    assert.deepEqual(JSON.parse(line), {
      protocolVersion,
      type: "handshake",
      helperVersion: "1",
    });
    child.kill("SIGTERM");
    await waitForEventWithTimeout(child, "exit", "helper exit");
  } finally {
    fixture.cleanup();
  }
});

test("production Apple system model helper checks provider availability on activation", {
  ...appleHelperTestOptions,
}, async () => {
  const fixture = compileAndLaunchHelper("apple-system-model-activation-");
  const { child, lines } = fixture;
  try {
    await waitForEventWithTimeout(lines, "line", "availability handshake");
    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "activate",
      requestId: "activation-real-1",
    })}\n`);
    const [line] = await waitForEventWithTimeout(lines, "line", "activation response");
    const activation = JSON.parse(line);
    assert.equal(activation.protocolVersion, protocolVersion);
    assert.equal(activation.type, "activation");
    assert.equal(activation.requestId, "activation-real-1");
    assert.equal(
      ["available", "unavailable"].includes(activation.availability),
      true,
    );
    assert.equal(
      activation.providerIdentity,
      "apple.foundation-models:SystemLanguageModel.default",
    );
    assert.equal(typeof activation.osBuild, "string");
    assert.notEqual(activation.osBuild.length, 0);
    child.kill("SIGTERM");
    await waitForEventWithTimeout(child, "exit", "helper exit");
  } finally {
    fixture.cleanup();
  }
});

test("production Apple system model helper rejects a start while inactive", {
  ...appleHelperTestOptions,
}, async () => {
  const fixture = compileAndLaunchHelper("apple-system-model-inactive-run-");
  const { child, lines } = fixture;
  try {
    await waitForEventWithTimeout(lines, "line", "inactive-run handshake");
    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "start",
      runId: "run-inactive",
      prompt: "Must be rejected while inactive.",
    })}\n`);
    const [line] = await waitForEventWithTimeout(lines, "line", "inactive-run failure");
    assert.deepEqual(JSON.parse(line), {
      protocolVersion,
      type: "failure",
      runId: "run-inactive",
      reason: "provider-not-activated",
    });
    child.kill("SIGTERM");
    await waitForEventWithTimeout(child, "exit", "inactive-run helper exit");
  } finally {
    fixture.cleanup();
  }
});

test("production Apple system model helper rejects duplicate run IDs as concurrent requests", {
  ...appleHelperTestOptions,
}, async (t) => {
  const fixture = compileAndLaunchHelper("apple-system-model-duplicate-run-");
  const { child, lines } = fixture;
  try {
    await waitForEventWithTimeout(lines, "line", "duplicate-run handshake");
    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "activate",
      requestId: "activation-duplicate-run",
    })}\n`);
    const [activationLine] = await waitForEventWithTimeout(
      lines,
      "line",
      "duplicate-run activation response",
    );
    const activation = JSON.parse(activationLine);
    if (activation.availability !== "available") {
      t.skip("Foundation Models provider is unavailable on this host");
      return;
    }

    const runMessages = [];
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.runId === "run-duplicate") runMessages.push(message);
    });
    const duplicateFailure = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for duplicate-run failure")),
        5_000,
      );
      const onLine = (line) => {
        const message = JSON.parse(line);
        if (message.runId !== "run-duplicate" || message.type !== "failure") return;
        clearTimeout(timeout);
        lines.off("line", onLine);
        resolve(message);
      };
      lines.on("line", onLine);
    });
    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "start",
      runId: "run-duplicate",
      prompt: "Start the first duplicate-run request.",
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "start",
      runId: "run-duplicate",
      prompt: "Reject this duplicate request.",
    })}\n`);
    assert.deepEqual(await duplicateFailure, {
      protocolVersion,
      type: "failure",
      runId: "run-duplicate",
      reason: "provider-concurrent-request",
    });

    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "cancel",
      runId: "run-duplicate",
    })}\n`);
    const cancellationBoundary = runMessages.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(runMessages.slice(cancellationBoundary), []);
    child.kill("SIGTERM");
    await waitForEventWithTimeout(child, "exit", "duplicate-run helper exit");
  } finally {
    fixture.cleanup();
  }
});

test("production Apple system model helper terminates on malformed or non-exact inbound commands", {
  ...appleHelperTestOptions,
}, async () => {
  const invalidCommands = [
    "not json",
    { protocolVersion, type: "activate", requestId: "a", runId: "cross-type" },
    { protocolVersion, type: "start", runId: "r", prompt: "p", requestId: "cross-type" },
    { protocolVersion, type: "cancel", runId: "r", prompt: "cross-type" },
    { protocolVersion, type: "unknown", requestId: "a" },
    { protocolVersion: "apple-system-model/v0", type: "activate", requestId: "a" },
    { protocolVersion, type: "activate", requestId: 42 },
  ];

  for (const command of invalidCommands) {
    const fixture = compileAndLaunchHelper("apple-system-model-invalid-command-");
    try {
      await waitForEventWithTimeout(fixture.lines, "line", "invalid command handshake");
      fixture.child.stdin.write(`${typeof command === "string" ? command : JSON.stringify(command)}\n`);
      const [code] = await waitForEventWithTimeout(
        fixture.child,
        "exit",
        "invalid command termination",
      );
      assert.notEqual(code, 0);
    } finally {
      fixture.cleanup();
    }
  }
});

test("production Apple system model helper streams and completes a real provider run", {
  skip: !qualifiesRealProvider || !supportsAppleHelper,
}, async () => {
  const fixture = compileAndLaunchHelper("apple-system-model-generation-");
  const { child, lines } = fixture;
  try {
    await waitForEventWithTimeout(lines, "line", "generation handshake");
    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "activate",
      requestId: "activation-real-generation",
    })}\n`);
    const [activationLine] = await waitForEventWithTimeout(
      lines,
      "line",
      "generation activation response",
    );
    assert.equal(JSON.parse(activationLine).availability, "available");

    const messages = [];
    const completed = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for real provider completion")),
        15_000,
      );
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.runId !== "run-real-generation") return;
        messages.push(message);
        if (message.type === "failure") {
          clearTimeout(timeout);
          reject(new Error(message.reason));
        }
        if (message.type === "complete") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "start",
      runId: "run-real-generation",
      prompt: "In about 80 words, explain why an application must keep credentials outside a model context.",
    })}\n`);
    await completed;

    assert.equal(messages.some((message) => message.type === "stream"), true);
    assert.equal(messages.at(-1)?.type, "complete");
  } finally {
    fixture.cleanup();
  }
});

test("production Apple system model helper cancels a real provider run without late events", {
  skip: !qualifiesRealProvider || !supportsAppleHelper,
}, async () => {
  const fixture = compileAndLaunchHelper("apple-system-model-cancel-");
  const { child, lines } = fixture;
  try {
    await waitForEventWithTimeout(lines, "line", "cancellation handshake");
    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "activate",
      requestId: "activation-real-cancel",
    })}\n`);
    const [activationLine] = await waitForEventWithTimeout(
      lines,
      "line",
      "cancellation activation response",
    );
    assert.equal(JSON.parse(activationLine).availability, "available");

    const runMessages = [];
    let resolveReactivation;
    const reactivation = new Promise((resolve) => {
      resolveReactivation = resolve;
    });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.runId === "run-real-cancel") runMessages.push(message);
      if (message.requestId === "activation-after-cancel") resolveReactivation(message);
    });
    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "start",
      runId: "run-real-cancel",
      prompt: "In about 200 words, explain several reasons credentials must remain outside a model context.",
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "cancel",
      runId: "run-real-cancel",
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      protocolVersion,
      type: "activate",
      requestId: "activation-after-cancel",
    })}\n`);
    const response = await Promise.race([
      reactivation,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("timed out waiting for helper after cancellation")),
        5_000,
      )),
    ]);
    assert.equal(response.availability, "available");
    const cancellationBoundary = runMessages.length;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.deepEqual(runMessages.slice(cancellationBoundary), []);
  } finally {
    fixture.cleanup();
  }
});
