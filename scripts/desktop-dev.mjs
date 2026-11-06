import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { superviseProcess } from "./desktop-process-supervisor.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const electron = createRequire(import.meta.url)("electron");
// A development run records sanitized workflow failure diagnostics by default
// (ADR 0109); set the variable to another path to move them, or to "" to stop.
const DEFAULT_WORKFLOW_DIAGNOSTICS_FILE = "/private/tmp/octopusbeak-workflow-failures.jsonl";
const env = {
  ...process.env,
  OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE:
    process.env.OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE ?? DEFAULT_WORKFLOW_DIAGNOSTICS_FILE,
};
if (env.OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE.trim())
  console.log(`[desktop:dev] Workflow failure diagnostics: ${env.OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE}`);
const abort = new AbortController();
const handlers = new Map();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => abort.abort(signal);
  handlers.set(signal, handler);
  process.on(signal, handler);
}

try {
  const result = await superviseProcess({
    command: electron,
    args: [root, ...process.argv.slice(2)],
    cwd: root,
    env,
    watchPaths: [root, dirname(electron), join(root, "electron", "main.cjs")],
    signal: abort.signal,
  });
  process.exitCode = result.code;
} catch {
  console.error("[desktop:dev] Project storage or the Electron runtime is unavailable; launch cancelled.");
  process.exitCode = 1;
} finally {
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
}
