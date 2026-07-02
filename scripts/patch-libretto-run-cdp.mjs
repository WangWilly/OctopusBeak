import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

export function resolveLibrettoExecutionPath(appRoot = process.env.OCTOPUSBEAK_APP_ROOT ?? resolve(scriptDir, "..")) {
  return join(appRoot, "node_modules", "libretto", "dist", "cli", "commands", "execution.js");
}

const freePortHelper = `
async function pickFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        server.close(() => resolve(address.port));
        return;
      }
      server.close(() => reject(new Error("Failed to resolve debug port")));
    });
  });
}
`;

export function patchExecutionSource(source) {
  let next = source;
  const debugPortLine = "  const runDebugPort = args.providerName ? undefined : await pickFreePort();\n";

  if (!next.includes('import { createServer } from "node:net";')) {
    next = next.replace(
      'import { readFileSync } from "node:fs";',
      'import { readFileSync } from "node:fs";\nimport { createServer } from "node:net";',
    );
  }

  if (!next.includes("async function pickFreePort()")) {
    next = next.replace(
      "const require2 = moduleBuiltin.createRequire(import.meta.url);\n",
      `const require2 = moduleBuiltin.createRequire(import.meta.url);\n${freePortHelper}`,
    );
  }

  next = next.replace(
    `  const handlers = createWorkflowHandlers(workflowOutcome.resolve);\n${debugPortLine}  let client;`,
    "  const handlers = createWorkflowHandlers(workflowOutcome.resolve);\n  let client;",
  );

  next = next.replace(
    "...!args.headless && args.windowPosition ? { windowPosition: args.windowPosition } : {}\n  };",
    "...!args.headless && args.windowPosition ? { windowPosition: args.windowPosition } : {},\n    ...(args.remoteDebuggingPort ? { remoteDebuggingPort: args.remoteDebuggingPort } : {})\n  };",
  );

  if (!next.includes(debugPortLine)) {
    next = next.replace(
      "  const {\n    pid,\n    socketPath: daemonSocketPath,\n    provider,\n    client\n  } = await DaemonClient.spawn({",
      `${debugPortLine}  const {\n    pid,\n    socketPath: daemonSocketPath,\n    provider,\n    client\n  } = await DaemonClient.spawn({`,
    );
  }

  next = next.replace(
    "browser: createRunBrowserConfig(args)",
    "browser: createRunBrowserConfig({ ...args, remoteDebuggingPort: runDebugPort })",
  );

  next = next.replace("port: 0,", "port: runDebugPort ?? 0,");

  return next;
}

export function patchInstalledLibretto() {
  const executionPath = resolveLibrettoExecutionPath();
  if (!existsSync(executionPath)) {
    console.log("libretto execution.js not found; skipping CDP patch until dependencies are installed.");
    return false;
  }

  const before = readFileSync(executionPath, "utf8");
  const after = patchExecutionSource(before);
  if (after === before) {
    console.log("libretto run CDP patch already applied.");
    return true;
  }
  writeFileSync(executionPath, after, "utf8");
  console.log("Applied libretto run CDP patch.");
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  patchInstalledLibretto();
}
