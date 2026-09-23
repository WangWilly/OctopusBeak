import { createConnection, type Socket } from "node:net";
import {
  createPGliteOperationalRpcClient,
  type PGliteOperationalOperation,
  type PGliteOperationalRpcClient,
} from "./pglite-operational-rpc.ts";
import {
  createPGliteFinancialRpcClient,
  type PGliteFinancialOperation,
  type PGliteFinancialRegistry,
  type PGliteFinancialRequestOptions,
  type PGliteFinancialRpcClient,
} from "./pglite-financial-rpc-client.ts";
import {
  createPGliteWorkflowClient,
  type PGliteWorkflowClient,
  type PGliteWorkflowCommand,
  type PGliteWorkflowCommandResult,
  type PGliteWorkflowRequestOptions,
  type PGliteWorkflowTransport,
} from "../src/ledger/pglite/workflow-client.ts";

export const PGLITE_CHILD_RPC_ENDPOINT_ENV =
  "OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT" as const;
export const PGLITE_CHILD_RPC_TOKEN_ENV =
  "OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN" as const;
export const PGLITE_CHILD_RPC_VERSION = 1 as const;
export const PGLITE_CHILD_RPC_TOKEN_BYTES = 32 as const;

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export type PGliteChildOperation =
  | PGliteOperationalOperation
  | PGliteFinancialOperation;

type AuthFrame = {
  readonly kind: "pglite-child-auth";
  readonly version: typeof PGLITE_CHILD_RPC_VERSION;
  readonly token: string;
};

type SocketMessageListener = (value: unknown) => void;

type SocketMessagePort = {
  on(event: "message", listener: SocketMessageListener): unknown;
  off(event: "message", listener: SocketMessageListener): unknown;
  postMessage(value: unknown): void;
  close(): void;
};

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/u.test(token);
}

function safeTransportError(code: PGliteChildTransportError["code"]): PGliteChildTransportError {
  return new PGliteChildTransportError(code);
}

/** A bounded, newline-delimited JSON socket adapter for the existing RPC ports. */
class LineSocketPort implements SocketMessagePort {
  #listeners = new Set<SocketMessageListener>();
  #buffer = "";
  #closed = false;
  #writeQueue = Promise.resolve();
  private readonly socket: Socket;
  private readonly onProtocolError: (reason: string) => void;

  constructor(
    socket: Socket,
    onProtocolError: (reason: string) => void,
  ) {
    this.socket = socket;
    this.onProtocolError = onProtocolError;
    socket.on("data", (chunk: Buffer) => this.#read(chunk));
  }

  on(_event: "message", listener: SocketMessageListener): void {
    this.#listeners.add(listener);
  }

  off(_event: "message", listener: SocketMessageListener): void {
    this.#listeners.delete(listener);
  }

  postMessage(value: unknown): void {
    if (this.#closed || this.socket.destroyed) throw safeTransportError("closed");
    let frame: string;
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized !== "string") {
        this.onProtocolError("frame-serialization-failed");
        this.close();
        return;
      }
      frame = serialized;
    } catch {
      this.onProtocolError("frame-serialization-failed");
      return;
    }
    if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
      this.onProtocolError("frame-too-large");
      this.close();
      return;
    }
    this.#writeQueue = this.#writeQueue
      .then(() => new Promise<void>((resolve, reject) => {
        if (this.#closed || this.socket.destroyed) {
          reject(safeTransportError("closed"));
          return;
        }
        this.socket.write(`${frame}\n`, (error) => error ? reject(error) : resolve());
      }))
      .catch(() => {
        this.onProtocolError("socket-write-failed");
        this.close();
      });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.socket.destroy();
  }

  /** Let an authentication response reach the peer before destroying it. */
  async drain(): Promise<void> {
    await this.#writeQueue.catch(() => undefined);
  }

  #read(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_FRAME_BYTES) {
      this.onProtocolError("frame-too-large");
      this.close();
      return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          const value = JSON.parse(line) as unknown;
          for (const listener of this.#listeners) {
            try {
              listener(value);
            } catch {
              this.onProtocolError("message-listener-failed");
            }
          }
        } catch {
          this.onProtocolError("invalid-json-frame");
        }
      }
      newline = this.#buffer.indexOf("\n");
    }
  }
}

export class PGliteChildTransportError extends Error {
  readonly code:
    | "missing-endpoint"
    | "invalid-authentication"
    | "connection-failed"
    | "closed";

  constructor(code: PGliteChildTransportError["code"]) {
    super(
      code === "missing-endpoint"
        ? "PGlite workflow transport requires the parent worker endpoint."
        : code === "invalid-authentication"
          ? "PGlite workflow transport authentication failed."
          : code === "connection-failed"
            ? "PGlite workflow transport could not connect to the parent worker."
            : "PGlite workflow transport is closed.",
    );
    this.name = "PGliteChildTransportError";
    this.code = code;
  }
}

