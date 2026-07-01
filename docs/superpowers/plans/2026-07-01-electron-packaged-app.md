# Electron Packaged App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable macOS Electron packaged app for OctopusBeak without rewriting the existing SvelteKit dashboard, SQLite ledger, or Libretto workflows.

**Architecture:** Electron owns startup, user-data directory setup, local server lifecycle, and the desktop window. The existing SvelteKit `adapter-node` app still serves routes and form actions, while packaged automation commands run through bundled app resources instead of global `npm` or `npx`.

**Tech Stack:** Electron, Electron Forge, SvelteKit `adapter-node`, Node/Electron `ELECTRON_RUN_AS_NODE`, Libretto, Playwright, `node:sqlite`.

---

## File Map

- Modify `package.json`: add Electron entrypoint, desktop scripts, and Forge scripts.
- Modify `package-lock.json`: lock Electron Forge and Electron dependencies.
- Modify `.gitignore`: ignore Electron Forge `out/` artifacts.
- Create `electron/runtime.cjs`: pure Node helpers for app data setup, environment construction, free-port lookup, and HTTP server startup.
- Create `electron/runtime.check.cjs`: assert-based checks for the pure runtime helpers.
- Create `electron/main.cjs`: Electron app entrypoint.
- Create `electron/runtime-probe.cjs`: verifies Electron can run the project runtime requirements as Node.
- Create `electron/strip-types-probe.ts`: verifies Electron-as-Node supports TypeScript stripping.
- Create `forge.config.cjs`: Electron Forge packaging, DMG/ZIP makers, signing, notarization, and app file filtering.
- Create `src/lib/automation/server/desktop-command.ts`: converts existing automation tasks into dev or packaged child-process commands.
- Create `src/lib/automation/server/desktop-command.check.ts`: assert-based checks for packaged command resolution.
- Modify `src/lib/automation/server/tasks.ts`: add explicit command parts beside existing `script` names.
- Modify `src/lib/automation/server/runner.ts`: use command resolver instead of direct `npm`/`npx`/`node` strings.
- Modify `src/lib/automation/server/runner.check.ts`: update patch-command checks after resolver extraction.
- Create `docs/desktop-release.md`: local packaging, signing, notarization, and smoke-test checklist.

Keep the existing dirty `package-lock.json` change in mind before starting. Do not discard it; inspect and preserve user changes while adding the Electron dependency lockfile updates.

---

### Task 1: Add Electron Forge Dependencies And Runtime Probes

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `electron/runtime-probe.cjs`
- Create: `electron/strip-types-probe.ts`

- [ ] **Step 1: Install Electron Forge dependencies**

Run:

```bash
npm install --save-dev electron @electron-forge/cli @electron-forge/maker-dmg @electron-forge/maker-zip
```

Expected: `package.json` and `package-lock.json` include the new dev dependencies.

- [ ] **Step 2: Add runtime probe files**

Create `electron/runtime-probe.cjs`:

```js
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

assert.equal(typeof DatabaseSync, "function");
assert.match(process.versions.node, /^\d+\.\d+\.\d+$/);

console.log(JSON.stringify({
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === "1",
  node: process.versions.node,
  sqlite: true,
}));
```

Create `electron/strip-types-probe.ts`:

```ts
const value: string = "strip-types-ok";
console.log(value);
```

- [ ] **Step 3: Add probe scripts**

In `package.json`, add these scripts:

```json
{
  "scripts": {
    "desktop:runtime-probe": "ELECTRON_RUN_AS_NODE=1 electron electron/runtime-probe.cjs",
    "desktop:strip-types-probe": "ELECTRON_RUN_AS_NODE=1 electron --experimental-strip-types electron/strip-types-probe.ts"
  }
}
```

Keep all existing scripts.

- [ ] **Step 4: Verify Electron runtime compatibility**

Run:

```bash
npm run desktop:runtime-probe
npm run desktop:strip-types-probe
```

Expected:

```text
"sqlite":true
strip-types-ok
```

