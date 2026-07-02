# Electron Static Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove SvelteKit SSR/server runtime from the Electron desktop app and move all data/automation access behind Electron main/preload IPC.

**Architecture:** Keep the existing ledger and automation server modules, but call them from Electron main instead of SvelteKit server routes. Build a static Svelte renderer with hash routing and expose one typed `window.octopusBeak` preload API. Bundle Electron main/preload with Vite so main can import existing TypeScript modules without relying on the SvelteKit server build.

**Tech Stack:** Electron, SvelteKit static adapter, Svelte 5, Vite, Node IPC, existing SQLite/automation modules.

---

## File Map

- Create `src/lib/desktop/api.ts`: shared preload API and DTO types.
- Create `src/lib/desktop/api.check.ts`: type/runtime contract smoke check.
- Create `src/app.d.ts`: `window.octopusBeak` global typing.
- Create `src/lib/automation/types.ts`: renderer-safe automation model types.
- Modify `src/lib/automation/server/page-model.ts`: import automation model types from `src/lib/automation/types.ts`.
- Modify `src/lib/automation/AutomationDashboard.svelte`: import renderer-safe types and accept callback props instead of SvelteKit forms/fetch.
- Create `src/lib/automation/server/desktop-api.ts`: reusable automation actions currently embedded in `src/routes/automation/+page.server.ts`.
- Create `src/lib/automation/server/desktop-api.check.ts`: action validation and save split checks.
- Create `electron/ipc.ts`: Electron main IPC handlers.
- Create `electron/preload.ts`: context bridge API.
- Create `electron/preload.check.ts`: preload channel shape check.
- Create `electron.vite.config.ts`: build Electron main/preload into ignored `build-electron/`.
- Modify `electron/main.cjs` or replace with `electron/main.ts`: stop HTTP server and load static renderer with preload.
- Modify `electron/runtime.cjs` and `electron/runtime.check.cjs`: remove local HTTP server helpers once main no longer uses them.
- Modify `svelte.config.js`: switch from adapter-node to adapter-static.
- Modify `package.json` and `package-lock.json`: install adapter-static, remove adapter-node, update `main` and build scripts.
- Modify `.gitignore`: ignore generated Electron bundle output.
- Create `src/routes/+layout.ts`: disable SSR and enable prerender.
- Replace `src/routes/+page.svelte`: static hash-router app shell.
- Delete SvelteKit server routes: `src/routes/**/*.server.ts`, `src/routes/**/+server.ts`.
- Delete route page wrappers once `src/routes/+page.svelte` renders all dashboards.
- Modify `src/lib/shared-shell/components/DashboardShell.svelte`: use hash links.

---

## Task 1: Shared Renderer API Contracts

**Files:**
- Create: `src/lib/desktop/api.ts`
- Create: `src/lib/desktop/api.check.ts`
- Create: `src/app.d.ts`
- Create: `src/lib/automation/types.ts`
- Modify: `src/lib/automation/server/page-model.ts`
- Modify: `src/lib/automation/AutomationDashboard.svelte`

- [ ] **Step 1: Move automation model types out of the server module**

Create `src/lib/automation/types.ts`:

```ts
import type { AutomationTask } from "./server/tasks.ts";
import type { AutomationTaskRun, AutomationTaskStatus } from "./server/store.ts";

type ImportGate = {
  locked: boolean;
  missingTaskIds: readonly string[];
};

export type AutomationTaskRow = AutomationTask & {
  status: AutomationTaskStatus;
  attempt: number;
  latestStartedAt: string | null;
  latestFinishedAt: string | null;
  logTail: string;
  errorMessage: string | null;
  logPath: string | null;
  progressPercent: number | null;
  progressText: string;
  humanSession: string | null;
  isActive: boolean;
  primaryAction: "Run" | "Run again" | "Resume" | "Locked" | "Running";
  canRun: boolean;
};

export type AutomationPageModel = {
  businessDate: string;
  active: boolean;
  activeTaskCount: number;
  credentials: Record<string, boolean>;
  importGate: ImportGate;
  tasks: AutomationTaskRow[];
};
```

Then update `src/lib/automation/server/page-model.ts`:

```ts
import type { AutomationPageModel, AutomationTaskRow } from "../types.ts";
```

Remove the local `ImportGate`, `AutomationTaskRow`, and `AutomationPageModel` type declarations from `page-model.ts`; keep the runtime functions unchanged.

- [ ] **Step 2: Update renderer type import**

In `src/lib/automation/AutomationDashboard.svelte`, replace:

```ts
import type { AutomationPageModel, AutomationTaskRow } from "./server/page-model.ts";
```

with:

```ts
import type { AutomationPageModel, AutomationTaskRow } from "./types.ts";
```