export type PGliteChildRpcClient = Readonly<{
  ready: Promise<void>;
  operationalProvider: PGliteOperationalRpcClient["provider"];
  financial: PGliteFinancialRpcClient["registry"];
  workflow: PGliteWorkflowClient;
  request<K extends PGliteChildOperation>(operation: K, args: readonly unknown[], options?: PGliteFinancialRequestOptions): Promise<unknown>;
  close(error?: Error): void;
}>;

export type PGliteChildRpcClientOptions = {
  endpoint?: string;
  token?: string;
  environment?: NodeJS.ProcessEnv;
};

function financialOperationForWorkflow(command: PGliteWorkflowCommand): PGliteFinancialOperation {
  switch (command.kind) {
    case "canonical.source.admit": return "financial.source.admit";
    case "canonical.financial.commit": return "financial.source.commit";
    case "canonical.financial.commit-batch": return "financial.source.commitBatch";
    case "canonical.deposit.commit": return "financial.deposit.commit";
    case "canonical.mixed.commit": return "financial.mixed.commit";
    case "canonical.balance.capture": return "financial.balance.capture";
    case "canonical.einvoice.commit": return "financial.einvoice.commit";
    case "canonical.credit-card.commit": return "financial.creditCard.commit";
    case "canonical.credit-card.balance": return "financial.creditCard.balance";
    case "canonical.loan.commit": return "financial.loan.commit";
    case "canonical.investment.commit": return "financial.investment.commit";
    case "canonical.loan-repayment-relations.resolve": return "financial.loanRelations.resolve";
    case "canonical.investment-funding-relations.resolve": return "financial.investmentRelations.resolve";
  }
}

function endpointAndToken(options: PGliteChildRpcClientOptions): { endpoint: string; token: string } {
  const environment = options.environment ?? process.env;
  const endpoint = options.endpoint ?? environment[PGLITE_CHILD_RPC_ENDPOINT_ENV];
  const token = options.token ?? environment[PGLITE_CHILD_RPC_TOKEN_ENV];
  if (!endpoint || !token) throw safeTransportError("missing-endpoint");
  if (!validToken(token)) throw safeTransportError("invalid-authentication");
  return { endpoint, token };
}

/** Connect a workflow child to the named registries exposed by its parent. */
export function createPGliteChildRpcClient(
  options: PGliteChildRpcClientOptions = {},
): PGliteChildRpcClient {
  const { endpoint, token } = endpointAndToken(options);
  const socket = createConnection(endpoint);
  const port = new LineSocketPort(socket, () => undefined);
  let closed = false;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  const authResponse = (value: unknown): void => {
    if (!plainRecord(value) || value.kind !== "pglite-child-auth-response" || value.version !== PGLITE_CHILD_RPC_VERSION) return;
    if (readySettled) return;
    readySettled = true;
    if (value.ok === true) resolveReady();
    else rejectReady(safeTransportError(value.code === "invalid-authentication" ? "invalid-authentication" : "connection-failed"));
  };
  port.on("message", authResponse);
  const operational = createPGliteOperationalRpcClient(port, ready);
  const financial = createPGliteFinancialRpcClient(port, ready);
  const workflowTransport: PGliteWorkflowTransport = {
    execute: <Command extends PGliteWorkflowCommand>(
      command: Command,
      options?: PGliteWorkflowRequestOptions,
    ): Promise<PGliteWorkflowCommandResult<Command>> => financial.request(
      financialOperationForWorkflow(command),
      [command.request],
      options,
    ) as Promise<PGliteWorkflowCommandResult<Command>>,
  };
  const workflow = createPGliteWorkflowClient(workflowTransport);
  const fail = (error: PGliteChildTransportError["code"]): void => {
    if (closed) return;
    closed = true;
    if (!readySettled) {
      readySettled = true;
      rejectReady(safeTransportError(error));
    }
    operational.close(safeTransportError(error));
    financial.close(safeTransportError(error));
  };
  socket.once("connect", () => {
    try {
      port.postMessage({
        kind: "pglite-child-auth",
        version: PGLITE_CHILD_RPC_VERSION,
        token,
      } satisfies AuthFrame);
    } catch {
      fail("connection-failed");
    }
  });
  socket.once("error", () => fail("connection-failed"));
  socket.once("close", () => {
    if (!closed) fail("closed");
  });
  const request = <K extends PGliteChildOperation>(operation: K, args: readonly unknown[], options?: PGliteFinancialRequestOptions): Promise<unknown> => {
    if (operation.startsWith("automation.") || operation.startsWith("exchangeRates."))
      return operational.request(operation as PGliteOperationalOperation, args);
    return financial.request(operation as PGliteFinancialOperation, args, options);
  };
  const close = (error = safeTransportError("closed")): void => {
    if (closed) return;
    closed = true;
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    port.off("message", authResponse);
    operational.close(error);
    financial.close(error);
    port.close();
  };
  return Object.freeze({
    ready,
    operationalProvider: operational.provider,
    financial: financial.registry,
    workflow,
    request,
    close,
  });
}

/** Fail explicitly when an enabled workflow was launched without its owner. */
export function requirePGliteChildRpcClientFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): PGliteChildRpcClient {
  return createPGliteChildRpcClient({ environment });
}
