import { randomBytes, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import {
  createGmailOtpFrameParser,
  createGmailOtpLineParser,
  gmailOtpResponseFrame,
  GMAIL_OTP_IPC_ENDPOINT_ENV,
  GMAIL_OTP_IPC_TOKEN_BYTES,
  GMAIL_OTP_IPC_TOKEN_ENV,
  gmailOtpIpcAuthFrame,
  isGmailOtpIpcToken,
  parseGmailOtpIpcAuthFrame,
  parseGmailOtpRequestFrame,
  type GmailOtpFallbackReason,
  type GmailOtpRequest,
  type GmailOtpResponse,
} from "../gmail-otp.ts";

export type GmailOtpBrokerService = {
  ensureAccess(): Promise<{ status: "ready" | "fallback"; reason?: GmailOtpFallbackReason }>;
  prepareRetrieval(): Promise<
    | { status: "prepared"; boundaryId: string }
    | { status: "fallback"; reason: GmailOtpFallbackReason }
  >;
  retrieve(boundaryId: string): Promise<
    | { status: "found"; otp: string }
    | { status: "fallback"; reason: GmailOtpFallbackReason }
  >;
};

export type GmailOtpBrokerOptions = {
  requestStream: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    on(event: "end" | "close", listener: () => void): unknown;
  };
  responseStream: {
    write(chunk: string): boolean;
    end?(): void;
  };
  service: GmailOtpBrokerService;
  onProtocolError?: (reason: string) => void;
};

export type GmailOtpIpcServerOptions = {
  service: GmailOtpBrokerService;
  /** Used by deterministic tests; production uses a fresh short socket path. */
  endpoint?: string;
  token?: string;
  onProtocolError?: (reason: string) => void;
};

export type GmailOtpIpcServer = {
  endpoint: string;
  token: string;
  env: {
    [GMAIL_OTP_IPC_ENDPOINT_ENV]: string;
    [GMAIL_OTP_IPC_TOKEN_ENV]: string;
  };
  ready: Promise<void>;
  close(): Promise<void>;
};

function fallback(id: string, reason: GmailOtpFallbackReason): GmailOtpResponse {
  return { id, status: "fallback", reason };
}

function responseForRequest(
  request: GmailOtpRequest,
  service: GmailOtpBrokerService,
): Promise<GmailOtpResponse> {
  if (request.method === "ensure-access") {
    return service.ensureAccess().then((result) =>
      result.status === "ready"
        ? { id: request.id, status: "ready" }
        : fallback(request.id, result.reason ?? "authorization-failed"),
    );
  }
  if (request.method === "prepare-retrieval") {
    return service.prepareRetrieval().then((result) =>
      result.status === "prepared"
        ? { id: request.id, status: "prepared", boundaryId: result.boundaryId }
        : fallback(request.id, result.reason),
    );
  }
  return service.retrieve(request.boundaryId).then((result) =>
    result.status === "found"
      ? { id: request.id, status: "found", otp: result.otp }
      : fallback(request.id, result.reason),
  );
}

const GMAIL_OTP_AUTH_TIMEOUT_MS = 10_000;

function isNamedPipeEndpoint(endpoint: string) {
  return endpoint.startsWith("\\\\.\\pipe\\");
}

function createIpcEndpoint() {
  // Keep the Unix socket basename short because macOS imposes a small limit on
  // AF_UNIX addresses and tmpdir() itself can already be deeply nested.
  return process.platform === "win32"
    ? `\\\\.\\pipe\\octopusbeak-gmail-${randomUUID()}`
    : join(tmpdir(), `ob-gmail-${randomUUID().slice(0, 12)}.sock`);
}

