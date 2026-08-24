import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  patchSessionLogsSource,
  patchSessionTelemetrySource,
  patchBrowserSource,
  patchExecutionSource,
  redactSessionActionEntry,
  redactSessionNetworkEntry,
  resolveLibrettoExecutionPath,
  resolveLibrettoSessionLogsPath,
  resolveLibrettoSessionTelemetryPath,
  resolveLibrettoBrowserPath,
} from "./patch-libretto-run-cdp.mjs";

assert.equal(
  resolveLibrettoExecutionPath("/tmp/OctopusBeak.app/Contents/Resources/app"),
  join(
    "/tmp/OctopusBeak.app/Contents/Resources/app",
    "node_modules",
    "libretto",
    "dist",
    "cli",
    "commands",
    "execution.js",
  ),
);

const before = `
import { readFileSync } from "node:fs";
const require2 = moduleBuiltin.createRequire(import.meta.url);
function createRunBrowserConfig(args) {
  if (args.providerName) {
    return {
      kind: "provider",
      providerName: args.providerName
    };
  }
  return {
    kind: "launch",
    headed: !args.headless,
    viewport: args.viewport ?? { width: 1366, height: 768 },
    ...!args.headless && args.windowPosition ? { windowPosition: args.windowPosition } : {}
  };
}
async function runIntegrationFromFile(args, logger) {
  const {
    pid,
    socketPath: daemonSocketPath,
    provider,
    client
  } = await DaemonClient.spawn({
    config: {
      browser: createRunBrowserConfig(args)
    }
  });
  const cdpPort = args.cdpEndpoint ? parseCdpEndpoint(args.cdpEndpoint).port : 0;
  writeSessionState(
    {
      port: cdpPort,
      pid,
      cdpEndpoint: provider?.cdpEndpoint
    },
    logger
  );
}
`;

const after = patchExecutionSource(before);

assert.match(after, /import \{ createServer \} from "node:net";/);
assert.match(after, /async function pickFreePort\(\)/);
assert.match(after, /remoteDebuggingPort: args\.remoteDebuggingPort/);
assert.match(
  after,
  /const runDebugPort = args\.providerName \? undefined : await pickFreePort\(\);/,
);
assert.match(
  after,
  /browser: createRunBrowserConfig\(\{ \.\.\.args, remoteDebuggingPort: runDebugPort \}\)/,
);
assert.match(after, /const effectiveCdpPort = runDebugPort \?\? cdpPort;/);
assert.match(after, /port: effectiveCdpPort/);
assert.doesNotMatch(after, /port: 0,/);

assert.equal(patchExecutionSource(after), after);

const currentBefore = `
import { readFileSync } from "node:fs";
const require2 = moduleBuiltin.createRequire(import.meta.url);
function createRunBrowserConfig(args) {
  if (args.providerName) {
    return {
      kind: "provider",
      providerName: args.providerName
    };
  }
  return {
    kind: "launch",
    headed: !args.headless,
    viewport: args.viewport ?? { width: 1366, height: 768 },
    ...!args.headless && args.windowPosition ? { windowPosition: args.windowPosition } : {}
  };
}
async function runIntegrationFromFile(args, logger) {
  const workflowOutcome = createDeferred();
  const handlers = createWorkflowHandlers(workflowOutcome.resolve);
  const {
    pid,
    socketPath: daemonSocketPath,
    provider,
    client
  } = await DaemonClient.spawn({
    config: {
      session: args.session,
      experiments: args.experiments,
      browser: createRunBrowserConfig(args)
    }
  });
  const cdpPort = args.cdpEndpoint ? parseCdpEndpoint(args.cdpEndpoint).port : 0;
  writeSessionState(
    {
      port: cdpPort,
      pid,
      cdpEndpoint: provider?.cdpEndpoint
    },
    logger
  );
}
`;

const currentAfter = patchExecutionSource(currentBefore);

