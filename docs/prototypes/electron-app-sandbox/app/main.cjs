/*
 * THROWAWAY PROTOTYPE — packaged Electron / Swift helper boundary probe.
 * This is deliberately isolated from the production Electron entrypoint.
 */

const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const CHANNEL = "probe:v1:run";
const resultPath = process.env.PROBE_RESULT_PATH;
const runOrdinal = Number(process.env.PROBE_RUN_ORDINAL || "1");
let window;

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function firstJsonLine(child) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error(`helper-ready-timeout: ${stderr.join("")}`));
    }, 8_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      lines.close();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`invalid-helper-json: ${line}; ${error.message}`));
      }
    });
    child.once("error", reject);
  });
}

function loopbackRoundTrip(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write("ping");
    });
    socket.setTimeout(5_000);
    socket.once("data", (chunk) => {
      const reply = chunk.toString("utf8");
      socket.end();
      resolve(reply);
    });
    socket.once("timeout", () => reject(new Error("loopback-timeout")));
    socket.once("error", reject);
  });
}

function helperCommand(mode) {
  const helperPath = path.join(process.resourcesPath, "app", "bin", "probe-helper");
  const modelPath = path.join(process.resourcesPath, "app", "model-sentinel.gguf");
  const insidePath = path.join(app.getPath("userData"), `helper-inside-${runOrdinal}.txt`);
  const outsidePath = path.join(app.getPath("documents"), "octopusbeak-probe-outside.txt");
  return {
    helperPath,
    args: [mode, modelPath, insidePath, outsidePath],
  };
}

async function exerciseHelper() {
  const serving = helperCommand("serve");
  const server = spawn(serving.helperPath, serving.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = await firstJsonLine(server);
  const loopbackReply = await loopbackRoundTrip(ready.port);
  const servingExitPromise = waitForExit(server);
  server.kill("SIGTERM");
  const terminated = await servingExitPromise;

  const crashing = helperCommand("crash");
  const crash = spawn(crashing.helperPath, crashing.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const crashReady = await firstJsonLine(crash);
  const crashed = await waitForExit(crash);

  return {
    ready,
    loopbackReply,
    terminated,
    crashReady,
    crashed,
  };
}

async function runProbe(rendererFacts) {
  const checkpointPath = path.join(app.getPath("userData"), "probe-checkpoint.json");
  const previousCheckpoint = fs.existsSync(checkpointPath)
    ? JSON.parse(fs.readFileSync(checkpointPath, "utf8"))
    : null;
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(checkpointPath, JSON.stringify({ runOrdinal, writtenAt: new Date().toISOString() }));

  const helper = await exerciseHelper();
  const evidence = {
    schemaVersion: 1,
    runOrdinal,
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    rendererFacts,
    ipc: {
      channel: CHANNEL,
      senderValidated: true,
    },
    helper,
    restart: {
      previousCheckpoint,
      recovered: runOrdinal > 1 && previousCheckpoint?.runOrdinal === runOrdinal - 1,
    },
  };
  fs.writeFileSync(resultPath, JSON.stringify(evidence, null, 2));
  return evidence;
}

app.whenReady().then(async () => {
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  ipcMain.handle(CHANNEL, async (event, rendererFacts) => {
    if (event.sender !== window.webContents) throw new Error("untrusted-ipc-sender");
    try {
      const evidence = await runProbe(rendererFacts);
      setImmediate(() => app.quit());
      return evidence;
    } catch (error) {
      fs.writeFileSync(resultPath, JSON.stringify({
        schemaVersion: 1,
        runOrdinal,
        error: error instanceof Error ? error.stack : String(error),
      }, null, 2));
      setImmediate(() => app.exit(1));
      throw error;
    }
  });

  await window.loadFile(path.join(__dirname, "renderer.html"));
});
