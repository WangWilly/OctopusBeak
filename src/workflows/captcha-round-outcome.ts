import { createConnection, type Socket } from "node:net";
import {
  captchaRoundOutcomeAuthFrame,
  captchaRoundOutcomeFrame,
  createCaptchaRoundOutcomeMessage,
  isCaptchaRoundOutcomeToken,
  isRegisteredCaptchaProviderRejectionProof,
  type CaptchaProviderRejectionProof,
  type CaptchaRoundCancellationReason,
  type CaptchaRoundChallengeKind,
  type CaptchaRoundFailureReason,
  type CaptchaRoundOutcome,
  type CaptchaRoundOutcomeRejectionReason,
} from "../lib/automation/captcha-round-outcome.ts";
import {
  CAPTCHA_ROUND_OUTCOME_ENDPOINT_ENV,
  CAPTCHA_ROUND_OUTCOME_EXECUTION_ID_ENV,
  CAPTCHA_ROUND_OUTCOME_TOKEN_ENV,
} from "../lib/automation/captcha-round-outcome.ts";

export type CaptchaRoundOutcomeIpcTransport = {
  send(frame: string): Promise<void>;
  close(): Promise<void>;
};

export type CaptchaRoundOutcomeIpcConnector = (
  endpoint: string,
  authenticationFrame: string,
) => Promise<CaptchaRoundOutcomeIpcTransport>;

export type CaptchaRoundOutcomeReporterOptions = {
  /** Defaults to the private endpoint injected by the automation host. */
  endpoint?: string;
  /** Defaults to the one-execution token injected by the automation host. */
  token?: string;
  /** Defaults to the execution ID injected by the automation host. */
  executionId?: string;
  /** Provider probes that have been registered with the host contract. */
  providerRejectionProbes?: readonly CaptchaProviderRejectionProof[];
  /** Test seam; production uses the authenticated local socket transport. */
  connect?: CaptchaRoundOutcomeIpcConnector;
};

export type CaptchaRoundOutcomeIpcProtocolReason =
  | CaptchaRoundOutcomeRejectionReason
  | "provider-rejection-probe-not-registered"
  | "reporter-closed";

export class CaptchaRoundOutcomeIpcUnavailableError extends Error {
  constructor(message = "CAPTCHA round outcome host bridge is unavailable.") {
    super(message);
    this.name = "CaptchaRoundOutcomeIpcUnavailableError";
  }
}

export class CaptchaRoundOutcomeIpcProtocolError extends Error {
  readonly reason: CaptchaRoundOutcomeIpcProtocolReason;

  constructor(reason: CaptchaRoundOutcomeIpcProtocolReason) {
    super(`CAPTCHA round outcome protocol rejected: ${reason}.`);
    this.name = "CaptchaRoundOutcomeIpcProtocolError";
    this.reason = reason;
  }
}

function errorValue(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function writeSocketFrame(socket: Socket, frame: string) {
  return new Promise<void>((resolve, reject) => {
    if (socket.destroyed) {
      reject(new CaptchaRoundOutcomeIpcUnavailableError());
      return;
    }
    try {
      socket.write(frame, "utf8", (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(errorValue(error));
    }
  });
}

function closeSocket(socket: Socket) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.end();
  });
}

async function connectSocket(
  endpoint: string,
  authenticationFrame: string,
): Promise<CaptchaRoundOutcomeIpcTransport> {
  let socket: Socket | null = null;
  const connected = new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      const value = errorValue(error);
      if (!settled) {
        settled = true;
        socket?.destroy();
        reject(new CaptchaRoundOutcomeIpcUnavailableError(value.message));
      }
    };
    try {
      socket = createConnection(endpoint);
      socket.once("error", fail);
      socket.once("close", () => {
        if (!settled) fail(new Error("Host bridge closed before authentication."));
      });
      socket.once("connect", () => {
        void writeSocketFrame(socket!, authenticationFrame).then(
          () => {
            if (settled) return;
            settled = true;
            socket!.unref();
            resolve(socket!);
          },
          fail,
        );
      });
    } catch (error) {
      fail(error);
    }
  });
  const authenticatedSocket = await connected;
  let closed = false;
  authenticatedSocket.on("error", () => {
    closed = true;
  });
  return {
    send(frame) {
      if (closed || authenticatedSocket.destroyed) {
        return Promise.reject(new CaptchaRoundOutcomeIpcUnavailableError());
      }
      return writeSocketFrame(authenticatedSocket, frame).catch((error) => {
        closed = true;
        authenticatedSocket.destroy();
        throw new CaptchaRoundOutcomeIpcUnavailableError(errorValue(error).message);
      });
    },
    close() {
      closed = true;
      return closeSocket(authenticatedSocket);
    },
  };
}

function configuredValue(explicit: string | undefined, environmentName: string) {
  return explicit === undefined
    ? process.env[environmentName]?.trim() ?? ""
    : explicit.trim();
}

function queued<T>(
  operation: { current: Promise<void> },
  task: () => Promise<T>,
) {
  const next = operation.current.then(task, task);
  operation.current = next.then(() => undefined, () => undefined);
  return next;
}

