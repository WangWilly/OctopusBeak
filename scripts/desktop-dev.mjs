import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { superviseProcess } from "./desktop-process-supervisor.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const electron = createRequire(import.meta.url)("electron");
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
