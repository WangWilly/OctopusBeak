import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LibrettoSessionState = {
  session: string;
  port: number;
  pid?: number;
  cdpEndpoint?: string;
  viewport?: { width: number; height: number };
};

export function validateLibrettoSessionName(session: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(session) || session.includes("..")) {
    throw new Error(`Invalid Libretto session: ${session}`);
  }
  return session;
}

export function librettoSessionPath(session: string) {
  return join(
    process.cwd(),
    ".libretto",
    "sessions",
    validateLibrettoSessionName(session),
    "state.json",
  );
}

export function parseLibrettoSessionState(text: string): LibrettoSessionState {
  const raw = JSON.parse(text) as {
    session?: unknown;
    port?: unknown;
    pid?: unknown;
    cdpEndpoint?: unknown;
    viewport?: unknown;
  };
  const session = validateLibrettoSessionName(String(raw.session ?? ""));
  const port = Number(raw.port ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid Libretto session port: ${raw.port}`);
  }
  const pid = raw.pid === undefined ? undefined : Number(raw.pid);
  if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) {
    throw new Error("Invalid Libretto session pid: " + String(raw.pid));
  }
  const viewport = raw.viewport && typeof raw.viewport === "object"
    ? raw.viewport as { width: number; height: number }
    : undefined;
  return {
    session,
    port,
    pid,
    cdpEndpoint: typeof raw.cdpEndpoint === "string" ? raw.cdpEndpoint : undefined,
    viewport,
  };
}

export function readLibrettoSessionState(session: string) {
  const statePath = librettoSessionPath(session);
  if (!existsSync(statePath)) return null;
  return parseLibrettoSessionState(readFileSync(statePath, "utf8"));
}

export function cdpEndpointFromState(state: LibrettoSessionState | Pick<LibrettoSessionState, "port" | "cdpEndpoint">) {
  if (state.cdpEndpoint) return state.cdpEndpoint;
  if (state.port > 0) return `http://127.0.0.1:${state.port}`;
  return null;
}

export function cdpEndpointForSession(session: string) {
  const state = readLibrettoSessionState(session);
  return state ? cdpEndpointFromState(state) : null;
}
