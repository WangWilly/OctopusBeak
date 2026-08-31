import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  GMAIL_OTP_MAX_FRAME_BYTES,
  gmailOtpIpcAuthFrame,
  gmailOtpRequestFrame,
} from "../gmail-otp.ts";
import {
  ensureCathayGmailOtpAccess,
  resetCathayGmailOtpClientForTests,
  retrieveCathayGmailOtp,
} from "../../../workflows/gmail-otp.ts";
import { createGmailOtpIpcServer } from "./gmail-otp-broker.ts";

const TOKEN = "a".repeat(32);
const id = "01234567-89ab-cdef-0123-456789abcdef";

function childResult(script: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { env, stdio: ["ignore", "pipe", "ignore"] },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

function socketClosed(socket: ReturnType<typeof createConnection>) {
  return new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
  });
}

async function connectedSocket(endpoint: string) {
  const socket = createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function serverOptions(endpoint: string, overrides: Partial<Parameters<typeof createGmailOtpIpcServer>[0]> = {}) {
  return {
    endpoint,
    token: TOKEN,
    service: {
      ensureAccess: async () => ({ status: "ready" as const }),
      prepareRetrieval: async () => ({ status: "prepared" as const, boundaryId: id }),
      retrieve: async () => ({ status: "found" as const, otp: "ABCD-123456" }),
    },
    ...overrides,
  } satisfies Parameters<typeof createGmailOtpIpcServer>[0];
}

test("Gmail IPC survives a parent -> intermediary -> workflow double spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-otp-ipc-spawn-"));
  const endpoint = join(dir, "bridge.sock");
  const server = createGmailOtpIpcServer(serverOptions(endpoint));
  const workflowUrl = pathToFileURL(join(process.cwd(), "src/workflows/gmail-otp.ts")).href;
  try {
    await server.ready;
    const grandchildScript = [
      `const { ensureCathayGmailOtpAccess, resetCathayGmailOtpClientForTests } = await import(${JSON.stringify(workflowUrl)});`,
      "const result = await ensureCathayGmailOtpAccess();",
      "process.stdout.write(JSON.stringify({ status: result.status }));",
      "resetCathayGmailOtpClientForTests();",
    ].join(" ");
    const intermediaryScript = [
      "const { spawn } = await import('node:child_process');",
      `const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', ${JSON.stringify(grandchildScript)}], { env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });`,
      "let output = ''; child.stdout.on('data', (chunk) => { output += chunk; });",
      "child.on('close', (code) => { if (code !== 0) process.exitCode = code ?? 1; process.stdout.write(output); });",
    ].join(" ");
    const result = await childResult(intermediaryScript, {
      ...process.env,
      ...server.env,
      // The old transport depended on these descriptors surviving the second
      // spawn. Deliberately do not create or pass any descriptor here.
      OCTOPUSBEAK_GMAIL_OTP_REQUEST_FD: undefined,
      OCTOPUSBEAK_GMAIL_OTP_RESPONSE_FD: undefined,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, JSON.stringify({ status: "ready" }));
  } finally {
    await server.close();
    assert.equal(existsSync(endpoint), false);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gmail IPC rejects missing and invalid authentication before calling the service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-otp-ipc-auth-"));
  const endpoint = join(dir, "bridge.sock");
  let calls = 0;
  const server = createGmailOtpIpcServer(serverOptions(endpoint, {
    service: {
      ensureAccess: async () => { calls += 1; return { status: "ready" as const }; },
      prepareRetrieval: async () => { calls += 1; return { status: "prepared" as const, boundaryId: id }; },
      retrieve: async () => { calls += 1; return { status: "found" as const, otp: "ABCD-123456" }; },
    },
  }));
  try {
    await server.ready;
    for (const payload of [
      gmailOtpIpcAuthFrame("b".repeat(32)),
      gmailOtpRequestFrame({ id, method: "ensure-access" }),
    ]) {
      const socket = await connectedSocket(endpoint);
      socket.write(payload);
      socket.end();
      await socketClosed(socket);
    }
    assert.equal(calls, 0);
  } finally {
    await server.close();
    assert.equal(existsSync(endpoint), false);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gmail IPC closes malformed and oversized frames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-otp-ipc-frame-"));
  const endpoint = join(dir, "bridge.sock");
  const reasons: string[] = [];
  const server = createGmailOtpIpcServer(serverOptions(endpoint, {
    onProtocolError: (reason) => reasons.push(reason),
  }));
  try {
    await server.ready;
    for (const payload of [
      `${gmailOtpIpcAuthFrame(TOKEN)}not-json\n`,
      `${gmailOtpIpcAuthFrame(TOKEN)}${"x".repeat(GMAIL_OTP_MAX_FRAME_BYTES + 1)}\n`,
    ]) {
      const socket = await connectedSocket(endpoint);
      socket.write(payload);
      await socketClosed(socket);
    }
    assert.ok(reasons.includes("invalid-frame"));
  } finally {
    await server.close();
    assert.equal(existsSync(endpoint), false);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gmail IPC preserves fallback responses and removes its endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-otp-ipc-fallback-"));
  const endpoint = join(dir, "bridge.sock");
  const server = createGmailOtpIpcServer(serverOptions(endpoint, {
    service: {
      ensureAccess: async () => ({ status: "fallback" as const, reason: "needs-authorization" as const }),
      prepareRetrieval: async () => ({ status: "fallback" as const, reason: "needs-authorization" as const }),
      retrieve: async () => ({ status: "fallback" as const, reason: "no-candidate" as const }),
    },
  }));
  const previousEndpoint = process.env.OCTOPUSBEAK_GMAIL_OTP_IPC_ENDPOINT;
  const previousToken = process.env.OCTOPUSBEAK_GMAIL_OTP_IPC_TOKEN;
  try {
    await server.ready;
    process.env.OCTOPUSBEAK_GMAIL_OTP_IPC_ENDPOINT = server.endpoint;
    process.env.OCTOPUSBEAK_GMAIL_OTP_IPC_TOKEN = server.token;
    assert.deepEqual(await ensureCathayGmailOtpAccess(), {
      status: "fallback",
      reason: "needs-authorization",
    });
    assert.deepEqual(await retrieveCathayGmailOtp(id), {
      status: "fallback",
      reason: "no-candidate",
    });
  } finally {
    resetCathayGmailOtpClientForTests();
    if (previousEndpoint === undefined) delete process.env.OCTOPUSBEAK_GMAIL_OTP_IPC_ENDPOINT;
    else process.env.OCTOPUSBEAK_GMAIL_OTP_IPC_ENDPOINT = previousEndpoint;
    if (previousToken === undefined) delete process.env.OCTOPUSBEAK_GMAIL_OTP_IPC_TOKEN;
    else process.env.OCTOPUSBEAK_GMAIL_OTP_IPC_TOKEN = previousToken;
    await server.close();
    assert.equal(existsSync(endpoint), false);
    rmSync(dir, { recursive: true, force: true });
  }
});
