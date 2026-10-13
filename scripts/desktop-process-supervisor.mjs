import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { constants } from "node:os";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signalCode = (signal) => 128 + (constants.signals[signal] ?? 1);

async function storageIdentity(path, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      stat(path, { bigint: true }).then(({ dev, ino }) => ({ dev, ino })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Backing storage did not respond.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Own a POSIX process group, including children orphaned by an Electron crash.
 * This module uses only built-ins: once loaded, its JS and the host Node runtime
 * can keep running when an external project volume is forcibly unmounted.
 */
export async function superviseProcess({
  command,
  args = [],
  cwd,
  env = process.env,
  stdio = "inherit",
  watchPaths = [],
  signal,
  pollMs = 1000,
  graceMs = 3000,
  healthTimeoutMs = 1500,
  report = (message) => console.error(message),
}) {
  if (process.platform === "win32") throw new Error("Desktop development supervision requires macOS or Linux process groups.");
  const interrupted = () => ({ reason: "interrupted", code: signalCode(typeof signal?.reason === "string" ? signal.reason : "SIGINT") });
  if (signal?.aborted) return interrupted();
  const identities = await Promise.all(watchPaths.map((path) => storageIdentity(path, healthTimeoutMs)));
  if (signal?.aborted) return interrupted();

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio, detached: true });
    let stopping = false;
    let pollTimer;
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const groupExists = () => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; } catch (error) {
        if (error.code === "ESRCH") return false;
        // macOS can briefly return EPERM while Electron's sandboxed group is
        // exiting. It does not prove the group is gone; keep the bounded wait.
        if (error.code === "EPERM") return true;
        throw error;
      }
    };
    const send = (signal) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const stop = async (result) => {
      if (stopping) return;
      stopping = true;
      clearTimeout(pollTimer);
      signal?.removeEventListener("abort", onAbort);
      let cleanupStage = "terminate";
      try {
        // Keep cleaning the owned group even after the main PID has exited.
        send("SIGTERM");
        cleanupStage = "wait-for-group";
        const deadline = Date.now() + graceMs;
        while (groupExists() && Date.now() < deadline) await delay(25);
        cleanupStage = "force-terminate";
        if (groupExists()) send("SIGKILL");
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          await Promise.race([exited, delay(1000)]);
        }
        resolve(result);
      } catch (error) {
        report(`[desktop:dev] Unable to finish cleaning the owned process group (${cleanupStage}: ${error.code ?? "unknown"}).`);
        resolve({ reason: "cleanup-failed", code: 1 });
      }
    };
    const onAbort = () => { void stop(interrupted()); };
    const poll = async () => {
      try {
        const current = await Promise.all(watchPaths.map((path) => storageIdentity(path, healthTimeoutMs)));
        if (current.some(({ dev, ino }, index) => dev !== identities[index].dev || ino !== identities[index].ino)) {
          throw new Error("Backing storage was replaced.");
        }
      } catch {
        if (!stopping) {
          report("[desktop:dev] Project storage became unavailable or changed; stopping this desktop process group.");
          await stop({ reason: "storage-unavailable", code: 1 });
        }
        return;
      }
      if (!stopping) pollTimer = setTimeout(poll, pollMs);
    };
    child.once("error", () => {
      resolveExit();
      report("[desktop:dev] Electron could not start.");
      void stop({ reason: "launch-failed", code: 1 });
    });
    child.once("exit", (code, exitSignal) => {
      resolveExit();
      void stop({ reason: "exited", code: code ?? signalCode(exitSignal) });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else pollTimer = setTimeout(poll, pollMs);
  });
}