If `node:sqlite` or `--experimental-strip-types` fails under Electron, stop this implementation and create a small replacement plan for either a SQLite package or build-step compiled workflow runners. Do not continue with packaging until this gate passes.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json electron/runtime-probe.cjs electron/strip-types-probe.ts
git commit -m "chore: add electron runtime probes"
```

---

### Task 2: Add Desktop Runtime Helpers

**Files:**
- Create: `electron/runtime.cjs`
- Create: `electron/runtime.check.cjs`

- [ ] **Step 1: Add failing runtime helper check**

Create `electron/runtime.check.cjs`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildDesktopEnv,
  ensureDataRoot,
  findFreePort,
  listenWithHandler,
} = require("./runtime.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "octopusbeak-runtime-"));

try {
  ensureDataRoot(root);
  assert.equal(fs.existsSync(path.join(root, ".env")), true);
  assert.equal(fs.existsSync(path.join(root, ".libretto")), true);
  assert.equal(fs.existsSync(path.join(root, "downloads")), true);
  assert.equal(fs.existsSync(path.join(root, "data", "ledger")), true);
  assert.equal(fs.existsSync(path.join(root, "data", "automation", "logs")), true);
  assert.equal(
    fs.readFileSync(path.join(root, ".env"), "utf8"),
    "AUTOMATION_BUSINESS_TIMEZONE=Asia/Taipei\n",
  );

  const env = buildDesktopEnv({
    userData: root,
    appRoot: "/Applications/OctopusBeak.app/Contents/Resources/app",
    port: 41234,
    electronPath: "/Applications/OctopusBeak.app/Contents/MacOS/OctopusBeak",
  });
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.PORT, "41234");
  assert.equal(env.ORIGIN, "http://127.0.0.1:41234");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.LEDGER_DIR, path.join(root, "data", "ledger"));
  assert.equal(env.OCTOPUSBEAK_DESKTOP, "1");
  assert.equal(env.OCTOPUSBEAK_APP_ROOT, "/Applications/OctopusBeak.app/Contents/Resources/app");
  assert.equal(env.OCTOPUSBEAK_USER_DATA, root);
  assert.equal(env.OCTOPUSBEAK_NODE_PATH, "/Applications/OctopusBeak.app/Contents/MacOS/OctopusBeak");
  assert.equal(
    env.PLAYWRIGHT_BROWSERS_PATH,
    path.join("/Applications/OctopusBeak.app/Contents/Resources/app", "node_modules", "playwright-core", ".local-browsers"),
  );

  const port = await findFreePort();
  assert.equal(Number.isInteger(port), true);
  assert.equal(port > 0, true);

  const server = await listenWithHandler((request, response) => {
    response.end(request.url);
  }, port);
  server.close();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run check to verify it fails**

Run:

```bash
node electron/runtime.check.cjs
```

Expected: FAIL with `Cannot find module './runtime.cjs'`.

- [ ] **Step 3: Add runtime helpers**

Create `electron/runtime.cjs`:

```js
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

function ensureDataRoot(userData) {
  fs.mkdirSync(path.join(userData, ".libretto"), { recursive: true });
  fs.mkdirSync(path.join(userData, "downloads"), { recursive: true });
  fs.mkdirSync(path.join(userData, "data", "ledger"), { recursive: true });
  fs.mkdirSync(path.join(userData, "data", "automation", "logs"), { recursive: true });

  const envPath = path.join(userData, ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, "AUTOMATION_BUSINESS_TIMEZONE=Asia/Taipei\n", "utf8");
  }
}

function buildDesktopEnv({ userData, appRoot, port, electronPath = process.execPath }) {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    ORIGIN: `http://127.0.0.1:${port}`,
    NODE_ENV: "production",
    LEDGER_DIR: path.join(userData, "data", "ledger"),
    OCTOPUSBEAK_DESKTOP: "1",
    OCTOPUSBEAK_APP_ROOT: appRoot,
    OCTOPUSBEAK_USER_DATA: userData,
    OCTOPUSBEAK_NODE_PATH: electronPath,
    PLAYWRIGHT_BROWSERS_PATH: path.join(appRoot, "node_modules", "playwright-core", ".local-browsers"),
  };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not allocate a local port."));
      });
    });
  });
}

function listenWithHandler(handler, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

module.exports = {
  buildDesktopEnv,
  ensureDataRoot,
  findFreePort,
  listenWithHandler,
};
```

- [ ] **Step 4: Run check**

Run:

```bash
node electron/runtime.check.cjs
```

Expected: PASS with no output.

- [ ] **Step 5: Commit**

```bash
git add electron/runtime.cjs electron/runtime.check.cjs
git commit -m "feat: add electron runtime helpers"
```

---

### Task 3: Add Electron Main Entrypoint

**Files:**
- Create: `electron/main.cjs`
- Modify: `package.json`

- [ ] **Step 1: Add Electron main entrypoint**

Create `electron/main.cjs`:

```js
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, dialog } = require("electron");
const {
  buildDesktopEnv,
  ensureDataRoot,
  findFreePort,
  listenWithHandler,
} = require("./runtime.cjs");