assert.match(currentAfter, /import \{ createServer \} from "node:net";/);
assert.match(currentAfter, /async function pickFreePort\(\)/);
assert.match(currentAfter, /remoteDebuggingPort: args\.remoteDebuggingPort/);
assert.match(
  currentAfter,
  /const runDebugPort = args\.providerName \? undefined : await pickFreePort\(\);/,
);
assert.match(
  currentAfter,
  /browser: createRunBrowserConfig\(\{ \.\.\.args, remoteDebuggingPort: runDebugPort \}\)/,
);
assert.match(
  currentAfter,
  /const effectiveCdpPort = runDebugPort \?\? cdpPort;/,
);
assert.match(currentAfter, /port: effectiveCdpPort/);
assert.doesNotMatch(currentAfter, /port: cdpPort,/);

assert.equal(patchExecutionSource(currentAfter), currentAfter);

assert.throws(
  () =>
    patchExecutionSource(
      "export async function runIntegrationFromFile() { return 1; }",
    ),
  /Unsupported libretto execution\.js shape/,
);

assert.deepEqual(
  redactSessionActionEntry({
    ts: "now",
    pageId: "page-1",
    action: "fill",
    source: "user",
    value: "CAPTCHA-SECRET",
    nearbyText: "account-SECRET",
    composedPath: ["password-SECRET"],
    success: true,
  }),
  {
    ts: "now",
    pageId: "page-1",
    action: "fill",
    source: "user",
    success: true,
  },
);

const redactedNetwork = redactSessionNetworkEntry({
  ts: "now",
  id: 1,
  pageId: "page-1",
  method: "POST",
  url: "https://example.test/path?secret=CAPTCHA-SECRET",
  resourceType: "fetch",
  status: 200,
  statusText: "OK",
  contentType: "text/html",
  requestHeaders: { cookie: "COOKIE-SECRET", "content-type": "text/plain" },
  responseHeaders: {
    viewstate: "VIEWSTATE-SECRET",
    "content-type": "text/html",
  },
  requestBodyBytes: 20,
  requestBodyPreview: "account-SECRET",
  requestBodyPath: "raw-network/request.gz",
  responseBodyBytes: 40,
  responseBodyPreview: "amount-SECRET",
  responseBodyPath: "raw-network/response.gz",
});
assert.equal(redactedNetwork.url, "/path");
assert.deepEqual(redactedNetwork.requestHeaderNames, [
  "cookie",
  "content-type",
]);
assert.deepEqual(redactedNetwork.responseHeaderNames, [
  "viewstate",
  "content-type",
]);
assert.equal(redactedNetwork.requestBodyOmittedReason, "privacy-strict");
assert.equal(redactedNetwork.responseBodyOmittedReason, "privacy-strict");
assert.doesNotMatch(JSON.stringify(redactedNetwork), /SECRET/);

const installedTelemetry = readFileSync(
  resolveLibrettoSessionTelemetryPath(),
  "utf8",
);
const patchedTelemetry = patchSessionTelemetrySource(installedTelemetry);
assert.match(patchedTelemetry, /session-privacy-v1/);
assert.match(patchedTelemetry, /return null;/);
assert.match(patchedTelemetry, /redactNetworkEntry/);
assert.equal(patchSessionTelemetrySource(patchedTelemetry), patchedTelemetry);

const installedLogs = readFileSync(resolveLibrettoSessionLogsPath(), "utf8");
const patchedLogs = patchSessionLogsSource(installedLogs);
assert.match(patchedLogs, /session-privacy-v1/);
assert.match(patchedLogs, /redactActionEntry/);
assert.equal(patchSessionLogsSource(patchedLogs), patchedLogs);

assert.equal(
  resolveLibrettoBrowserPath("/tmp/OctopusBeak.app/Contents/Resources/app"),
  join(
    "/tmp/OctopusBeak.app/Contents/Resources/app",
    "node_modules",
    "libretto",
    "dist",
    "cli",
    "core",
    "browser.js",
  ),
);

const installedBrowser = readFileSync(resolveLibrettoBrowserPath(), "utf8");
const patchedBrowser = patchBrowserSource(installedBrowser);
assert.match(patchedBrowser, /close-confirmed-v1/);
assert.match(patchedBrowser, /close-process-exit-confirmed/);
assert.match(
  patchedBrowser,
  /await waitForProcessExit\(state\.pid, CLOSE_WAIT_MS, session, logger\);/,
);
assert.match(patchedBrowser, /if \(pidErr\.code === "ESRCH"\) return;/);
assert.match(patchedBrowser, /throw pidErr;/);
assert.equal(patchBrowserSource(patchedBrowser), patchedBrowser);
