import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

export function resolveLibrettoExecutionPath(
  appRoot = process.env.OCTOPUSBEAK_APP_ROOT ?? resolve(scriptDir, ".."),
) {
  return join(
    appRoot,
    "node_modules",
    "libretto",
    "dist",
    "cli",
    "commands",
    "execution.js",
  );
}

export function resolveLibrettoSessionTelemetryPath(
  appRoot = process.env.OCTOPUSBEAK_APP_ROOT ?? resolve(scriptDir, ".."),
) {
  return join(
    appRoot,
    "node_modules",
    "libretto",
    "dist",
    "cli",
    "core",
    "session-telemetry.js",
  );
}

export function resolveLibrettoSessionLogsPath(
  appRoot = process.env.OCTOPUSBEAK_APP_ROOT ?? resolve(scriptDir, ".."),
) {
  return join(
    appRoot,
    "node_modules",
    "libretto",
    "dist",
    "cli",
    "core",
    "session-logs.js",
  );
}

export function resolveLibrettoBrowserPath(
  appRoot = process.env.OCTOPUSBEAK_APP_ROOT ?? resolve(scriptDir, ".."),
) {
  return join(
    appRoot,
    "node_modules",
    "libretto",
    "dist",
    "cli",
    "core",
    "browser.js",
  );
}

export function redactSessionActionEntry(entry) {
  const safe = {};
  for (const key of [
    "ts",
    "pageId",
    "action",
    "source",
    "duration",
    "success",
  ]) {
    if (entry[key] !== undefined) safe[key] = entry[key];
  }
  if (typeof entry.url === "string") {
    try {
      safe.url = new URL(entry.url).pathname;
    } catch {
      safe.url = "[redacted-url]";
    }
  }
  if (entry.error) safe.error = "action-failed";
  return safe;
}

export function redactSessionNetworkEntry(entry) {
  const requestHeaders = entry.requestHeaders ?? {};
  const responseHeaders = entry.responseHeaders ?? {};
  let url = "[redacted-url]";
  try {
    url = new URL(entry.url).pathname;
  } catch {
    // Keep the safe placeholder for malformed or non-HTTP URLs.
  }
  return {
    ts: entry.ts,
    id: entry.id,
    pageId: entry.pageId,
    method: entry.method,
    url,
    resourceType: entry.resourceType,
    status: entry.status,
    statusText: entry.statusText,
    contentType: entry.contentType,
    requestHeaderNames: Object.keys(requestHeaders),
    responseHeaderNames: Object.keys(responseHeaders),
    requestBodyBytes: entry.requestBodyBytes,
    requestBodyTruncated: false,
    requestBodyOmittedReason:
      entry.requestBodyBytes == null
        ? entry.requestBodyOmittedReason
        : "privacy-strict",
    responseBodyBytes: entry.responseBodyBytes,
    responseBodyTruncated: false,
    responseBodyOmittedReason: "privacy-strict",
    errorText: entry.errorText ? "request-failed" : null,
    durationMs: entry.durationMs,
  };
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

const cdpPortLine =
  "  const cdpPort = args.cdpEndpoint ? parseCdpEndpoint(args.cdpEndpoint).port : 0;\n";
const effectiveCdpPortLine =
  "  const effectiveCdpPort = runDebugPort ?? cdpPort;\n";
const patchedBrowserConfig =
  "browser: createRunBrowserConfig({ ...args, remoteDebuggingPort: runDebugPort })";

function occurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

function replaceExactly(source, from, to, description) {
  const count = occurrences(source, from);
  if (count !== 1) {
    throw new Error(
      `Unsupported libretto execution.js shape: expected one ${description}, found ${count}.`,
    );
  }
  return source.replace(from, to);
}

function replaceRegexExactly(source, pattern, to, description) {
  const globalPattern = pattern.flags.includes("g")
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`);
  const matches = [...source.matchAll(globalPattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Unsupported libretto source shape: expected one ${description}, found ${matches.length}.`,
    );
  }
  return source.replace(pattern, to);
}

function executionShape(source) {
  const hasCurrentPortShape =
    occurrences(source, cdpPortLine) === 1 &&
    occurrences(source, "      port: cdpPort,\n") === 1;
  const hasPatchedPortShape =
    occurrences(source, effectiveCdpPortLine) === 1 &&
    occurrences(source, "      port: effectiveCdpPort,\n") === 1;
  const hasRunIntegration =
    occurrences(
      source,
      "async function runIntegrationFromFile(args, logger) {",
    ) === 1;
  const hasStateWrite = occurrences(source, "  writeSessionState(\n") === 1;
  const hasBrowserConfig =
    occurrences(source, "function createRunBrowserConfig(args) {") === 1;
  if (
    !hasRunIntegration ||
    !hasStateWrite ||
    !hasBrowserConfig ||
    (!hasCurrentPortShape && !hasPatchedPortShape)
  ) {
    throw new Error(
      "Unsupported libretto execution.js shape: expected the 0.6.45 run/session layout.",
    );
  }
  return hasPatchedPortShape ? "patched" : "current";
}