let server = null;
let mainWindow = null;

function projectRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "app");
  return path.join(__dirname, "..");
}

async function startServer({ appRoot, userData }) {
  const port = await findFreePort();
  const env = buildDesktopEnv({
    userData,
    appRoot,
    port,
    electronPath: process.execPath,
  });
  Object.assign(process.env, env);
  process.chdir(userData);

  const handlerUrl = pathToFileURL(path.join(appRoot, "build", "handler.js")).href;
  const { handler } = await import(handlerUrl);
  server = await listenWithHandler(handler, port);
  return env.ORIGIN;
}

async function createWindow(origin) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 980,
    minHeight: 700,
    title: "OctopusBeak",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await mainWindow.loadURL(`${origin}/overview`);
}

async function start() {
  const userData = app.getPath("userData");
  const appRoot = projectRoot();
  ensureDataRoot(userData);
  const origin = await startServer({ appRoot, userData });
  await createWindow(origin);
}

app.whenReady().then(start).catch((error) => {
  dialog.showErrorBox(
    "OctopusBeak failed to start",
    error instanceof Error ? error.stack || error.message : String(error),
  );
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && process.env.ORIGIN) {
    void createWindow(process.env.ORIGIN);
  }
});

app.on("before-quit", () => {
  if (server) server.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 2: Register the Electron main entry**

In `package.json`, add the top-level `main` field:

```json
{
  "main": "electron/main.cjs"
}
```

- [ ] **Step 3: Build SvelteKit and launch Electron locally**

Run:

```bash
npm run build
npx electron .
```

Expected: Electron opens `/overview` in a desktop window. The app data directory contains `.env`, `.libretto/`, `downloads/`, `data/ledger/`, and `data/automation/logs/`.

- [ ] **Step 4: Verify existing checks**

Run:

```bash
npm run typecheck
node electron/runtime.check.cjs
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add package.json electron/main.cjs
git commit -m "feat: start sveltekit inside electron"
```

---

### Task 4: Add Forge Packaging Configuration

**Files:**
- Create: `forge.config.cjs`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add Forge config**

Create `forge.config.cjs`:

```js
const shouldSign = process.env.OCTOPUSBEAK_SIGN === "1";
const notaryProfile = process.env.OCTOPUSBEAK_NOTARY_PROFILE || "OctopusBeakNotary";

module.exports = {
  packagerConfig: {
    name: "OctopusBeak",
    executableName: "OctopusBeak",
    appBundleId: "app.octopusbeak.desktop",
    appCategoryType: "public.app-category.finance",
    asar: false,
    ignore: [
      /^\/\.git($|\/)/,
      /^\/\.codex($|\/)/,
      /^\/\.agents($|\/)/,
      /^\/\.svelte-kit($|\/)/,
      /^\/\.env$/,
      /^\/data($|\/)/,
      /^\/downloads($|\/)/,
      /^\/docs\/specs($|\/)/,
      /^\/docs\/superpowers($|\/)/,
      /^\/out($|\/)/,
    ],
    ...(shouldSign
      ? {
          osxSign: {},
          osxNotarize: {
            keychainProfile: notaryProfile,
          },
        }
      : {}),
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        format: "ULFO",
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
};
```

- [ ] **Step 2: Add packaging scripts**

In `package.json`, add these scripts:

```json
{
  "scripts": {
    "desktop:install-browsers": "PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium",
    "desktop:dev": "npm run build && electron .",
    "desktop:package": "npm run build && npm run desktop:install-browsers && electron-forge package",
    "desktop:make": "npm run build && npm run desktop:install-browsers && electron-forge make",
    "desktop:make:signed": "OCTOPUSBEAK_SIGN=1 npm run desktop:make"
  }
}
```

Keep the probe scripts from Task 1.

- [ ] **Step 3: Ignore Forge output**

Add this line to `.gitignore`:

```gitignore
out/
```

- [ ] **Step 4: Package without signing**

Run:

```bash
npm run desktop:package
```

Expected: Forge creates an unpacked app under `out/` and does not require Apple credentials.

- [ ] **Step 5: Commit**

```bash
git add forge.config.cjs package.json .gitignore package-lock.json
git commit -m "feat: add electron forge packaging"
```

---

### Task 5: Add Packaged Automation Command Resolver

**Files:**
- Create: `src/lib/automation/server/desktop-command.ts`
- Create: `src/lib/automation/server/desktop-command.check.ts`
- Modify: `src/lib/automation/server/tasks.ts`

- [ ] **Step 1: Add failing command resolver check**

Create `src/lib/automation/server/desktop-command.check.ts`:

```ts
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  resolveLibrettoCommand,
  resolveNodeScriptCommand,
  resolvePatchCommand,
  resolveTaskCommand,
} from "./desktop-command.ts";
import { taskById } from "./tasks.ts";

const env = {
  OCTOPUSBEAK_DESKTOP: "1",
  OCTOPUSBEAK_APP_ROOT: "/AppRoot",
  OCTOPUSBEAK_NODE_PATH: "/AppRoot/OctopusBeak",
  PLAYWRIGHT_BROWSERS_PATH: "/AppRoot/node_modules/playwright-core/.local-browsers",
};

const fubon = taskById("fubon-all-statements");
assert.ok(fubon);
assert.deepEqual(
  resolveTaskCommand(fubon, {}, env),
  {
    display: "run:fubon-all-statements",
    command: "/AppRoot/OctopusBeak",
    args: [
      join("/AppRoot", "node_modules", "libretto", "dist", "cli", "index.js"),
      "run",
      join("/AppRoot", "src", "workflows", "fubon-all-statements.ts"),
      "--headless",
    ],
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  },
);

const importTask = taskById("import-downloads-csv");
assert.ok(importTask);
assert.deepEqual(
  resolveTaskCommand(importTask, {}, env).args,
  [
    "--no-warnings",
    "--experimental-strip-types",
    join("/AppRoot", "src", "ledger", "import-downloads-csv.ts"),
  ],
);

assert.deepEqual(
  resolveTaskCommand(fubon, {}, { PATH: "/usr/bin" }),
  {
    display: "run:fubon-all-statements",
    command: "npm",
    args: ["run", "run:fubon-all-statements"],
    env: { PATH: "/usr/bin" },
  },
);

assert.deepEqual(
  resolveLibrettoCommand(["resume", "--session", "ses-123"], env),
  {
    display: "libretto resume --session ses-123",
    command: "/AppRoot/OctopusBeak",
    args: [
      join("/AppRoot", "node_modules", "libretto", "dist", "cli", "index.js"),
      "resume",
      "--session",
      "ses-123",
    ],
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  },
);

assert.deepEqual(
  resolveNodeScriptCommand(["--no-warnings", "scripts/patch-libretto-run-cdp.mjs"], env).args,
  ["--no-warnings", join("/AppRoot", "scripts", "patch-libretto-run-cdp.mjs")],
);

assert.deepEqual(
  resolvePatchCommand({}, env)?.args,
  [join("/AppRoot", "scripts", "patch-libretto-run-cdp.mjs")],
);
assert.equal(resolvePatchCommand({ resumeSession: "ses-123" }, env), null);
```

- [ ] **Step 2: Run check to verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-command.check.ts
```

Expected: FAIL with `Cannot find module './desktop-command.ts'`.

- [ ] **Step 3: Add command parts to automation tasks**

In `src/lib/automation/server/tasks.ts`, extend the type:

```ts
export type AutomationTask = {
  id: string;
  label: string;
  script: string;
  command: readonly string[];
  kind: AutomationTaskKind;
  credentialGroupId?: string;
  credentialKeys: readonly string[];
  dependencies: readonly string[];
  maxAttempts: number;
};
```

Add `command` to each task:

```ts
command: ["libretto", "run", "src/workflows/fubon-all-statements.ts", "--headless"],
command: ["libretto", "run", "src/workflows/esun-credit-card-statements.ts", "--headless"],
command: ["libretto", "run", "src/workflows/yuanta-all-statements.ts", "--headless"],
command: ["libretto", "run", "src/workflows/yuanta-trade-statements.ts", "--headless"],
command: ["libretto", "run", "src/workflows/cathay-all-statements.ts", "--headless"],
command: ["libretto", "run", "src/workflows/hncb-statements.ts", "--headless"],
command: ["node", "--env-file-if-exists=.env", "--no-warnings", "--experimental-strip-types", "src/ledger/sync-maicoin.ts"],
command: ["node", "--no-warnings", "--experimental-strip-types", "src/ledger/import-downloads-csv.ts"],
```

Place each line on the matching task object immediately after `script`.

- [ ] **Step 4: Add command resolver**

Create `src/lib/automation/server/desktop-command.ts`:

```ts
import { join, normalize } from "node:path";
import type { AutomationTask } from "./tasks.ts";

export type ResolvedAutomationCommand = {
  display: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

function isDesktopRuntime(env: NodeJS.ProcessEnv) {
  return env.OCTOPUSBEAK_DESKTOP === "1";
}

function appRoot(env: NodeJS.ProcessEnv) {
  return env.OCTOPUSBEAK_APP_ROOT ?? process.cwd();
}

function electronNodePath(env: NodeJS.ProcessEnv) {
  return env.OCTOPUSBEAK_NODE_PATH ?? process.execPath;
}

function withElectronRunAsNode(env: NodeJS.ProcessEnv) {
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function appFile(root: string, relativePath: string) {
  return join(root, ...normalize(relativePath).split(/[\\/]+/));
}

function absolutizeScriptArgs(args: readonly string[], root: string) {
  return args.map((arg) => (
    /\.(?:ts|js|mjs|cjs)$/.test(arg) && !arg.startsWith("/")
      ? appFile(root, arg)
      : arg
  ));
}

export function resolveLibrettoCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAutomationCommand {
  if (!isDesktopRuntime(env)) {
    return {
      display: `npx libretto ${args.join(" ")}`,
      command: "npx",
      args: ["libretto", ...args],
      env,
    };
  }

  const root = appRoot(env);
  return {
    display: `libretto ${args.join(" ")}`,
    command: electronNodePath(env),
    args: [
      join(root, "node_modules", "libretto", "dist", "cli", "index.js"),
      ...absolutizeScriptArgs(args, root),
    ],
    env: withElectronRunAsNode(env),
  };
}

export function resolveNodeScriptCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAutomationCommand {
  if (!isDesktopRuntime(env)) {
    return {
      display: `node ${args.join(" ")}`,
      command: "node",
      args: [...args],
      env,
    };
  }

  const root = appRoot(env);
  return {
    display: `node ${args.join(" ")}`,
    command: electronNodePath(env),
    args: absolutizeScriptArgs(args, root),
    env: withElectronRunAsNode(env),
  };
}

export function resolveTaskCommand(
  task: AutomationTask,
  options: { resumeSession?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAutomationCommand {
  if (options.resumeSession) {
    return resolveLibrettoCommand(["resume", "--session", options.resumeSession], env);
  }

  if (!isDesktopRuntime(env)) {
    return {
      display: task.script,
      command: "npm",
      args: ["run", task.script],
      env,
    };
  }

  const [runtime, ...args] = task.command;
  if (runtime === "libretto") {
    return {
      ...resolveLibrettoCommand(args, env),
      display: task.script,
    };
  }
  if (runtime === "node") {
    return {
      ...resolveNodeScriptCommand(args, env),
      display: task.script,
    };
  }
  throw new Error(`Unsupported automation command runtime: ${runtime}`);
}

export function resolvePatchCommand(
  options: { resumeSession?: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  if (options.resumeSession) return null;
  return resolveNodeScriptCommand(["scripts/patch-libretto-run-cdp.mjs"], env);
}
```

- [ ] **Step 5: Run check**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-command.check.ts
```

Expected: PASS with no output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/automation/server/tasks.ts src/lib/automation/server/desktop-command.ts src/lib/automation/server/desktop-command.check.ts
git commit -m "feat: resolve desktop automation commands"
```

---

### Task 6: Wire Runner To Desktop Command Resolver

**Files:**
- Modify: `src/lib/automation/server/runner.ts`
- Modify: `src/lib/automation/server/runner.check.ts`

- [ ] **Step 1: Update runner imports**

In `src/lib/automation/server/runner.ts`, add:

```ts
import {
  resolveLibrettoCommand,
  resolvePatchCommand,
  resolveTaskCommand,
} from "./desktop-command.ts";
```

- [ ] **Step 2: Replace direct close-session spawn**

Replace `closeLibrettoSession` with:

```ts
export async function closeLibrettoSession(session: string) {
  await new Promise<void>((resolve, reject) => {
    const command = resolveLibrettoCommand(
      ["close", "--session", session],
      automationProcessEnv(),
    );
    const child = spawn(command.command, command.args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: command.env,
    });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errorText = tail(errorText + chunk.toString("utf8"));
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(errorText || `libretto close exited with code ${exitCode}`));
    });
  });
}
```

- [ ] **Step 3: Keep `librettoRunCdpPatchCommand` as a compatibility wrapper**

Replace the existing function with:

```ts
export function librettoRunCdpPatchCommand(input: { resumeSession?: string }) {
  const command = resolvePatchCommand(input);
  return command ? [command.command, ...command.args] as const : null;
}
```

This keeps existing runner checks simple while the actual runner uses the richer command object.

- [ ] **Step 4: Use resolved commands in `runAutomationTask`**

Inside `runAutomationTask`, replace the display script and child command construction with:

```ts
const env = automationProcessEnv();
const command = resolveTaskCommand(task, { resumeSession: options.resumeSession }, env);
const script = command.display;
```

Inside the `new Promise`, remove the old local `command` array and `const env = automationProcessEnv();`. Use the already-created command object:

```ts
const patchCommand = resolvePatchCommand(options, env);
if (patchCommand) {
  const patch = spawnSync(patchCommand.command, patchCommand.args, {
    env: patchCommand.env,
    encoding: "utf8",
  });
  if (patch.stdout) onOutput(Buffer.from(patch.stdout));
  if (patch.stderr) onOutput(Buffer.from(patch.stderr));
  if (patch.error || patch.status !== 0) {
    resolve({
      exitCode: patch.status,
      signal: patch.signal,
      error: patch.error ?? new Error(`Libretto CDP patch exited with code ${patch.status}`),
    });
    return;
  }
}

const child = spawn(command.command, command.args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: command.env,
});
```

- [ ] **Step 5: Add desktop patch-command check**

In `src/lib/automation/server/runner.check.ts`, keep the existing non-desktop patch assertion and add this desktop-specific assertion below it:

```ts
const originalDesktop = process.env.OCTOPUSBEAK_DESKTOP;
const originalAppRoot = process.env.OCTOPUSBEAK_APP_ROOT;
const originalNodePath = process.env.OCTOPUSBEAK_NODE_PATH;
process.env.OCTOPUSBEAK_DESKTOP = "1";
process.env.OCTOPUSBEAK_APP_ROOT = "/AppRoot";
process.env.OCTOPUSBEAK_NODE_PATH = "/AppRoot/OctopusBeak";
assert.deepEqual(librettoRunCdpPatchCommand({ resumeSession: undefined }), [
  "/AppRoot/OctopusBeak",
  "/AppRoot/scripts/patch-libretto-run-cdp.mjs",
]);
if (originalDesktop === undefined) delete process.env.OCTOPUSBEAK_DESKTOP;
else process.env.OCTOPUSBEAK_DESKTOP = originalDesktop;
if (originalAppRoot === undefined) delete process.env.OCTOPUSBEAK_APP_ROOT;
else process.env.OCTOPUSBEAK_APP_ROOT = originalAppRoot;
if (originalNodePath === undefined) delete process.env.OCTOPUSBEAK_NODE_PATH;
else process.env.OCTOPUSBEAK_NODE_PATH = originalNodePath;
```

- [ ] **Step 6: Run checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-command.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/automation/server/runner.ts src/lib/automation/server/runner.check.ts
git commit -m "feat: run automation commands in packaged desktop app"
```

---

### Task 7: Package Playwright Browser Runtime

**Files:**
- Modify: `package.json`
- Verify: `node_modules/playwright-core/.local-browsers`

- [ ] **Step 1: Install bundled Chromium runtime**

Run:

```bash
npm run desktop:install-browsers
```

Expected: Chromium files are installed under `node_modules/playwright-core/.local-browsers`.

- [ ] **Step 2: Verify packaged runtime path**

Run:

```bash
test -d node_modules/playwright-core/.local-browsers
```

Expected: command exits `0`.

- [ ] **Step 3: Package app**

Run:

```bash
npm run desktop:package
```

Expected: Forge completes and creates an unpacked app under `out/`.

- [ ] **Step 4: Launch packaged app directly**

Run the app produced under `out/` from Finder or with:

```bash
open out/*/OctopusBeak.app
```

Expected: Electron opens `/overview`. It does not require the source repo's current working directory.

- [ ] **Step 5: Commit**

If `package.json` changed during this task, commit it. If only `node_modules` and `out/` changed, do not commit generated artifacts.

```bash
git status --short
git add package.json package-lock.json
git commit -m "chore: package playwright browser runtime"
```

Expected if no tracked files changed: skip the commit.

---

### Task 8: Add Desktop Release Documentation And Signing Flow

**Files:**
- Create: `docs/desktop-release.md`

- [ ] **Step 1: Add release documentation**

Create `docs/desktop-release.md`:

````md
# Desktop Release

OctopusBeak desktop releases use Electron Forge.

## Local Unsigned Build

```bash
npm run desktop:package
open out/*/OctopusBeak.app
```

Use this for local smoke testing only.

## macOS Signing Identity

List installed signing identities:

```bash
security find-identity -p codesigning -v
```

The signing identity must include a `Developer ID Application` certificate for distribution outside the Mac App Store.

## Notarization Credentials

Store notarization credentials in the local keychain profile used by Forge:

```bash
xcrun notarytool store-credentials OctopusBeakNotary \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_PASSWORD"
```

`APPLE_PASSWORD` is an app-specific password, not the normal Apple ID password.

## Signed Build

```bash
OCTOPUSBEAK_SIGN=1 OCTOPUSBEAK_NOTARY_PROFILE=OctopusBeakNotary npm run desktop:make
```

Forge signs and notarizes during packaging when `OCTOPUSBEAK_SIGN=1`.

## Smoke Test

1. Install the generated DMG on a clean macOS account.
2. Launch OctopusBeak from `/Applications`.
3. Open `/overview`, `/assets`, `/liabilities`, and `/automation`.
4. Save credentials in the automation panel.
5. Run the mock ledger seed flow from a developer build, or import known-safe CSV files.
6. Confirm new files appear under `~/Library/Application Support/OctopusBeak/`.

Do not run real bank workflows in automated checks.
````

- [ ] **Step 2: Verify signing identity exists on this machine**

Run:

```bash
security find-identity -p codesigning -v
```

Expected: output includes a `Developer ID Application` identity.

- [ ] **Step 3: Store notarization credentials**

Run this with the developer account environment variables set in the shell:

```bash
xcrun notarytool store-credentials OctopusBeakNotary \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_PASSWORD"
```

Expected: `notarytool` validates and stores credentials in the local keychain.

- [ ] **Step 4: Commit docs**

```bash
git add docs/desktop-release.md
git commit -m "docs: add desktop release checklist"
```

---

### Task 9: Final Verification And Signed Artifact

**Files:**
- Verify: whole project

- [ ] **Step 1: Run code checks**

Run:

```bash
npm run typecheck
npm run check:libretto-patch
node electron/runtime.check.cjs
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-command.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
npm run desktop:runtime-probe
npm run desktop:strip-types-probe
```

Expected: all commands pass.

- [ ] **Step 2: Build unsigned package**

Run:

```bash
npm run desktop:package
```

Expected: unpacked macOS app is created under `out/`.

- [ ] **Step 3: Build signed distributable**

Run:

```bash
OCTOPUSBEAK_SIGN=1 OCTOPUSBEAK_NOTARY_PROFILE=OctopusBeakNotary npm run desktop:make
```

Expected: Forge produces signed/notarized macOS DMG and ZIP artifacts under `out/make/`.

- [ ] **Step 4: Manual install smoke test**

Install the DMG on this Mac and launch from `/Applications`.

Expected:

```text
OctopusBeak opens in an Electron window.
/overview loads.
/automation loads.
~/Library/Application Support/OctopusBeak/.env exists.
~/Library/Application Support/OctopusBeak/data/ledger exists.
~/Library/Application Support/OctopusBeak/downloads exists.
```

- [ ] **Step 5: Final commit if verification changes tracked files**

Run:

```bash
git status --short
```

If tracked files changed because of verification doc or script corrections, commit them:

```bash
git add package.json package-lock.json .gitignore forge.config.cjs electron src docs
git commit -m "chore: verify desktop packaging"
```

Expected if no tracked files changed: skip the commit.