- [ ] **Step 3: Add desktop API contract**

Create `src/lib/desktop/api.ts`:

```ts
import type { AssetsPageDto } from "$lib/assets/types.ts";
import type { AutomationCredentialGroup } from "$lib/automation/server/tasks.ts";
import type { AutomationPageModel } from "$lib/automation/types.ts";
import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
import type { OverviewPageDto } from "$lib/overview/types.ts";

export type CredentialGroupDto = AutomationCredentialGroup & {
  enabled: boolean;
};

export type AutomationDesktopModel = {
  automation: AutomationPageModel;
  credentialGroups: CredentialGroupDto[];
};

export type AutomationActionResult =
  | { started: string }
  | { resumed: string }
  | { saved: true }
  | { ok: true }
  | { ok: true; closed: boolean };

export type OctopusBeakApi = {
  overview: {
    load(): Promise<OverviewPageDto>;
  };
  assets: {
    load(): Promise<AssetsPageDto>;
  };
  liabilities: {
    load(): Promise<LiabilitiesPageDto>;
  };
  automation: {
    load(): Promise<AutomationDesktopModel>;
    saveCredentials(updates: Record<string, string>): Promise<{ saved: true }>;
    run(taskId: string): Promise<{ started: string }>;
    resume(taskId: string): Promise<{ resumed: string }>;
    viewerScreenshot(taskId: string): Promise<Uint8Array>;
    viewerInput(taskId: string, input: unknown): Promise<{ ok: true }>;
    forceQuit(taskId: string): Promise<{ ok: true; closed: boolean }>;
  };
};

export const octopusBeakApiChannels = [
  "overview:load",
  "assets:load",
  "liabilities:load",
  "automation:load",
  "automation:saveCredentials",
  "automation:run",
  "automation:resume",
  "automation:viewerScreenshot",
  "automation:viewerInput",
  "automation:forceQuit",
] as const;

export type OctopusBeakApiChannel = typeof octopusBeakApiChannels[number];
```

- [ ] **Step 4: Add global renderer type**

Create `src/app.d.ts`:

```ts
import type { OctopusBeakApi } from "$lib/desktop/api.ts";

declare global {
  interface Window {
    octopusBeak: OctopusBeakApi;
  }
}

export {};
```

- [ ] **Step 5: Add the API contract check**

Create `src/lib/desktop/api.check.ts`:

```ts
import assert from "node:assert/strict";
import { octopusBeakApiChannels } from "./api.ts";

assert.deepEqual([...octopusBeakApiChannels], [
  "overview:load",
  "assets:load",
  "liabilities:load",
  "automation:load",
  "automation:saveCredentials",
  "automation:run",
  "automation:resume",
  "automation:viewerScreenshot",
  "automation:viewerInput",
  "automation:forceQuit",
]);
```

- [ ] **Step 6: Run checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/desktop/api.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/desktop/api.ts src/lib/desktop/api.check.ts src/app.d.ts src/lib/automation/types.ts src/lib/automation/server/page-model.ts src/lib/automation/AutomationDashboard.svelte
git commit -m "chore: add desktop API contracts"
```

---

## Task 2: Extract Automation Desktop Actions

**Files:**
- Create: `src/lib/automation/server/desktop-api.ts`
- Create: `src/lib/automation/server/desktop-api.check.ts`
- Modify: `src/routes/automation/+page.server.ts`

- [ ] **Step 1: Create the failing check**

Create `src/lib/automation/server/desktop-api.check.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "automation-desktop-api-"));
const originalCwd = process.cwd();
const credentialPrefix = "LIBRETTO_CLOUD_" + "FUBON_";
const enabledKey = `${credentialPrefix}ENABLED`;
const userIdKey = `${credentialPrefix}USER_ID`;
const accountKey = `${credentialPrefix}ACCOUNT`;
const passwordKey = `${credentialPrefix}PASSWORD`;

