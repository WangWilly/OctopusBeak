import assert from "node:assert/strict";
import { patchExecutionSource } from "./patch-libretto-run-cdp.mjs";

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
  writeSessionState(
    {
      port: 0,
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
assert.match(after, /const runDebugPort = args\.providerName \? undefined : await pickFreePort\(\);/);
assert.match(after, /browser: createRunBrowserConfig\(\{ \.\.\.args, remoteDebuggingPort: runDebugPort \}\)/);
assert.match(after, /port: runDebugPort \?\? 0/);

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
  writeSessionState(
    {
      port: 0,
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
assert.match(currentAfter, /const runDebugPort = args\.providerName \? undefined : await pickFreePort\(\);/);
assert.match(currentAfter, /browser: createRunBrowserConfig\(\{ \.\.\.args, remoteDebuggingPort: runDebugPort \}\)/);
assert.match(currentAfter, /port: runDebugPort \?\? 0/);

assert.equal(patchExecutionSource(currentAfter), currentAfter);
