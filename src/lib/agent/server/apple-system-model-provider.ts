import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentProvider, AgentProviderActivation } from "./harness.ts";
import { agentHelperProcessEnv } from "./process-environment.ts";

export const APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION = "apple-system-model/v1" as const;
const DEFAULT_HELPER_RESPONSE_TIMEOUT_MS = 10_000;

export class AppleSystemModelProtocolError extends Error {
  readonly code: "incompatible-protocol";

  constructor(
    code: "incompatible-protocol",
    message: string,
  ) {
    super(message);
    this.name = "AppleSystemModelProtocolError";
    this.code = code;
  }
}

export type EmbeddedHelperProcess = {
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
  writeLine(line: string): void;
  terminate(): void;
};

export function spawnEmbeddedAppleSystemModelHelper({
  executablePath,
  arguments: helperArguments = [],
  baseEnv = process.env,
}: {
  executablePath: string;
  arguments?: readonly string[];
  baseEnv?: NodeJS.ProcessEnv;
}): EmbeddedHelperProcess {
  const child = spawn(executablePath, [...helperArguments], {
    stdio: ["pipe", "pipe", "pipe"],
    env: agentHelperProcessEnv(baseEnv),
  });
  const lines = createInterface({ input: child.stdout });
  const lineListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >();
  const bufferedLines: string[] = [];
  let observedExit: [number | null, NodeJS.Signals | null] | null = null;

  function notifyExit(code: number | null, signal: NodeJS.Signals | null) {
    if (observedExit) return;
    observedExit = [code, signal];
    for (const listener of exitListeners) listener(code, signal);
    exitListeners.clear();
  }

  lines.on("line", (line) => {
    if (lineListeners.size === 0) {
      bufferedLines.push(line);
      return;
    }
    for (const listener of lineListeners) listener(line);
  });
  child.once("error", () => notifyExit(null, null));
  child.once("exit", notifyExit);
  child.stdin.on("error", () => {
    notifyExit(null, null);
    child.kill("SIGTERM");
  });
  child.stderr.resume();

  return {
    onLine(listener) {
      lineListeners.add(listener);
      for (const line of bufferedLines.splice(0)) listener(line);
      return () => {
        lineListeners.delete(listener);
      };
    },
    onExit(listener) {
      exitListeners.add(listener);
      if (observedExit) {
        const [code, signal] = observedExit;
        queueMicrotask(() => listener(code, signal));
      }
      return () => {
        exitListeners.delete(listener);
      };
    },
    writeLine(line) {
      child.stdin.write(line);
    },
    terminate() {
      child.kill("SIGTERM");
    },
  };
}

type ProtocolMessage = Record<string, unknown> & {
  protocolVersion: string;
  type: string;
};

function parseProtocolMessage(line: string): ProtocolMessage {
  const message = JSON.parse(line) as unknown;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("Apple system model helper sent an invalid protocol message.");
  }
  const record = message as Record<string, unknown>;
  if (typeof record.protocolVersion !== "string" || typeof record.type !== "string") {
    throw new Error("Apple system model helper sent an invalid protocol message.");
  }
  return record as ProtocolMessage;
}

function hasExactProtocolKeys(
  message: ProtocolMessage,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
) {
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => Object.hasOwn(message, key))
    && Object.keys(message).every((key) => allowedKeys.has(key));
}

function isHandshakeMessage(message: ProtocolMessage) {
  return hasExactProtocolKeys(
    message,
    ["protocolVersion", "type", "helperVersion"],
  ) && typeof message.helperVersion === "string";
}

function isActivationResponse(message: ProtocolMessage) {
  return hasExactProtocolKeys(
    message,
    [
      "protocolVersion",
      "type",
      "requestId",
      "availability",
      "providerIdentity",
      "osBuild",
    ],
    ["reason"],
  )
    && typeof message.requestId === "string"
    && typeof message.availability === "string"
    && typeof message.providerIdentity === "string"
    && typeof message.osBuild === "string"
    && (
      !Object.hasOwn(message, "reason")
      || typeof message.reason === "string"
    );
}

function isRunResponse(message: ProtocolMessage) {
  if (message.type === "stream") {
    return hasExactProtocolKeys(
      message,
      ["protocolVersion", "type", "runId", "content"],
    )
      && typeof message.runId === "string"
      && typeof message.content === "string";
  }
  if (message.type === "complete") {
    return hasExactProtocolKeys(
      message,
      ["protocolVersion", "type", "runId"],
    ) && typeof message.runId === "string";
  }
  return message.type === "failure"
    && hasExactProtocolKeys(
      message,
      ["protocolVersion", "type", "runId", "reason"],
    )
    && typeof message.runId === "string"
    && typeof message.reason === "string";
}