try {
  process.chdir(dir);
  writeFileSync("settings.json", JSON.stringify({
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    [enabledKey]: true,
  }, null, 2));
  writeFileSync("credentials.json", JSON.stringify({
    [userIdKey]: "user",
    [accountKey]: "acct",
    [passwordKey]: "pw",
  }, null, 2));

  const api = await import("./desktop-api.ts");

  const model = api.loadAutomationDesktopModel(dir);
  assert.equal(model.credentialGroups.find((group) => group.id === "fubon")?.enabled, true);
  assert.equal(model.automation.credentials[passwordKey], true);

  assert.throws(
    () => api.assertAutomationTaskCanStart("import-downloads-csv", dir),
    /Import is locked/,
  );

  assert.deepEqual(api.automationSaveCredentials({
    [enabledKey]: "false",
    [accountKey]: "next-acct",
  }), { saved: true });
} finally {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the check and verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-api.check.ts
```

Expected: FAIL because `desktop-api.ts` does not exist.

- [ ] **Step 3: Add desktop automation API module**

Create `src/lib/automation/server/desktop-api.ts` with the logic currently in `src/routes/automation/+page.server.ts`, but return values or throw `Error` instead of using SvelteKit `fail()`:

```ts
import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_CREDENTIAL_KEYS,
  enabledAutomationTasks,
  enabledCsvImportDependencyIds,
  taskById,
} from "./tasks.ts";
import {
  credentialStatusFromValues,
  readAutomationCredentialsFile,
  splitAutomationUpdates,
  writeAutomationCredentials,
  writeAutomationSettings,
} from "./config-files.ts";
import { businessDayUtcRange } from "./business-day.ts";
import { buildAutomationPageModel } from "./page-model.ts";
import {
  automationBusinessTimezone,
  automationGroupEnabledStatus,
  readAutomationSettings,
} from "./settings.ts";
import {
  activeAutomationTaskIds,
  hasActiveAutomationTask,
  resumeSessionFromLog,
  startAutomationResume,
  startAutomationTask,
} from "./runner.ts";
import { importGateStatus, latestTaskRuns } from "./store.ts";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import type { AutomationDesktopModel } from "$lib/desktop/api.ts";

const optionalCredentialKeys = new Set(["MAX_SUB_ACCOUNT"]);

function currentCredentialStatus() {
  const settings = readAutomationSettings();
  const credentials = readAutomationCredentialsFile();
  const status = credentialStatusFromValues(credentials, AUTOMATION_CREDENTIAL_KEYS);
  for (const key of AUTOMATION_CREDENTIAL_KEYS) {
    status[key] = status[key] || Boolean(settings[key]) || Boolean(process.env[key]?.trim());
  }
  return status;
}

export function loadAutomationDesktopModel(ledgerDir = process.env.LEDGER_DIR ?? "data/ledger"): AutomationDesktopModel {
  const settings = readAutomationSettings();
  const enabledGroups = automationGroupEnabledStatus(settings);
  const db = openLedgerDatabase(ledgerDir);
  try {
    const activeTaskIds = activeAutomationTaskIds();
    const range = businessDayUtcRange(undefined, automationBusinessTimezone(settings));
    const importGate = importGateStatus(db, {
      dependencyIds: enabledCsvImportDependencyIds(enabledGroups),
      startUtc: range.startUtc,
      endUtc: range.endUtc,
    });
    return {
      automation: buildAutomationPageModel({
        tasks: enabledAutomationTasks(enabledGroups),
        latestRuns: latestTaskRuns(db),
        activeTaskIds,
        credentials: currentCredentialStatus(),
        importGate,
        active: activeTaskIds.length > 0 || hasActiveAutomationTask(),
        businessDate: range.businessDate,
      }),
      credentialGroups: AUTOMATION_CREDENTIAL_GROUPS.map((group) => ({
        ...group,
        enabled: enabledGroups[group.id] !== false,
      })),
    };
  } finally {
    db.close();
  }
}

function missingCredentialKeys(taskId: string) {
  const task = taskById(taskId);
  if (!task) return [];
  const status = currentCredentialStatus();
  return task.credentialKeys.filter((key) => !optionalCredentialKeys.has(key) && !status[key]);
}

export function assertAutomationTaskCanStart(taskId: string, ledgerDir = process.env.LEDGER_DIR ?? "data/ledger") {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  const model = loadAutomationDesktopModel(ledgerDir);
  const row = model.automation.tasks.find((item) => item.id === taskId);
  if (!row) throw new Error("Task is disabled.");
  if (row.status === "locked") {
    throw new Error("Import is locked until all crawler dependencies complete for the business day.");
  }
  const missing = missingCredentialKeys(taskId);
  if (missing.length > 0) throw new Error(`Missing credentials: ${missing.join(", ")}`);
  return task;
}

export function automationSaveCredentials(updates: Record<string, string>) {
  const split = splitAutomationUpdates(updates);
  writeAutomationSettings({
    ...readAutomationSettings(),
    ...split.settings,
  });
  if (Object.keys(split.credentials).length > 0) {
    writeAutomationCredentials({
      ...readAutomationCredentialsFile(),
      ...split.credentials,
    });
  }
  return { saved: true as const };
}

export function automationRun(taskId: string) {
  const task = assertAutomationTaskCanStart(taskId);
  startAutomationTask(task.id);
  return { started: task.id };
}

