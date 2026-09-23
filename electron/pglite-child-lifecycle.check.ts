import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import test from "node:test";
import {
  createPGliteChildRpcServer,
  type PGliteChildProvider,
} from "./pglite-child-rpc.ts";
import { createPGliteViewWorkerClient } from "./pglite-view-worker-client.ts";

type ChildOutput = {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
  waitForLine(prefix: string, timeoutMs?: number): Promise<string>;
  waitForExit(timeoutMs?: number): Promise<boolean>;
};

function startChild(environment: NodeJS.ProcessEnv): ChildOutput {
  const script = `
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    const rpc = await import(process.env.PGLITE_LIFECYCLE_CHILD_RPC_MODULE);
    const nextCommand = () => new Promise((resolve) => input.once("line", resolve));
    const run = async () => {
      const first = rpc.requirePGliteChildRpcClientFromEnv();
      await first.ready;
      const overview = await first.financial.overviewCurrent();
      process.stdout.write("READY:first:" + overview.availability + "\\n");
      await nextCommand();
      first.close();

      const resumed = rpc.requirePGliteChildRpcClientFromEnv();
      await resumed.ready;
      const resumedOverview = await resumed.financial.overviewCurrent();
      process.stdout.write("READY:resumed:" + resumedOverview.availability + "\\n");
      const pending = resumed.request("financial.source.commit", [{
        capture: {
          captureId: "parent-close-capture",
          integrationNamespace: "synthetic",
          sourceConnectionKey: "source",
          identityEpoch: "epoch",
          stream: "stream",
          recordKind: "record",
          routeKey: "route",
          contractVersion: "v1",
          subjectDigest: "subject",
          observedAt: "2026-09-22T00:00:00.000Z",
          scope: {},
          pages: [],
          records: [],
        },
        account: {},
        transactions: [],
      }]);
      process.stdout.write("REQUEST_SENT\\n");
      try {
        await pending;
        process.stdout.write("UNEXPECTED_SUCCESS\\n");
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write("CLOSED:" + (error instanceof Error ? error.message : String(error)) + "\\n");
      } finally {
        resumed.close();
        input.close();
      }
    };
    run().catch((error) => {
      process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\\n");
      process.exitCode = 1;
      input.close();
    });
  `;
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    script,
  ], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdoutBuffer = "";
  let stderrText = "";
  const lines: string[] = [];
  const waiters = new Set<{
    prefix: string;
    resolve(line: string): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  const dispatch = (line: string): void => {
    lines.push(line);
    for (const waiter of waiters) {
      if (!line.startsWith(waiter.prefix)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(line);
      break;
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      dispatch(stdoutBuffer.slice(0, newline).replace(/\r$/u, ""));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderrText += chunk; });
  child.on("exit", (code, signal) => {
    for (const waiter of waiters) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(
        `Child exited before ${JSON.stringify(waiter.prefix)} (code=${code}, signal=${signal}); stderr: ${stderrText}`,
      ));
    }
  });
  return {
    child,
    stderr: () => stderrText,
    waitForLine(prefix, timeoutMs = 10_000) {
      const existing = lines.findIndex((line) => line.startsWith(prefix));
      if (existing >= 0) return Promise.resolve(lines.splice(existing, 1)[0]!);
      return new Promise((resolve, reject) => {
        const waiter = {
          prefix,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${JSON.stringify(prefix)}; stderr: ${stderrText}`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    waitForExit(timeoutMs = 2_000) {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
      return new Promise((resolve) => {
        const onExit = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          child.off("exit", onExit);
          resolve(false);
        }, timeoutMs);
        child.once("exit", onExit);
      });
    },
  };
}

async function sqliteFilesWithin(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sqliteFilesWithin(path));
    else if (entry.name === "canonical.sqlite" || entry.name === "ledger.sqlite") files.push(path);
  }
  return files;
}

test("PGlite child RPC launches, reconnects, and fails closed when its parent closes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-pglite-child-lifecycle-"));
  const worker = new Worker(new URL("./pglite-view-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: { dataDir },
  });
  const workerClient = createPGliteViewWorkerClient(worker);
  let reachBlockedOperation!: () => void;
  let blockNextOperation = false;
  let providerCancelled = false;
  let providerSettled = false;
  const blockedOperation = new Promise<void>((resolve) => { reachBlockedOperation = resolve; });
  const financial: PGliteChildProvider["financial"] = {
    ...workerClient.financial.registry,
    sourceCommit: async (request, options) => {
      if (!blockNextOperation) return workerClient.financial.registry.sourceCommit(request, options);
      blockNextOperation = false;
      reachBlockedOperation();
      await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          providerCancelled = true;
          setTimeout(() => {
            providerSettled = true;
            reject(new Error("cancelled"));
          }, 30);
        };
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
      throw new Error("The parent-close fixture must stay pending until cancellation.");
    },
  };
  const server = createPGliteChildRpcServer({
    provider: {
      operational: {
        ...workerClient.operationalProvider,
        exchangeRates: workerClient.operationalProvider.exchangeRates,
      },
      financial,
    },
  });
  const child = startChild({
    ...process.env,
    ...server.env,
    PGLITE_LIFECYCLE_CHILD_RPC_MODULE: pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "pglite-child-rpc.ts")).href,
  });
  let serverClosed = false;
  try {
    await server.ready;
    await workerClient.financial.registry.overviewCurrent();
    assert.equal(await child.waitForLine("READY:first:"), "READY:first:empty");
    assert.deepEqual(await sqliteFilesWithin(dataDir), []);

    blockNextOperation = true;
    child.child.stdin.write("reconnect\n");
    assert.equal(await child.waitForLine("READY:resumed:"), "READY:resumed:empty");
    await child.waitForLine("REQUEST_SENT");
    await blockedOperation;

    const closing = server.close();
    await closing;
    serverClosed = true;
    assert.equal(providerCancelled, true, "parent close must abort the active worker operation");
    assert.equal(providerSettled, true, "parent close must wait for active worker RPC cleanup");
    assert.match(await child.waitForLine("CLOSED:"), /^CLOSED:PGlite workflow transport is closed\.$/u);
    assert.equal(await child.waitForExit(), true, "the child process exits after its owner disconnects");
    assert.equal(child.child.exitCode, 0);
    assert.equal(child.stderr(), "");
    assert.deepEqual(await sqliteFilesWithin(dataDir), []);
  } finally {
    if (child.child.exitCode === null && child.child.signalCode === null) {
      if (!await child.waitForExit()) {
        child.child.kill("SIGTERM");
        await Promise.race([
          once(child.child, "exit"),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    }
    if (!serverClosed) await server.close();
    await workerClient.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