export function createAppleSystemModelProtocolClient({
  launchProcess,
  requestIdFactory,
  handshakeTimeoutMs = DEFAULT_HELPER_RESPONSE_TIMEOUT_MS,
  activationTimeoutMs = DEFAULT_HELPER_RESPONSE_TIMEOUT_MS,
  runFirstResponseTimeoutMs = DEFAULT_HELPER_RESPONSE_TIMEOUT_MS,
  runIdleTimeoutMs = DEFAULT_HELPER_RESPONSE_TIMEOUT_MS,
}: {
  launchProcess(): EmbeddedHelperProcess;
  requestIdFactory(): string;
  handshakeTimeoutMs?: number;
  activationTimeoutMs?: number;
  runFirstResponseTimeoutMs?: number;
  runIdleTimeoutMs?: number;
}) {
  if (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
    throw new TypeError("Apple system model helper handshake timeout must be positive.");
  }
  if (!Number.isFinite(activationTimeoutMs) || activationTimeoutMs <= 0) {
    throw new TypeError("Apple system model helper activation timeout must be positive.");
  }
  if (!Number.isFinite(runFirstResponseTimeoutMs) || runFirstResponseTimeoutMs <= 0) {
    throw new TypeError("Apple system model run first-response timeout must be positive.");
  }
  if (!Number.isFinite(runIdleTimeoutMs) || runIdleTimeoutMs <= 0) {
    throw new TypeError("Apple system model run idle timeout must be positive.");
  }
  let process: EmbeddedHelperProcess | null = null;
  let handshakeComplete = false;
  let handshakePromise: Promise<void> | null = null;
  let handshakeFrameReceived = false;
  let transportFailure: Error | null = null;
  let activated = false;
  let activationGeneration = 0;
  const bufferedMessages: ProtocolMessage[] = [];
  const messageWaiters: Array<{
    resolve(message: ProtocolMessage): void;
    reject(error: Error): void;
  }> = [];
  const activationWaiters = new Map<string, {
    resolve(message: ProtocolMessage): void;
    reject(error: Error): void;
  }>();
  const runs = new Map<string, {
    onStream(content: string): void;
    onComplete(): void;
    onFailure(error: Error): void;
    timer: NodeJS.Timeout | null;
  }>();

  function clearRunDeadline(run: { timer: NodeJS.Timeout | null }) {
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
  }

  function armRunDeadline(
    helperProcess: EmbeddedHelperProcess,
    runId: string,
    timeoutMs: number,
    message: string,
  ) {
    const run = runs.get(runId);
    if (!run) return;
    clearRunDeadline(run);
    run.timer = setTimeout(() => {
      if (process !== helperProcess || !runs.has(runId)) return;
      failTransport(helperProcess, new Error(message), true);
    }, timeoutMs);
  }

  function nextMessage(): Promise<ProtocolMessage> {
    if (transportFailure) return Promise.reject(transportFailure);
    const buffered = bufferedMessages.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      messageWaiters.push({ resolve, reject });
    });
  }

  function failTransport(
    helperProcess: EmbeddedHelperProcess,
    error: Error,
    terminate: boolean,
  ) {
    if (process !== helperProcess) return;
    process = null;
    handshakeComplete = false;
    handshakePromise = null;
    handshakeFrameReceived = false;
    transportFailure = error;
    activated = false;
    activationGeneration += 1;
    for (const waiter of messageWaiters.splice(0)) waiter.reject(error);
    for (const waiter of activationWaiters.values()) waiter.reject(error);
    activationWaiters.clear();
    const activeRuns = [...runs.values()];
    runs.clear();
    bufferedMessages.length = 0;
    for (const run of activeRuns) {
      clearRunDeadline(run);
      try {
        run.onFailure(error);
      } catch {
        // A consumer callback cannot replace the transport failure or stop teardown.
      }
    }
    if (terminate) helperProcess.terminate();
  }

  function withTransportDeadline<T>(
    helperProcess: EmbeddedHelperProcess,
    pending: Promise<T>,
    timeoutMs: number,
    errorMessage: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new Error(errorMessage);
        failTransport(helperProcess, error, true);
        reject(error);
      }, timeoutMs);
      void pending.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function ensureProcess() {
    if (process) return process;
    transportFailure = null;
    handshakeFrameReceived = false;
    const helperProcess = launchProcess();
    process = helperProcess;
    helperProcess.onLine((line) => {
      if (process !== helperProcess) return;
      try {
        const message = parseProtocolMessage(line);
        if (!handshakeComplete) {
          if (handshakeFrameReceived) {
            failTransport(
              helperProcess,
              new Error(
                "Apple system model helper sent an additional message before handshake completed.",
              ),
              true,
            );
            return;
          }
          handshakeFrameReceived = true;
          const waiter = messageWaiters.shift();
          if (waiter) waiter.resolve(message);
          else bufferedMessages.push(message);
          return;
        }
        if (message.protocolVersion !== APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION) {
          failTransport(
            helperProcess,
            new Error("Apple system model helper sent an incompatible protocol message."),
            true,
          );
          return;
        }
        if (
          message.type === "stream"
          || message.type === "complete"
          || message.type === "failure"
        ) {
          if (!isRunResponse(message)) {
            failTransport(
              helperProcess,
              new Error("Apple system model helper run response was invalid."),
              true,
            );
            return;
          }
          const runId = message.runId as string;
          const run = runs.get(runId);
          if (!run) return;
          if (message.type === "stream") {
            armRunDeadline(
              helperProcess,
              runId,
              runIdleTimeoutMs,
              "Apple system model helper run idle timed out.",
            );
            run.onStream(message.content as string);
            return;
          }
          if (message.type === "complete") {
            runs.delete(runId);
            clearRunDeadline(run);
            run.onComplete();
            return;
          }
          runs.delete(runId);
          clearRunDeadline(run);
          run.onFailure(new Error(message.reason as string));
          return;
        }
        if (message.type === "activation") {
          if (!isActivationResponse(message)) {
            failTransport(
              helperProcess,
              new Error("Apple system model helper activation response was invalid."),
              true,
            );
            return;
          }
          const requestId = message.requestId as string;
          const activationWaiter = activationWaiters.get(requestId);
          if (activationWaiter) {
            activationWaiters.delete(requestId);
            activationWaiter.resolve(message);
            return;
          }
        }
        failTransport(
          helperProcess,
          new Error("Apple system model helper activation response was not correlated."),
          true,
        );
      } catch (error) {
        const protocolError = error instanceof Error ? error : new Error(String(error));
        failTransport(helperProcess, protocolError, true);
      }
    });
    helperProcess.onExit((code, signal) => {
      const phase = handshakeComplete ? "" : " before handshake";
      const error = new Error(
        `Apple system model helper exited${phase} (code=${code ?? "none"} signal=${signal ?? "none"}).`,
      );
      failTransport(helperProcess, error, false);
    });
    return helperProcess;
  }

  function requireHandshake(): Promise<void> {
    if (handshakeComplete) return Promise.resolve();
    if (handshakePromise) return handshakePromise;
    const pendingHandshake = (async () => {
      const helperProcess = ensureProcess();
      const handshake = await withTransportDeadline(
        helperProcess,
        nextMessage(),
        handshakeTimeoutMs,
        "Apple system model helper handshake timed out.",
      );
      if (process !== helperProcess || transportFailure) {
        throw transportFailure
          ?? new Error("Apple system model helper transport changed before handshake settled.");
      }
      if (
        handshake.protocolVersion !== APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION
        || handshake.type !== "handshake"
        || handshake.helperVersion !== "1"
        || !isHandshakeMessage(handshake)
      ) {
        const error = new AppleSystemModelProtocolError(
          "incompatible-protocol",
          "Apple system model helper protocol handshake failed.",
        );
        failTransport(helperProcess, error, true);
        throw error;
      }
      handshakeComplete = true;
    })();
    handshakePromise = pendingHandshake;
    void pendingHandshake.then(
      () => {
        if (handshakePromise === pendingHandshake) handshakePromise = null;
      },
      () => {
        if (handshakePromise === pendingHandshake) handshakePromise = null;
      },
    );
    return pendingHandshake;
  }

  return {
    async activate({ userStartedNewRun = false }: { userStartedNewRun?: boolean } = {}): Promise<AgentProviderActivation> {
      const requestGeneration = ++activationGeneration;
      activated = false;
      if (transportFailure && !process && !userStartedNewRun) {
        throw new Error("Apple system model helper replacement requires starting a new run.");
      }
      await requireHandshake();
      const helperProcess = ensureProcess();
      const requestId = requestIdFactory();
      if (activationWaiters.has(requestId)) {
        throw new Error("Apple system model helper activation request ID already exists.");
      }
      const pendingResponse = new Promise<ProtocolMessage>((resolve, reject) => {
        activationWaiters.set(requestId, { resolve, reject });
        try {
          helperProcess.writeLine(`${JSON.stringify({
            protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
            type: "activate",
            requestId,
          })}\n`);
        } catch (error) {
          activationWaiters.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const response = await withTransportDeadline(
        helperProcess,
        pendingResponse,
        activationTimeoutMs,
        "Apple system model helper activation timed out.",
      );
      if (process !== helperProcess || transportFailure) {
        throw transportFailure
          ?? new Error("Apple system model helper transport changed before activation settled.");
      }
      const invalidResponse = (
        response.protocolVersion !== APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION
        || response.type !== "activation"
        || response.requestId !== requestId
        || (
          response.availability !== "available"
          && response.availability !== "unavailable"
          && response.availability !== "incompatible"
        )
        || typeof response.providerIdentity !== "string"
        || response.providerIdentity.trim().length === 0
        || typeof response.osBuild !== "string"
        || response.osBuild.trim().length === 0
      );
      if (invalidResponse) {
        if (requestGeneration === activationGeneration) activated = false;
        throw new Error("Apple system model helper activation response was invalid.");
      }
      const activation: AgentProviderActivation = {
        availability: response.availability as AgentProviderActivation["availability"],
        providerIdentity: response.providerIdentity as string,
        osBuild: response.osBuild as string,
        ...(typeof response.reason === "string" ? { reason: response.reason } : {}),
      };
      if (requestGeneration === activationGeneration) {
        activated = activation.availability === "available";
      }
      return activation;
    },
    start({
      runId,
      prompt,
      onStream,
      onComplete,
      onFailure,
    }: {
      runId: string;
      prompt: string;
      onStream(content: string): void;
      onComplete(): void;
      onFailure(error: Error): void;
    }) {
      if (!activated) {
        throw new Error("Apple system model helper is not activated.");
      }
      if (runs.has(runId)) throw new Error("Apple system model run already exists.");
      const helperProcess = ensureProcess();
      runs.set(runId, { onStream, onComplete, onFailure, timer: null });
      armRunDeadline(
        helperProcess,
        runId,
        runFirstResponseTimeoutMs,
        "Apple system model helper run first response timed out.",
      );
      try {
        helperProcess.writeLine(`${JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "start",
          runId,
          prompt,
        })}\n`);
      } catch (error) {
        const transportError = error instanceof Error ? error : new Error(String(error));
        failTransport(helperProcess, transportError, true);
        throw transportError;
      }
    },
    cancel(runId: string) {
      const run = runs.get(runId);
      const helperProcess = process;
      if (!run || !helperProcess) return;
      try {
        helperProcess.writeLine(`${JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "cancel",
          runId,
        })}\n`);
      } catch (error) {
        const transportError = error instanceof Error ? error : new Error(String(error));
        failTransport(helperProcess, transportError, true);
        throw transportError;
      }
      runs.delete(runId);
      clearRunDeadline(run);
    },
    close() {
      const helperProcess = process;
      process = null;
      handshakeComplete = false;
      handshakePromise = null;
      handshakeFrameReceived = false;
      activated = false;
      activationGeneration += 1;
      const error = new Error("Apple system model helper client closed.");
      transportFailure = error;
      for (const waiter of messageWaiters.splice(0)) waiter.reject(error);
      for (const waiter of activationWaiters.values()) waiter.reject(error);
      activationWaiters.clear();
      for (const run of runs.values()) {
        clearRunDeadline(run);
        run.onFailure(error);
      }
      runs.clear();
      bufferedMessages.length = 0;
      helperProcess?.terminate();
    },
  };
}

export type AppleSystemModelProtocolClient = ReturnType<
  typeof createAppleSystemModelProtocolClient
>;

export function createUnsupportedAppleSystemModelProvider(
  platform: NodeJS.Platform,
): AgentProvider {
  return {
    async activate() {
      return {
        availability: "unavailable",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "unavailable",
        reason: `unsupported-platform:${platform}`,
      };
    },
    start() {
      throw new Error(`Apple system model is unavailable on ${platform}.`);
    },
    cancel() {},
  };
}

export function createAppleSystemModelProvider({
  client,
  hostOsBuild,
}: {
  client: AppleSystemModelProtocolClient;
  hostOsBuild(): string;
}): AgentProvider {
  return {
    async activate(options) {
      try {
        return await client.activate(options);
      } catch (error) {
        if (error instanceof AppleSystemModelProtocolError) {
          return {
            availability: "incompatible",
            providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
            osBuild: hostOsBuild(),
            reason: "helper-protocol-incompatible",
          };
        }
        throw error;
      }
    },
    start({ runId, input, onStream, onComplete, onFailure }) {
      if (typeof input.prompt !== "string" || input.prompt.length === 0) {
        throw new Error("Apple system model run requires a prompt.");
      }
      client.start({
        runId,
        prompt: input.prompt,
        onStream,
        onComplete,
        onFailure,
      });
    },
    cancel(runId) {
      client.cancel(runId);
    },
  };
}