export function automationResume(taskId: string) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  const model = loadAutomationDesktopModel();
  const row = model.automation.tasks.find((item) => item.id === taskId);
  if (!row) throw new Error("Task is disabled.");
  if (row.status !== "waiting_for_human") throw new Error("Task is not waiting for human input.");
  const session = resumeSessionFromLog(row.logTail);
  if (!session) throw new Error("Missing Libretto resume session in latest log.");
  startAutomationResume(task.id, session);
  return { resumed: task.id };
}
```

- [ ] **Step 4: Reuse the module in the old SvelteKit route**

Replace duplicated logic in `src/routes/automation/+page.server.ts` with imports from `desktop-api.ts` while SSR still exists:

```ts
import { fail } from "@sveltejs/kit";
import type { Actions } from "./$types";
import {
  automationResume,
  automationRun,
  automationSaveCredentials,
  loadAutomationDesktopModel,
} from "$lib/automation/server/desktop-api.ts";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function load() {
  return loadAutomationDesktopModel();
}

export const actions: Actions = {
  saveCredentials: async ({ request }) => {
    const formData = await request.formData();
    const updates: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string" && value.trim()) updates[key] = value.trim();
    }
    try {
      return automationSaveCredentials(updates);
    } catch (error) {
      return fail(409, { message: message(error) });
    }
  },
  run: async ({ request }) => {
    const taskId = String((await request.formData()).get("taskId") ?? "");
    try {
      return automationRun(taskId);
    } catch (error) {
      return fail(409, { message: message(error) });
    }
  },
  resume: async ({ request }) => {
    const taskId = String((await request.formData()).get("taskId") ?? "");
    try {
      return automationResume(taskId);
    } catch (error) {
      return fail(409, { message: message(error) });
    }
  },
};
```

Keep this route only as a temporary compatibility wrapper; it is deleted in Task 7.

- [ ] **Step 5: Run checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-api.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/automation/server/desktop-api.ts src/lib/automation/server/desktop-api.check.ts src/routes/automation/+page.server.ts
git commit -m "refactor: extract automation desktop API"
```

---

## Task 3: Electron IPC And Preload Bridge

**Files:**
- Create: `electron/ipc.ts`
- Create: `electron/preload.ts`
- Create: `electron/preload.check.ts`

- [ ] **Step 1: Add preload channel check**

Create `electron/preload.check.ts`:

```ts
import assert from "node:assert/strict";
import { octopusBeakApiChannels } from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("automation:run"), true);
assert.equal(octopusBeakApiChannels.includes("automation:viewerScreenshot"), true);
```

- [ ] **Step 2: Run check and verify it passes before wiring**

Run:

```bash
node --no-warnings --experimental-strip-types electron/preload.check.ts
```

Expected: PASS. This locks the shared channel contract before IPC code is added.

- [ ] **Step 3: Add main IPC handlers**

Create `electron/ipc.ts`:

```ts
import { ipcMain } from "electron";
import { loadAssets } from "../src/lib/assets/server/load-assets.ts";
import {
  automationResume,
  automationRun,
  automationSaveCredentials,
  loadAutomationDesktopModel,
} from "../src/lib/automation/server/desktop-api.ts";
import { captureSessionScreenshot, sendViewerInput } from "../src/lib/automation/server/automation-viewer.ts";
import {
  forceQuitHumanSessionForTask,
  humanSessionForTask,
} from "../src/lib/automation/server/human-session.ts";
import { loadLiabilities } from "../src/lib/liabilities/server/load-liabilities.ts";
import { loadOverview } from "../src/lib/overview/server/load-overview.ts";

export function registerOctopusBeakIpc() {
  ipcMain.handle("overview:load", () => loadOverview());
  ipcMain.handle("assets:load", () => loadAssets());
  ipcMain.handle("liabilities:load", () => loadLiabilities());
  ipcMain.handle("automation:load", () => loadAutomationDesktopModel());
  ipcMain.handle("automation:saveCredentials", (_event, updates: Record<string, string>) => (
    automationSaveCredentials(updates)
  ));
  ipcMain.handle("automation:run", (_event, taskId: string) => automationRun(taskId));
  ipcMain.handle("automation:resume", (_event, taskId: string) => automationResume(taskId));
  ipcMain.handle("automation:viewerScreenshot", async (_event, taskId: string) => {
    const session = humanSessionForTask(taskId);
    return new Uint8Array(await captureSessionScreenshot(session));
  });
  ipcMain.handle("automation:viewerInput", async (_event, taskId: string, input: unknown) => {
    const session = humanSessionForTask(taskId);
    await sendViewerInput(session, input);
    return { ok: true as const };
  });
  ipcMain.handle("automation:forceQuit", async (_event, taskId: string) => ({
    ok: true as const,
    ...await forceQuitHumanSessionForTask(taskId),
  }));
}
```

- [ ] **Step 4: Add preload bridge**