export function patchExecutionSource(source) {
  const shape = executionShape(source);
  if (shape === "patched") {
    if (
      !source.includes(patchedBrowserConfig) ||
      !source.includes('import { createServer } from "node:net";') ||
      !source.includes("async function pickFreePort()") ||
      !source.includes(
        "const runDebugPort = args.providerName ? undefined : await pickFreePort();",
      )
    ) {
      throw new Error(
        "Unsupported libretto execution.js shape: incomplete CDP patch.",
      );
    }
    return source;
  }

  let next = source;
  const debugPortLine =
    "  const runDebugPort = args.providerName ? undefined : await pickFreePort();\n";

  if (!next.includes('import { createServer } from "node:net";')) {
    next = replaceExactly(
      next,
      'import { readFileSync } from "node:fs";',
      'import { readFileSync } from "node:fs";\nimport { createServer } from "node:net";',
      "the fs import",
    );
  }

  if (!next.includes("async function pickFreePort()")) {
    next = replaceExactly(
      next,
      "const require2 = moduleBuiltin.createRequire(import.meta.url);\n",
      `const require2 = moduleBuiltin.createRequire(import.meta.url);\n${freePortHelper}`,
      "the module require anchor",
    );
  }

  const browserConfigWithoutRemotePort =
    "...!args.headless && args.windowPosition ? { windowPosition: args.windowPosition } : {}\n  };";
  if (!next.includes("remoteDebuggingPort: args.remoteDebuggingPort")) {
    next = replaceExactly(
      next,
      browserConfigWithoutRemotePort,
      "...!args.headless && args.windowPosition ? { windowPosition: args.windowPosition } : {},\n    ...(args.remoteDebuggingPort ? { remoteDebuggingPort: args.remoteDebuggingPort } : {})\n  };",
      "the browser config tail",
    );
  }

  if (!next.includes(debugPortLine)) {
    next = replaceExactly(
      next,
      "  const {\n    pid,\n    socketPath: daemonSocketPath,\n    provider,\n    client\n  } = await DaemonClient.spawn({",
      `${debugPortLine}  const {\n    pid,\n    socketPath: daemonSocketPath,\n    provider,\n    client\n  } = await DaemonClient.spawn({`,
      "the daemon spawn anchor",
    );
  }

  if (next.includes("browser: createRunBrowserConfig(args)")) {
    next = replaceExactly(
      next,
      "browser: createRunBrowserConfig(args)",
      patchedBrowserConfig,
      "the run browser config call",
    );
  } else if (!next.includes(patchedBrowserConfig)) {
    throw new Error(
      "Unsupported libretto execution.js shape: missing run browser config call.",
    );
  }

  next = replaceExactly(
    next,
    cdpPortLine,
    `${cdpPortLine}${effectiveCdpPortLine}`,
    "the CDP port declaration",
  );
  next = replaceExactly(
    next,
    "      port: cdpPort,\n",
    "      port: effectiveCdpPort,\n",
    "the session state port field",
  );

  executionShape(next);
  return next;
}

export function patchSessionTelemetrySource(source) {
  const marker = 'const LIBRETTO_SESSION_PRIVACY_PATCH = "session-privacy-v1";';
  if (source.includes(marker)) return source;

  let next = source;
  const helpers = `${marker}
const redactActionEntry = ${redactSessionActionEntry.toString()};
const redactNetworkEntry = ${redactSessionNetworkEntry.toString()};
`;
  next = replaceExactly(
    next,
    "function bodyPreview(value) {",
    `${helpers}function bodyPreview(value) {`,
    "the body preview helper",
  );
  next = replaceExactly(
    next,
    "function bodyPreview(value) {\n  return value.slice(0, BODY_PREVIEW_CHARS);\n}",
    "function bodyPreview(value) {\n  return null;\n}",
    "the body preview implementation",
  );
  next = replaceRegexExactly(
    next,
    /function saveBodySidecar\([\s\S]*?\n}\nasync function installSessionTelemetry/,
    "function saveBodySidecar() {\n  return null;\n}\nasync function installSessionTelemetry",
    "the raw body sidecar helper",
  );
  next = replaceExactly(
    next,
    `const emitAction = (entry) => {
    logAction({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      ...entry
    });
  };`,
    `const emitAction = (entry) => {
    logAction(redactActionEntry({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      ...entry
    }));
  };`,
    "the telemetry action emitter",
  );
  next = replaceExactly(
    next,
    `const emitNetwork = (entry) => {
    logNetwork({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      ...entry
    });
  };`,
    `const emitNetwork = (entry) => {
    logNetwork(redactNetworkEntry({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      ...entry
    }));
  };`,
    "the telemetry network emitter",
  );
  return next;
}