async function unlinkIpcEndpoint(endpoint: string) {
  if (isNamedPipeEndpoint(endpoint)) return;
  try {
    await unlink(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Start the host side of the Gmail bridge on a local authenticated socket.
 * The endpoint and token are safe to pass through arbitrary child-process
 * layers as environment values; no descriptor number is relied upon.
 */
export function createGmailOtpIpcServer({
  service,
  endpoint = createIpcEndpoint(),
  token = randomBytes(GMAIL_OTP_IPC_TOKEN_BYTES).toString("base64url"),
  onProtocolError,
}: GmailOtpIpcServerOptions): GmailOtpIpcServer {
  if (!isGmailOtpIpcToken(token)) throw new TypeError("Gmail OTP IPC token is invalid.");
  let closed = false;
  let readySettled = false;
  let serverBound = false;
  let closePromise: Promise<void> | null = null;
  const sockets = new Set<Socket>();
  const report = (reason: string) => {
    try {
      onProtocolError?.(reason);
    } catch {
      // Diagnostics are best effort and must never affect the bridge.
    }
  };
  const server: Server = createServer((socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let authenticated = false;
    let terminated = false;
    const parser = createGmailOtpLineParser((line) => {
      if (terminated) return;
      if (!authenticated) {
        const auth = parseGmailOtpIpcAuthFrame(line);
        if (!auth || auth.token !== token) {
          report("invalid-authentication");
          terminated = true;
          socket.destroy();
          return;
        }
        authenticated = true;
        socket.setTimeout(0);
        return;
      }
      const request = parseGmailOtpRequestFrame(line);
      if (!request) {
        report("invalid-request-frame");
        terminated = true;
        socket.destroy();
        return;
      }
      void responseForRequest(request, service)
        .then((response) => {
          if (terminated || closed || socket.destroyed) return;
          try {
            socket.write(gmailOtpResponseFrame(response), (error) => {
              if (error) {
                report("response-write-failed");
                terminated = true;
                socket.destroy();
              }
            });
          } catch {
            report("response-write-failed");
            terminated = true;
            socket.destroy();
          }
        })
        .catch(() => {
          if (terminated || closed || socket.destroyed) return;
          try {
            socket.write(gmailOtpResponseFrame({
              id: request.id,
              status: "fallback",
              reason: "protocol-error",
            }));
          } catch {
            report("response-write-failed");
            terminated = true;
            socket.destroy();
          }
        });
    });
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      parser.flush();
      sockets.delete(socket);
    };
    socket.setTimeout(GMAIL_OTP_AUTH_TIMEOUT_MS, () => {
      report("authentication-timeout");
      socket.destroy();
    });
    socket.on("data", (chunk) => {
      if (terminated) return;
      const before = parser.invalidFrameCount();
      parser.push(chunk);
      if (parser.invalidFrameCount() > before) {
        report("invalid-frame");
        socket.destroy();
      }
    });
    socket.on("error", () => {
      report("socket-error");
      terminate();
    });
    socket.on("end", terminate);
    socket.on("close", () => {
      terminate();
      sockets.delete(socket);
    });
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => {
      serverBound = true;
      readySettled = true;
      resolve();
    });
    server.on("error", () => {
      report("server-error");
      if (!readySettled) {
        readySettled = true;
        reject(new Error("Gmail OTP IPC server could not start."));
      }
    });
    try {
      server.listen(endpoint);
    } catch {
      readySettled = true;
      reject(new Error("Gmail OTP IPC server could not start."));
    }
  });

  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    for (const socket of sockets) socket.destroy();
    closePromise = new Promise<void>((resolve) => {
      const cleanup = () => {
        const removeEndpoint = serverBound
          ? unlinkIpcEndpoint(endpoint)
          : Promise.resolve();
        void removeEndpoint.then(
          () => resolve(),
          () => {
            report("endpoint-cleanup-failed");
            resolve();
          },
        );
      };
      if (!server.listening) cleanup();
      else server.close(cleanup);
    });
    return closePromise;
  };

  void ready.catch(() => close());
  return {
    endpoint,
    token,
    env: {
      [GMAIL_OTP_IPC_ENDPOINT_ENV]: endpoint,
      [GMAIL_OTP_IPC_TOKEN_ENV]: token,
    },
    ready,
    close,
  };
}

/**
 * Attach the private child-to-host request and host-to-child response pipes.
 * The returned disposer is used when the task child exits.  Invalid frames
 * are ignored and cannot cause a host exception or leak to the task log.
 */
export function attachGmailOtpBroker({
  requestStream,
  responseStream,
  service,
  onProtocolError,
}: GmailOtpBrokerOptions) {
  let closed = false;
  let writeChain = Promise.resolve();
  const report = (reason: string) => {
    try {
      onProtocolError?.(reason);
    } catch {
      // Diagnostics are best effort and must never affect the bridge.
    }
  };
  const send = (response: GmailOtpResponse) => {
    if (closed) return;
    const frame = gmailOtpResponseFrame(response);
    writeChain = writeChain
      .then(() => {
        if (!closed) responseStream.write(frame);
      })
      .catch(() => {
        closed = true;
        report("response-write-failed");
      });
  };
  const handle = (value: unknown) => {
    const request = value as GmailOtpRequest | null;
    if (!request) {
      report("invalid-request-frame");
      return;
    }
    void responseForRequest(request, service)
      .then(send)
      .catch(() => send(fallback(request.id, "protocol-error")));
  };
  const parser = createGmailOtpFrameParser(handle, parseGmailOtpRequestFrame);
  const onData = (chunk: Buffer) => {
    const before = parser.invalidFrameCount();
    parser.push(chunk);
    if (parser.invalidFrameCount() > before) report("invalid-request-frame");
  };
  const onEnd = () => {
    parser.flush();
    closed = true;
  };
  requestStream.on("data", onData);
  requestStream.on("end", onEnd);
  requestStream.on("close", onEnd);
  return {
    close() {
      onEnd();
      try {
        responseStream.end?.();
      } catch {
        report("response-close-failed");
      }
    },
    invalidFrameCount() {
      return parser.invalidFrameCount();
    },
  };
}