Create `electron/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";
import type { OctopusBeakApi } from "../src/lib/desktop/api.ts";

const api: OctopusBeakApi = {
  overview: {
    load: () => ipcRenderer.invoke("overview:load"),
  },
  assets: {
    load: () => ipcRenderer.invoke("assets:load"),
  },
  liabilities: {
    load: () => ipcRenderer.invoke("liabilities:load"),
  },
  automation: {
    load: () => ipcRenderer.invoke("automation:load"),
    saveCredentials: (updates) => ipcRenderer.invoke("automation:saveCredentials", updates),
    run: (taskId) => ipcRenderer.invoke("automation:run", taskId),
    resume: (taskId) => ipcRenderer.invoke("automation:resume", taskId),
    viewerScreenshot: (taskId) => ipcRenderer.invoke("automation:viewerScreenshot", taskId),
    viewerInput: (taskId, input) => ipcRenderer.invoke("automation:viewerInput", taskId, input),
    forceQuit: (taskId) => ipcRenderer.invoke("automation:forceQuit", taskId),
  },
};

contextBridge.exposeInMainWorld("octopusBeak", api);
```

- [ ] **Step 5: Run checks**

Run:

```bash
node --no-warnings --experimental-strip-types electron/preload.check.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add electron/ipc.ts electron/preload.ts electron/preload.check.ts
git commit -m "feat: add Electron preload API"
```

---

## Task 4: Static Renderer And Electron Bundle Build

**Files:**
- Create: `electron/main.ts`
- Create: `electron.vite.config.ts`
- Modify: `electron/main.cjs`
- Modify: `electron/runtime.cjs`
- Modify: `electron/runtime.check.cjs`
- Modify: `svelte.config.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install static adapter and remove node adapter**

Run:

```bash
npm install -D @sveltejs/adapter-static
npm uninstall @sveltejs/adapter-node
```

Expected: `package.json` and `package-lock.json` replace `@sveltejs/adapter-node` with `@sveltejs/adapter-static`.

- [ ] **Step 2: Switch SvelteKit to static adapter**

Replace `svelte.config.js` with:

```js
import adapter from "@sveltejs/adapter-static";

/** @type {import("@sveltejs/kit").Config} */
const config = {
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
  },
};

export default config;
```

- [ ] **Step 3: Add Electron Vite config**

Create `electron.vite.config.ts`:

```ts
import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const external = [
  "electron",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  /^drizzle-orm/,
  /^libretto/,
  /^playwright/,
  /^xlsx/,
  /^zod/,
  /^@ai-sdk\/openai/,
];

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "build-electron",
    lib: {
      entry: {
        main: "electron/main.ts",
        preload: "electron/preload.ts",
      },
      formats: ["cjs"],
      fileName: (_format, name) => `${name}.cjs`,
    },
    rollupOptions: {
      external,
    },
  },
  resolve: {
    alias: {
      $lib: "/src/lib",
    },
  },
});
```

- [ ] **Step 4: Add TypeScript Electron main**

Create `electron/main.ts` by porting `electron/main.cjs` to TypeScript, but remove `startServer()` and `listenWithHandler()` usage. The critical startup body should be:

```ts
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog } from "electron";
import { registerOctopusBeakIpc } from "./ipc.ts";
import runtime from "./runtime.cjs";

const { buildDesktopEnv, ensureDataRoot } = runtime;

function rendererEntry(appRoot: string) {
  return pathToFileURL(path.join(appRoot, "build", "index.html")).href;
}

async function createWindow(rendererUrl: string, preloadPath: string) {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 980,
    minHeight: 700,
    title: "OctopusBeak",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  });
  await window.loadURL(`${rendererUrl}#/overview`);
  return window;
}
```

Keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.

- [ ] **Step 5: Keep `electron/main.cjs` as a tiny packaged entry**

Replace `electron/main.cjs` with:

```js
require("../build-electron/main.cjs");
```

This keeps `package.json` `main` stable for Electron Forge.

- [ ] **Step 6: Simplify runtime helpers**

In `electron/runtime.cjs`, remove `http`, `net`, `findFreePort`, and `listenWithHandler` once no code calls them. Keep:

```js
module.exports = {
  buildDesktopEnv,
  ensureDataRoot,
};
```

Update `electron/runtime.check.cjs` to remove localhost server assertions and instead assert:

```js
assert.equal(typeof buildDesktopEnv, "function");
assert.equal(typeof ensureDataRoot, "function");
```

- [ ] **Step 7: Update scripts**

Update `package.json` scripts:

```json
{
  "main": "electron/main.cjs",
  "scripts": {
    "build": "npm run build:renderer && npm run build:electron",
    "build:renderer": "vite build",
    "build:electron": "vite build --config electron.vite.config.ts",
    "desktop:dev": "npm run build && electron ."
  }
}
```

Keep existing desktop package/make scripts pointing at `npm run build`.

- [ ] **Step 8: Run checks**

Run:

```bash
npm run build:electron
node electron/runtime.check.cjs
npm run build
npm run desktop:runtime-probe
```

Expected: all pass. `build-electron/main.cjs` and `build-electron/preload.cjs` exist.

- [ ] **Step 9: Ignore generated Electron bundle output**

Add this line to `.gitignore`:

```gitignore
/build-electron/
```

Run: `git status --short build-electron`
Expected: no tracked or untracked `build-electron/` entries after `npm run build`.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json svelte.config.js electron.vite.config.ts electron/main.ts electron/main.cjs electron/runtime.cjs electron/runtime.check.cjs .gitignore
git commit -m "build: bundle Electron static runtime"
```

