import { createConnection, type Socket } from "node:net";
import {
  createGmailOtpFrameParser,
  createGmailOtpRequestId,
  gmailOtpFallbackReason,
  gmailOtpIpcAuthFrame,
  gmailOtpRequestFrame,
  parseGmailOtpResponseFrame,
  GMAIL_OTP_IPC_ENDPOINT_ENV,
  GMAIL_OTP_IPC_TOKEN_ENV,
  isGmailOtpIpcToken,
  type GmailOtpFallbackReason,
  type GmailOtpRequest,
  type GmailOtpResponse,
} from "../lib/automation/gmail-otp.ts";

export { gmailOtpFallbackReason };

export type GmailOtpAccessResult =
  | { status: "ready" }
  | { status: "fallback"; reason: GmailOtpFallbackReason };

export type GmailOtpRetrievalResult =
  | { status: "found"; otp: string }
  | { status: "fallback"; reason: GmailOtpFallbackReason };

export type GmailOtpBoundaryResult =
  | { status: "prepared"; boundaryId: string }
  | { status: "fallback"; reason: GmailOtpFallbackReason };

type PendingRequest = {
  resolve: (response: GmailOtpResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let ipcEndpoint: string | null | undefined;
let ipcToken: string | null | undefined;
let ipcSocket: Socket | null = null;
let ipcConnection: Promise<Socket> | null = null;
const pending = new Map<string, PendingRequest>();

function configuredIpc() {
  if (ipcEndpoint === undefined) {
    const value = process.env[GMAIL_OTP_IPC_ENDPOINT_ENV];
    ipcEndpoint = value?.trim() || null;
  }
  if (ipcToken === undefined) {
    const value = process.env[GMAIL_OTP_IPC_TOKEN_ENV];
    ipcToken = isGmailOtpIpcToken(value) ? value : null;
  }
  if (!ipcEndpoint || !ipcToken || ipcEndpoint.length > 256) return null;
  return { endpoint: ipcEndpoint, token: ipcToken };
}

function rejectPending(error: Error) {
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    request.reject(error);
    pending.delete(id);
  }
}

function ensureResponseReader(timeoutMs: number): Promise<Socket> {
  if (ipcSocket && !ipcSocket.destroyed) return Promise.resolve(ipcSocket);
  if (ipcConnection) return ipcConnection;
  const config = configuredIpc();
  if (!config) return Promise.reject(new Error("Gmail OTP host bridge is not configured."));

  const connection = new Promise<Socket>((resolve, reject) => {
    let settled = false;
    let connected = false;
    const socket = createConnection(config.endpoint);
    const parser = createGmailOtpFrameParser((value) => {
      const response = value as GmailOtpResponse;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      clearTimeout(request.timer);
      request.resolve(response);
    }, parseGmailOtpResponseFrame);
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(error);
      } else {
        socket.destroy();
      }
    };
    socket.setTimeout(timeoutMs, () => fail(new Error("Gmail OTP host bridge timed out.")));
    socket.on("data", (chunk) => {
      if (settled && !connected) return;
      const before = parser.invalidFrameCount();
      parser.push(chunk);
      if (parser.invalidFrameCount() > before) {
        fail(new Error("Gmail OTP host bridge sent an invalid frame."));
      }
    });
    socket.on("error", (error) => {
      if (!settled) fail(error instanceof Error ? error : new Error(String(error)));
      else rejectPending(new Error("Gmail OTP host bridge closed."));
    });
    socket.on("close", () => {
      if (ipcSocket === socket) ipcSocket = null;
      if (!connected && !settled) {
        settled = true;
        reject(new Error("Gmail OTP host bridge closed before authentication."));
      } else if (connected) {
        rejectPending(new Error("Gmail OTP host bridge closed."));
      }
    });
    socket.once("connect", () => {
      socket.setTimeout(0);
      try {
        socket.write(gmailOtpIpcAuthFrame(config.token), "utf8", (error) => {
          if (error) {
            fail(error);
            return;
          }
          connected = true;
          ipcSocket = socket;
          // The workflow owns the request lifetime. The bridge must not keep a
          // workflow that has otherwise completed alive merely because the
          // authenticated socket is idle.
          socket.unref();
          settled = true;
          resolve(socket);
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  ipcConnection = connection;
  const clearConnection = () => {
    if (ipcConnection === connection) ipcConnection = null;
  };
  void connection.then(clearConnection, clearConnection);
  return connection;
}

function requestHost(request: GmailOtpRequest, timeoutMs = 130_000) {
  if (!configuredIpc()) {
    return Promise.resolve<GmailOtpResponse>({
      id: request.id,
      status: "fallback",
      reason: "not-configured",
    });
  }
  return ensureResponseReader(timeoutMs).then((socket) => new Promise<GmailOtpResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request.id);
      socket.destroy();
      reject(new Error("Gmail OTP host bridge timed out."));
    }, timeoutMs);
    pending.set(request.id, { resolve, reject, timer });
    try {
      socket.write(gmailOtpRequestFrame(request), "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(request.id);
        socket.destroy();
        reject(error);
      });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(request.id);
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }));
}

function fallbackFromError(error: unknown): GmailOtpFallbackReason {
  return error instanceof Error && /timed out/i.test(error.message)
    ? "timeout"
    : "protocol-error";
}

/** Ask the host to establish usable Gmail authorization without exposing a token. */
export async function ensureCathayGmailOtpAccess(): Promise<GmailOtpAccessResult> {
  try {
    const response = await requestHost({ id: createGmailOtpRequestId(), method: "ensure-access" });
    if (response.status === "ready") return { status: "ready" };
    if (response.status === "fallback") return { status: "fallback", reason: response.reason };
    return { status: "fallback", reason: "protocol-error" };
  } catch (error) {
    return { status: "fallback", reason: fallbackFromError(error) };
  }
}

/** Snapshot existing Cathay OTP messages before asking the bank to send one. */
export async function prepareCathayGmailOtpRetrieval(): Promise<GmailOtpBoundaryResult> {
  try {
    const response = await requestHost({ id: createGmailOtpRequestId(), method: "prepare-retrieval" });
    if (response.status === "prepared")
      return { status: "prepared", boundaryId: response.boundaryId };
    if (response.status === "fallback") return { status: "fallback", reason: response.reason };
    return { status: "fallback", reason: "protocol-error" };
  } catch (error) {
    return { status: "fallback", reason: fallbackFromError(error) };
  }
}

/** Ask the host to poll Gmail for a message absent from the prepared snapshot. */
export async function retrieveCathayGmailOtp(
  boundaryId: string,
): Promise<GmailOtpRetrievalResult> {
  if (!/^[0-9a-f-]{8,64}$/i.test(boundaryId))
    return { status: "fallback", reason: "protocol-error" };
  try {
    const response = await requestHost({
      id: createGmailOtpRequestId(),
      method: "retrieve",
      boundaryId,
    });
    if (response.status === "found") return { status: "found", otp: response.otp };
    if (response.status === "fallback") return { status: "fallback", reason: response.reason };
    return { status: "fallback", reason: "protocol-error" };
  } catch (error) {
    return { status: "fallback", reason: fallbackFromError(error) };
  }
}

/** Test-only reset; it closes the local client socket and clears env caches. */
export function resetCathayGmailOtpClientForTests() {
  ipcSocket?.destroy();
  ipcSocket = null;
  ipcConnection = null;
  ipcEndpoint = undefined;
  ipcToken = undefined;
  rejectPending(new Error("Gmail OTP host bridge reset."));
}