export type CaptchaRoundOutcomeReporter = {
  reportChallengeCaptured(input: {
    stageId: string;
    challengeKind: CaptchaRoundChallengeKind;
  }): Promise<void>;
  reportSucceeded(stageId: string): Promise<void>;
  reportSolverExhausted(stageId: string): Promise<void>;
  reportProviderRejected(
    stageId: string,
    proof: CaptchaProviderRejectionProof,
  ): Promise<void>;
  reportFailed(stageId: string, reason: CaptchaRoundFailureReason): Promise<void>;
  reportCancelled(stageId: string, reason: CaptchaRoundCancellationReason): Promise<void>;
  close(): Promise<void>;
};

/**
 * Create the workflow-side reporter for one CAPTCHA execution. The first
 * message on its socket is an authenticated handshake; subsequent messages
 * are strictly ordered and contain only bounded outcome metadata.
 */
export function createCaptchaRoundOutcomeReporter(
  options: CaptchaRoundOutcomeReporterOptions = {},
): CaptchaRoundOutcomeReporter {
  const endpoint = configuredValue(options.endpoint, CAPTCHA_ROUND_OUTCOME_ENDPOINT_ENV);
  const token = configuredValue(options.token, CAPTCHA_ROUND_OUTCOME_TOKEN_ENV);
  const executionId = configuredValue(
    options.executionId,
    CAPTCHA_ROUND_OUTCOME_EXECUTION_ID_ENV,
  );
  const connect = options.connect ?? connectSocket;
  const registeredProbes = options.providerRejectionProbes ?? [];
  const operation = { current: Promise.resolve() };
  let sequence = 0;
  let challengeCaptured = false;
  let capturedStageId: string | undefined;
  let terminal = false;
  let closed = false;
  let transport: CaptchaRoundOutcomeIpcTransport | null = null;
  let connection: Promise<CaptchaRoundOutcomeIpcTransport> | null = null;

  const ensureTransport = async () => {
    if (closed) throw new CaptchaRoundOutcomeIpcProtocolError("reporter-closed");
    if (transport) return transport;
    if (!endpoint || !isCaptchaRoundOutcomeToken(token) || !executionId || endpoint.length > 256) {
      throw new CaptchaRoundOutcomeIpcUnavailableError(
        "CAPTCHA round outcome host bridge is not configured.",
      );
    }
    if (!connection) {
      const authenticationFrame = captchaRoundOutcomeAuthFrame({ executionId, token });
      const pending = connect(endpoint, authenticationFrame);
      connection = pending;
      try {
        transport = await pending;
      } catch (error) {
        throw error instanceof CaptchaRoundOutcomeIpcUnavailableError
          ? error
          : new CaptchaRoundOutcomeIpcUnavailableError(errorValue(error).message);
      } finally {
        if (connection === pending) connection = null;
      }
    } else {
      transport = await connection;
    }
    return transport!;
  };

  const emit = (outcome: CaptchaRoundOutcome) => queued(operation, async () => {
    if (closed) throw new CaptchaRoundOutcomeIpcProtocolError("reporter-closed");
    if (outcome.kind === "captured" && challengeCaptured) {
      throw new CaptchaRoundOutcomeIpcProtocolError("capture-already-reported");
    }
    if (terminal) {
      throw new CaptchaRoundOutcomeIpcProtocolError("terminal-outcome-already-reported");
    }
    if (outcome.kind === "retryable" || outcome.kind === "succeeded") {
      if (!challengeCaptured) {
        throw new CaptchaRoundOutcomeIpcProtocolError("terminal-outcome-before-capture");
      }
    }
    if (challengeCaptured && outcome.stageId !== capturedStageId) {
      throw new CaptchaRoundOutcomeIpcProtocolError("stage-mismatch");
    }
    const message = createCaptchaRoundOutcomeMessage(executionId, sequence + 1, outcome);
    const frame = captchaRoundOutcomeFrame(message);
    const target = await ensureTransport();
    try {
      await target.send(frame);
    } catch (error) {
      transport = null;
      throw error instanceof CaptchaRoundOutcomeIpcUnavailableError
        ? error
        : new CaptchaRoundOutcomeIpcUnavailableError(errorValue(error).message);
    }
    sequence += 1;
    if (outcome.kind === "captured") {
      challengeCaptured = true;
      capturedStageId = outcome.stageId;
    } else {
      terminal = true;
    }
  });

  return {
    reportChallengeCaptured(input) {
      return emit({ kind: "captured", ...input });
    },
    reportSucceeded(stageId) {
      return emit({ kind: "succeeded", stageId });
    },
    reportSolverExhausted(stageId) {
      return emit({ kind: "retryable", stageId, reason: "solver-exhausted" });
    },
    reportProviderRejected(stageId, proof) {
      if (!isRegisteredCaptchaProviderRejectionProof(proof, registeredProbes)) {
        return Promise.reject(
          new CaptchaRoundOutcomeIpcProtocolError(
            "provider-rejection-probe-not-registered",
          ),
        );
      }
      return emit({
        kind: "retryable",
        stageId,
        reason: "provider-rejected",
        providerId: proof.providerId,
        probeId: proof.probeId,
      });
    },
    reportFailed(stageId, reason) {
      return emit({ kind: "failed", stageId, reason });
    },
    reportCancelled(stageId, reason) {
      return emit({ kind: "cancelled", stageId, reason });
    },
    close() {
      return queued(operation, async () => {
        if (closed) return;
        closed = true;
        const pending = connection;
        if (pending) {
          try {
            const pendingTransport = await pending;
            await pendingTransport.close();
          } catch {
            // Closing an unavailable bridge is intentionally idempotent.
          }
        }
        if (transport) {
          await transport.close().catch(() => undefined);
          transport = null;
        }
      });
    },
  };
}