---

## Task 5: Static Hash-Routed Renderer Shell

**Files:**
- Create: `src/routes/+layout.ts`
- Replace: `src/routes/+page.svelte`
- Modify: `src/lib/shared-shell/components/DashboardShell.svelte`

- [ ] **Step 1: Add no-SSR layout config**

Create `src/routes/+layout.ts`:

```ts
export const ssr = false;
export const prerender = true;
```

- [ ] **Step 2: Update shell links to hash routes**

In `src/lib/shared-shell/components/DashboardShell.svelte`, change nav hrefs:

```ts
href: "#/overview"
href: "#/assets"
href: "#/liabilities"
href: "#/automation"
```

Change the brand link:

```svelte
<a class="brand" href="#/overview" aria-label="OctopusBeak home">
```

- [ ] **Step 3: Replace root page with client router**

Replace `src/routes/+page.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import AssetsDashboard from "$lib/assets/AssetsDashboard.svelte";
  import type { AssetsPageDto } from "$lib/assets/types.ts";
  import AutomationDashboard from "$lib/automation/AutomationDashboard.svelte";
  import type { AutomationDesktopModel } from "$lib/desktop/api.ts";
  import LiabilitiesDashboard from "$lib/liabilities/LiabilitiesDashboard.svelte";
  import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
  import OverviewDashboard from "$lib/overview/OverviewDashboard.svelte";
  import type { OverviewPageDto } from "$lib/overview/types.ts";

  type RouteId = "overview" | "assets" | "liabilities" | "automation";
  type LoadState<T> =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; data: T };

  let route: RouteId = "overview";
  let overview: LoadState<OverviewPageDto> = { status: "loading" };
  let assets: LoadState<AssetsPageDto> = { status: "loading" };
  let liabilities: LoadState<LiabilitiesPageDto> = { status: "loading" };
  let automation: LoadState<AutomationDesktopModel> = { status: "loading" };

  function normalizeRoute() {
    const next = location.hash.replace(/^#\/?/, "") as RouteId;
    route = ["overview", "assets", "liabilities", "automation"].includes(next) ? next : "overview";
    if (!location.hash || next !== route) location.hash = `/${route}`;
    void loadRoute(route);
  }

  function message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  async function loadRoute(next: RouteId) {
    try {
      if (next === "overview") overview = { status: "ready", data: await window.octopusBeak.overview.load() };
      if (next === "assets") assets = { status: "ready", data: await window.octopusBeak.assets.load() };
      if (next === "liabilities") liabilities = { status: "ready", data: await window.octopusBeak.liabilities.load() };
      if (next === "automation") automation = { status: "ready", data: await window.octopusBeak.automation.load() };
    } catch (error) {
      const failed = { status: "error" as const, message: message(error) };
      if (next === "overview") overview = failed;
      if (next === "assets") assets = failed;
      if (next === "liabilities") liabilities = failed;
      if (next === "automation") automation = failed;
    }
  }

  onMount(() => {
    normalizeRoute();
    addEventListener("hashchange", normalizeRoute);
    return () => removeEventListener("hashchange", normalizeRoute);
  });
</script>

{#if route === "overview"}
  {#if overview.status === "ready"}<OverviewDashboard overview={overview.data} />{/if}
  {#if overview.status === "loading"}<p class="status">Loading...</p>{/if}
  {#if overview.status === "error"}<p class="status">{overview.message}</p>{/if}
{:else if route === "assets"}
  {#if assets.status === "ready"}<AssetsDashboard assets={assets.data} />{/if}
  {#if assets.status === "loading"}<p class="status">Loading...</p>{/if}
  {#if assets.status === "error"}<p class="status">{assets.message}</p>{/if}
{:else if route === "liabilities"}
  {#if liabilities.status === "ready"}<LiabilitiesDashboard liabilities={liabilities.data} />{/if}
  {#if liabilities.status === "loading"}<p class="status">Loading...</p>{/if}
  {#if liabilities.status === "error"}<p class="status">{liabilities.message}</p>{/if}
{:else}
  {#if automation.status === "ready"}
    <AutomationDashboard
      automation={automation.data.automation}
      credentialGroups={automation.data.credentialGroups}
      reload={() => loadRoute("automation")}
    />
  {/if}
  {#if automation.status === "loading"}<p class="status">Loading...</p>{/if}
  {#if automation.status === "error"}<p class="status">{automation.message}</p>{/if}
{/if}

<style>
  .status {
    margin: 32px;
    color: var(--muted);
  }
</style>
```

