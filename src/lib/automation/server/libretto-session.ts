import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type LibrettoSessionState = {
  session: string;
  port: number;
  pid?: number;
  cdpEndpoint?: string;
  status?: string;
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

export function librettoSessionLogPath(session: string) {
  return join(dirname(librettoSessionPath(session)), "logs.jsonl");
}

export function parseLibrettoSessionState(text: string): LibrettoSessionState {
  const raw = JSON.parse(text) as {
    session?: unknown;
    port?: unknown;
    pid?: unknown;
    cdpEndpoint?: unknown;
    status?: unknown;
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
    status: typeof raw.status === "string" ? raw.status : undefined,
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

function isTerminalSessionEvent(event: string) {
  return /(?:child[-_](?:exit|close|closed|killed|termination|terminated)|(?:^|[-_])(?:close|closed|killed|kill|termination|terminated|sigterm|sigkill|shutdown|exit)(?:$|[-_]))/i.test(event);
}

export function cdpEndpointFromSessionLog(state: LibrettoSessionState, text: string) {
  if (state.port !== 0 || state.cdpEndpoint || !state.pid) return null;
  let endpoint: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    const eventName = typeof record.event === "string" ? record.event : "";
    const data = record.data;
    if (!data || typeof data !== "object") continue;
    const child = data as Record<string, unknown>;
    if (eventName === "child-launched") {
      if (record.scope !== "libretto.child" || child.session !== state.session || Number(child.pid) !== state.pid) continue;
      const port = Number(child.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
      endpoint = `http://127.0.0.1:${port}`;
      continue;
    }
    if (!isTerminalSessionEvent(eventName) || child.session !== state.session) continue;
    if (child.pid !== undefined && Number(child.pid) !== state.pid) continue;
    endpoint = null;
  }
  return endpoint;
}

export function cdpEndpointForSession(session: string) {
  const state = readLibrettoSessionState(session);
  if (!state) return null;
  const direct = cdpEndpointFromState(state);
  if (direct) return direct;
  const logPath = librettoSessionLogPath(session);
  if (!existsSync(logPath)) return null;
  return cdpEndpointFromSessionLog(state, readFileSync(logPath, "utf8"));
}