export function patchSessionLogsSource(source) {
  const marker = 'const LIBRETTO_SESSION_PRIVACY_PATCH = "session-privacy-v1";';
  if (source.includes(marker)) return source;

  let next = source;
  next = replaceExactly(
    next,
    "function parentLogAction(session, entry) {",
    `${marker}
const redactActionEntry = ${redactSessionActionEntry.toString()};
function parentLogAction(session, entry) {`,
    "the action log redaction helper",
  );
  next = replaceExactly(
    next,
    `const record = { ts: (/* @__PURE__ */ new Date()).toISOString(), ...entry };`,
    `const record = redactActionEntry({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...entry });`,
    "the action log record",
  );
  return next;
}

export function patchBrowserSource(source) {
  const marker =
    'const LIBRETTO_CLOSE_CONFIRMATION_PATCH = "close-confirmed-v1";';
  if (source.includes(marker)) return source;

  let next = source;
  const waitForProcessExit = `
${marker}
async function waitForProcessExit(pid, timeoutMs, session, logger) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) {
      logger.info("close-process-exit-confirmed", { session, pid });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    \`Process \${pid} is still running after close for session "\${session}". State preserved; retry with: libretto close --session \${session}\`,
  );
}
`;
  next = replaceExactly(
    next,
    "function waitForCloseSignalWindow(ms) {",
    `${waitForProcessExit}\nfunction waitForCloseSignalWindow(ms) {`,
    "the close wait helper",
  );
  next = replaceExactly(
    next,
    `      if (!state.provider) {
        await waitForCloseSignalWindow(CLOSE_WAIT_MS);
      }`,
    `      if (!state.provider) {
        await waitForProcessExit(state.pid, CLOSE_WAIT_MS, session, logger);
      }`,
    "the daemon close confirmation",
  );
  next = replaceExactly(
    next,
    `    } else {
      await waitForCloseSignalWindow(CLOSE_WAIT_MS);
    }
  }
  if (state.provider) {`,
    `    } else {
      await waitForProcessExit(state.pid, CLOSE_WAIT_MS, session, logger);
    }
  }
  if (state.provider) {`,
    "the direct close confirmation",
  );
  next = replaceRegexExactly(
    next,
    /function sendSignalToProcessGroupOrPid\([\s\S]*?\n}\nfunction formatSessionList/,
    `function sendSignalToProcessGroupOrPid(pid, signal, logger, session) {
  try {
    process.kill(pid, signal);
    logger.info("close-signal-pid", { session, pid, signal });
  } catch (pidErr) {
    if (pidErr.code === "ESRCH") return;
    logger.warn("close-signal-pid-failed", {
      session,
      pid,
      signal,
      error: pidErr,
    });
    throw pidErr;
  }
}
function formatSessionList`,
    "the process signal helper",
  );
  return next;
}

export function patchInstalledLibretto() {
  const executionPath = resolveLibrettoExecutionPath();
  const telemetryPath = resolveLibrettoSessionTelemetryPath();
  const logsPath = resolveLibrettoSessionLogsPath();
  const browserPath = resolveLibrettoBrowserPath();
  if (
    !existsSync(executionPath) &&
    !existsSync(telemetryPath) &&
    !existsSync(logsPath) &&
    !existsSync(browserPath)
  ) {
    console.log(
      "libretto execution.js not found; skipping CDP patch until dependencies are installed.",
    );
    return false;
  }

  if (existsSync(executionPath)) {
    const before = readFileSync(executionPath, "utf8");
    const after = patchExecutionSource(before);
    if (after !== before) {
      writeFileSync(executionPath, after, "utf8");
      console.log("Applied libretto run CDP patch.");
    }
  }

  if (existsSync(telemetryPath)) {
    const before = readFileSync(telemetryPath, "utf8");
    const after = patchSessionTelemetrySource(before);
    if (after !== before) {
      writeFileSync(telemetryPath, after, "utf8");
      console.log("Applied libretto session telemetry privacy patch.");
    }
  }

  if (existsSync(logsPath)) {
    const before = readFileSync(logsPath, "utf8");
    const after = patchSessionLogsSource(before);
    if (after !== before) {
      writeFileSync(logsPath, after, "utf8");
      console.log("Applied libretto session action privacy patch.");
    }
  }

  if (existsSync(browserPath)) {
    const before = readFileSync(browserPath, "utf8");
    const after = patchBrowserSource(before);
    if (after !== before) {
      writeFileSync(browserPath, after, "utf8");
      console.log("Applied libretto close confirmation patch.");
    }
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  patchInstalledLibretto();
}