The `AutomationDashboard` `reload` prop is added in Task 6. If Task 5 is implemented first, add a temporary no-op `reload` prop in Task 6 immediately after.

- [ ] **Step 4: Run checks**

Run:

```bash
npm run typecheck
npm run build:renderer
```

Expected: typecheck may fail until Task 6 if `reload` is not yet accepted. If so, continue directly to Task 6 before committing Task 5.

- [ ] **Step 5: Commit**

If checks pass:

```bash
git add src/routes/+layout.ts src/routes/+page.svelte src/lib/shared-shell/components/DashboardShell.svelte
git commit -m "feat: add static hash router"
```

If checks require Task 6, commit Task 5 and Task 6 together with the Task 6 commit message.

---

## Task 6: Convert Automation Dashboard To Preload Actions

**Files:**
- Modify: `src/lib/automation/AutomationDashboard.svelte`
- Modify: `src/routes/+page.svelte`

- [ ] **Step 1: Add callback props**

In `src/lib/automation/AutomationDashboard.svelte`, add:

```ts
  export let reload: () => Promise<void>;
```

- [ ] **Step 2: Replace `invalidateAll()` polling**

Remove:

```ts
import { invalidateAll } from "$app/navigation";
```

Change polling to:

```ts
  onMount(() => {
    if (automation.active) {
      pollTimer = setInterval(() => {
        void reload();
      }, 2_000);
    }
  });
```

- [ ] **Step 3: Replace SvelteKit forms with buttons**

Replace task action forms:

```svelte
<form method="POST" action={`?/${actionName(task)}`}>
  <input type="hidden" name="taskId" value={task.id} />
  <button class="button primary task-control" type="submit" disabled={!task.canRun} aria-busy={task.isActive}>
    {#if task.isActive}<span class="spinner" aria-hidden="true"></span>{/if}
    <span>{task.primaryAction}</span>
  </button>
</form>
```

with:

```svelte
<button
  class="button primary task-control"
  type="button"
  disabled={!task.canRun}
  aria-busy={task.isActive}
  onclick={() => void runTask(task)}
>
  {#if task.isActive}<span class="spinner" aria-hidden="true"></span>{/if}
  <span>{task.primaryAction}</span>
</button>
```

Add:

```ts
  let actionError = "";

  async function runTask(task: AutomationTaskRow) {
    try {
      actionError = "";
      if (task.primaryAction === "Resume") await window.octopusBeak.automation.resume(task.id);
      else await window.octopusBeak.automation.run(task.id);
      await reload();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }
```

Render `{#if actionError}<p class="viewer-error">{actionError}</p>{/if}` near the task table.

- [ ] **Step 4: Replace credentials form submit**

Change the credentials `<form>` to handle submit:

```svelte
<form class="modal-panel credential-modal" onsubmit={saveCredentials}>
```

Add:

```ts
  async function saveCredentials(event: SubmitEvent) {
    event.preventDefault();
    const updates: Record<string, string> = {};
    for (const group of credentialGroups) {
      updates[group.enabledKey] = groupEnabled[group.id] !== false ? "true" : "false";
    }
    for (const [key, value] of Object.entries(credentialDrafts)) {
      if (value.trim()) updates[key] = value.trim();
    }
    try {
      actionError = "";
      await window.octopusBeak.automation.saveCredentials(updates);
      resetCredentialChanges();
      credentialsOpen = false;
      await reload();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }
```

- [ ] **Step 5: Replace viewer HTTP endpoints**

Change screenshot loading from URL string to object URL:

```ts
  async function refreshViewerImage() {
    if (!humanTask) return;
    try {
      const bytes = await window.octopusBeak.automation.viewerScreenshot(humanTask.id);
      if (viewerImageUrl) URL.revokeObjectURL(viewerImageUrl);
      viewerImageUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      viewerError = "";
    } catch (error) {
      viewerError = error instanceof Error ? error.message : String(error);
    }
  }
```

Change `sendViewerInput` to:

```ts
  async function sendViewerInput(input: unknown) {
    if (!humanTask) return;
    try {
      await window.octopusBeak.automation.viewerInput(humanTask.id, input);
      viewerError = "";
      await refreshViewerImage();
    } catch (error) {
      viewerError = error instanceof Error ? error.message : String(error);
    }
  }
```

Change `forceQuitHumanViewer` to:

```ts
  async function forceQuitHumanViewer() {
    if (!humanTask) return;
    try {
      await window.octopusBeak.automation.forceQuit(humanTask.id);
      closeHumanViewer();
      await reload();
    } catch (error) {
      viewerError = error instanceof Error ? error.message : String(error);
    }
  }
```

Ensure `closeHumanViewer()` revokes `viewerImageUrl` before clearing it.

- [ ] **Step 6: Run checks**

Run:

```bash
npm run typecheck
npm run build:renderer
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/automation/AutomationDashboard.svelte src/routes/+page.svelte
git commit -m "feat: use preload API from renderer"
```

---

## Task 7: Delete SSR Routes And Server Endpoints

**Files:**
- Delete: `src/routes/+page.server.ts`
- Delete: `src/routes/dashboard/+page.server.ts`
- Delete: `src/routes/overview/+page.server.ts`
- Delete: `src/routes/assets/+page.server.ts`
- Delete: `src/routes/liabilities/+page.server.ts`
- Delete: `src/routes/automation/+page.server.ts`
- Delete: `src/routes/automation/viewer/screenshot/+server.ts`
- Delete: `src/routes/automation/viewer/input/+server.ts`
- Delete: `src/routes/automation/viewer/force-quit/+server.ts`
- Delete: `src/routes/overview/+page.svelte`
- Delete: `src/routes/assets/+page.svelte`
- Delete: `src/routes/liabilities/+page.svelte`
- Delete: `src/routes/automation/+page.svelte`

- [ ] **Step 1: Delete server route files**

Use `apply_patch` delete hunks or `git rm`:

```bash
git rm src/routes/+page.server.ts \
  src/routes/dashboard/+page.server.ts \
  src/routes/overview/+page.server.ts \
  src/routes/assets/+page.server.ts \
  src/routes/liabilities/+page.server.ts \
  src/routes/automation/+page.server.ts \
  src/routes/automation/viewer/screenshot/+server.ts \
  src/routes/automation/viewer/input/+server.ts \
  src/routes/automation/viewer/force-quit/+server.ts
```

- [ ] **Step 2: Delete old clean route page wrappers**

```bash
git rm src/routes/overview/+page.svelte \
  src/routes/assets/+page.svelte \
  src/routes/liabilities/+page.svelte \
  src/routes/automation/+page.svelte
```

- [ ] **Step 3: Search for SSR imports**

Run:

```bash
rg -n '\\$app/navigation|@sveltejs/kit|\\+page\\.server|\\+server|fetch\\("/automation|action=\\?/' src electron
```

Expected: no relevant renderer/server-route matches. `@sveltejs/kit` may remain only in SvelteKit config-generated types, not app code.

- [ ] **Step 4: Run checks**

Run:

```bash
npm run typecheck
npm run build
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes src/lib/automation/AutomationDashboard.svelte src/lib/shared-shell/components/DashboardShell.svelte
git commit -m "refactor: remove SvelteKit server routes"
```

---

## Task 8: Final Verification And Desktop Smoke

**Files:**
- Modify: `README.md` if SSR/browser dev instructions are now wrong.

- [ ] **Step 1: Run full checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/desktop/api.check.ts
node --no-warnings --experimental-strip-types electron/preload.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-api.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-command.check.ts
node electron/runtime.check.cjs
npm run typecheck
npm run build
npm run privacy-check
npm run secrets-check
npm run desktop:runtime-probe
```

Expected: all pass. If `node electron/runtime.check.cjs` needs localhost outside sandbox, rerun it unsandboxed.

- [ ] **Step 2: Run desktop smoke**

Run:

```bash
npm run desktop:dev
```

Manual expected results:

- app opens directly to `#/overview`
- sidebar links navigate between hash routes
- overview/assets/liabilities render local ledger data
- automation page loads task table
- credentials modal saves settings and credentials
- a simple workflow can start from automation

- [ ] **Step 3: Update README if needed**

If README still says plain `npm run dev` is supported for the app, change the desktop section to say:

```md
The desktop UI is Electron-only. Use `npm run desktop:dev` for local app development.
```

- [ ] **Step 4: Commit docs if changed**

```bash
git add README.md
git commit -m "docs: describe Electron-only desktop dev"
```

- [ ] **Step 5: Push PR branch**

```bash
git status --short
git push origin codex/refactor-ssr
```

Expected: worktree clean before push; PR #20 updates.
