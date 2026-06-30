# Automation Human Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `/automation` handle Libretto workflows that pause for mouse-driven human challenges by showing the paused browser page in a modal and forwarding bounded mouse/keyboard input to that same session.

**Architecture:** First expose a CDP endpoint for local `libretto run` sessions, because `libretto@0.6.31` currently writes `port: 0` for local run sessions. Then add a small server-only CDP helper that reads `.libretto/sessions/<session>/state.json`, captures screenshots, and forwards click/drag/type/key events. The UI uses HTTP screenshot polling first; WebSocket screencast is skipped until polling proves too slow.

**Tech Stack:** SvelteKit, Svelte 5, Node `fs/path/net`, Libretto session state, Playwright CDP connection through Libretto's installed `playwright`, existing assert-based `*.check.ts`/`.mjs` checks.

---

### Task 1: Patch Local `libretto run` To Expose A CDP Port

**Files:**
- Create: `scripts/patch-libretto-run-cdp.mjs`
- Create: `scripts/patch-libretto-run-cdp.check.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the patch self-check**

Create `scripts/patch-libretto-run-cdp.check.mjs`:

```js
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
```

- [ ] **Step 2: Run the check and verify RED**

Run: `node scripts/patch-libretto-run-cdp.check.mjs`

Expected: FAIL with `Cannot find module` or `does not provide an export named 'patchExecutionSource'`.

- [ ] **Step 3: Implement the patch script**

Create `scripts/patch-libretto-run-cdp.mjs`:

```js
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const executionPath = join(
  process.cwd(),
  "node_modules",
  "libretto",
  "dist",
  "cli",
  "commands",
  "execution.js",
);

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
    '...!args.headless && args.windowPosition ? { windowPosition: args.windowPosition } : {}\n  };',
    '...!args.headless && args.windowPosition ? { windowPosition: args.windowPosition } : {},\n    ...(args.remoteDebuggingPort ? { remoteDebuggingPort: args.remoteDebuggingPort } : {})\n  };',
  );

  if (!next.includes("const runDebugPort = args.providerName ? undefined : await pickFreePort();")) {
    next = next.replace(
      "  const handlers = createWorkflowHandlers(workflowOutcome.resolve);\n",
      "  const handlers = createWorkflowHandlers(workflowOutcome.resolve);\n  const runDebugPort = args.providerName ? undefined : await pickFreePort();\n",
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
```

- [ ] **Step 4: Add package scripts**

Modify `package.json`:

```json
{
  "scripts": {
    "postinstall": "node scripts/patch-libretto-run-cdp.mjs",
    "patch:libretto": "node scripts/patch-libretto-run-cdp.mjs",
    "check:libretto-patch": "node scripts/patch-libretto-run-cdp.check.mjs"
  }
}
```

Keep existing scripts. Add only the three keys above.

- [ ] **Step 5: Change crawler runs to headless**

In `package.json`, change crawler scripts that currently end in `--headed` to `--headless`.

Example final shape:

```json
"run:fubon-statements": "libretto run src/workflows/fubon-statements.ts --headless",
"run:fubon-all-statements": "libretto run src/workflows/fubon-all-statements.ts --headless",
"run:cathay-all-statements": "libretto run src/workflows/cathay-all-statements.ts --headless",
"run:hncb-statements": "libretto run src/workflows/hncb-statements.ts --headless"
```

Apply the same replacement to all `libretto run src/workflows/* --headed` scripts. Leave non-Libretto scripts unchanged.

- [ ] **Step 6: Verify the patch**

Run: `node scripts/patch-libretto-run-cdp.check.mjs`

Expected: PASS with no output.

Run: `npm run patch:libretto`

Expected if `node_modules` is installed: `Applied libretto run CDP patch.` or `libretto run CDP patch already applied.`

Expected if `node_modules` is absent: `libretto execution.js not found; skipping CDP patch until dependencies are installed.`

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/patch-libretto-run-cdp.mjs scripts/patch-libretto-run-cdp.check.mjs
git commit -m "chore: expose cdp port for libretto runs"
```

---

### Task 2: Add Server Helpers For Paused Libretto Sessions

**Files:**
- Create: `src/lib/automation/server/libretto-session.ts`
- Create: `src/lib/automation/server/libretto-session.check.ts`
- Modify: `src/lib/automation/server/page-model.ts`

- [ ] **Step 1: Write the failing session helper checks**

Create `src/lib/automation/server/libretto-session.check.ts`:

```ts
import assert from "node:assert/strict";
import {
  cdpEndpointFromState,
  librettoSessionPath,
  parseLibrettoSessionState,
  validateLibrettoSessionName,
} from "./libretto-session.ts";

assert.equal(validateLibrettoSessionName("ses-1p4q"), "ses-1p4q");
assert.throws(() => validateLibrettoSessionName("../bad"));
assert.throws(() => validateLibrettoSessionName("bad/slash"));

assert.equal(
  librettoSessionPath("ses-1p4q").endsWith(".libretto/sessions/ses-1p4q/state.json"),
  true,
);

assert.deepEqual(
  parseLibrettoSessionState(JSON.stringify({
    version: 1,
    session: "ses-1p4q",
    port: 48321,
    pid: 123,
    startedAt: "2026-06-30T00:00:00.000Z",
    status: "paused",
    mode: "write-access",
  })),
  {
    session: "ses-1p4q",
    port: 48321,
    cdpEndpoint: undefined,
    viewport: undefined,
  },
);

assert.equal(
  cdpEndpointFromState({ session: "ses-1p4q", port: 48321 }),
  "http://127.0.0.1:48321",
);
assert.equal(
  cdpEndpointFromState({ session: "ses-1p4q", port: 0, cdpEndpoint: "ws://127.0.0.1:9999/devtools/browser/abc" }),
  "ws://127.0.0.1:9999/devtools/browser/abc",
);
assert.equal(cdpEndpointFromState({ session: "ses-1p4q", port: 0 }), null);
```

- [ ] **Step 2: Run the check and verify RED**

Run: `node --no-warnings --experimental-strip-types src/lib/automation/server/libretto-session.check.ts`

Expected: FAIL because `libretto-session.ts` does not exist.

- [ ] **Step 3: Implement the session helper**

Create `src/lib/automation/server/libretto-session.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LibrettoSessionState = {
  session: string;
  port: number;
  cdpEndpoint?: string;
  viewport?: { width: number; height: number };
};

export function validateLibrettoSessionName(session: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(session) || session.includes("..")) {
    throw new Error(`Invalid Libretto session: ${session}`);
  }
  return session;
}

export function librettoSessionPath(session: string) {
  return join(
    process.cwd(),
    ".libretto",
    "sessions",
    validateLibrettoSessionName(session),
    "state.json",
  );
}

export function parseLibrettoSessionState(text: string): LibrettoSessionState {
  const raw = JSON.parse(text) as {
    session?: unknown;
    port?: unknown;
    cdpEndpoint?: unknown;
    viewport?: unknown;
  };
  const session = validateLibrettoSessionName(String(raw.session ?? ""));
  const port = Number(raw.port ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid Libretto session port: ${raw.port}`);
  }
  const viewport = raw.viewport && typeof raw.viewport === "object"
    ? raw.viewport as { width: number; height: number }
    : undefined;
  return {
    session,
    port,
    cdpEndpoint: typeof raw.cdpEndpoint === "string" ? raw.cdpEndpoint : undefined,
    viewport,
  };
}

export function readLibrettoSessionState(session: string) {
  const statePath = librettoSessionPath(session);
  if (!existsSync(statePath)) return null;
  return parseLibrettoSessionState(readFileSync(statePath, "utf8"));
}

export function cdpEndpointFromState(state: Pick<LibrettoSessionState, "port" | "cdpEndpoint">) {
  if (state.cdpEndpoint) return state.cdpEndpoint;
  if (state.port > 0) return `http://127.0.0.1:${state.port}`;
  return null;
}

export function cdpEndpointForSession(session: string) {
  const state = readLibrettoSessionState(session);
  return state ? cdpEndpointFromState(state) : null;
}
```

- [ ] **Step 4: Expose the waiting session in the page model**

Modify `src/lib/automation/server/page-model.ts`.

Change the import:

```ts
import { parseAutomationProgress, resumeFailureMessage, resumeSessionFromLog } from "./runner.ts";
```

Add to `AutomationTaskRow`:

```ts
  humanSession: string | null;
```

Inside the row object returned by `buildAutomationPageModel`, add:

```ts
        humanSession: status === "waiting_for_human"
          ? resumeSessionFromLog(run?.logTail ?? "")
          : null,
```

- [ ] **Step 5: Verify the helper**

Run: `node --no-warnings --experimental-strip-types src/lib/automation/server/libretto-session.check.ts`

Expected: PASS with no output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/automation/server/libretto-session.ts src/lib/automation/server/libretto-session.check.ts src/lib/automation/server/page-model.ts
git commit -m "feat: read libretto session cdp endpoint"
```

---

### Task 3: Add Screenshot And Input Routes

**Files:**
- Create: `src/lib/automation/server/human-session.ts`
- Create: `src/lib/automation/server/automation-viewer.ts`
- Create: `src/lib/automation/server/automation-viewer.check.ts`
- Create: `src/routes/automation/viewer/screenshot/+server.ts`
- Create: `src/routes/automation/viewer/input/+server.ts`

- [ ] **Step 1: Write the input validation check**

Create `src/lib/automation/server/automation-viewer.check.ts`:

```ts
import assert from "node:assert/strict";
import { normalizeViewerInput } from "./automation-viewer.ts";

assert.deepEqual(
  normalizeViewerInput({ type: "click", x: 10.2, y: 20.8 }),
  { type: "click", x: 10, y: 21 },
);

assert.deepEqual(
  normalizeViewerInput({ type: "drag", x: 1, y: 2, toX: 100, toY: 80 }),
  { type: "drag", x: 1, y: 2, toX: 100, toY: 80 },
);

assert.deepEqual(
  normalizeViewerInput({ type: "type", text: "123456" }),
  { type: "type", text: "123456" },
);

assert.deepEqual(
  normalizeViewerInput({ type: "press", key: "Enter" }),
  { type: "press", key: "Enter" },
);

assert.throws(() => normalizeViewerInput({ type: "click", x: -1, y: 0 }));
assert.throws(() => normalizeViewerInput({ type: "drag", x: 0, y: 0, toX: 1 }));
assert.throws(() => normalizeViewerInput({ type: "type", text: "" }));
assert.throws(() => normalizeViewerInput({ type: "press", key: "" }));
```

- [ ] **Step 2: Run the check and verify RED**

Run: `node --no-warnings --experimental-strip-types src/lib/automation/server/automation-viewer.check.ts`

Expected: FAIL because `automation-viewer.ts` does not exist.

- [ ] **Step 3: Implement waiting-session lookup**

Create `src/lib/automation/server/human-session.ts`:

```ts
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { resumeSessionFromLog } from "./runner.ts";
import { latestTaskRuns } from "./store.ts";
import { taskById } from "./tasks.ts";

export function humanSessionForTask(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  const db = openLedgerDatabase(ledgerDir);
  try {
    const run = latestTaskRuns(db)[taskId];
    if (!run || run.status !== "waiting_for_human") {
      throw new Error("Task is not waiting for human input.");
    }
    const session = resumeSessionFromLog(run.logTail);
    if (!session) throw new Error("Missing Libretto resume session in latest log.");
    return session;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Implement CDP screenshot/input helper**

Create `src/lib/automation/server/automation-viewer.ts`:

```ts
import type { Browser, Page } from "playwright";
import { cdpEndpointForSession } from "./libretto-session.ts";

type ViewerInput =
  | { type: "click"; x: number; y: number }
  | { type: "drag"; x: number; y: number; toX: number; toY: number }
  | { type: "type"; text: string }
  | { type: "press"; key: string };

function nonNegativePixel(value: unknown, label: string) {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded) || rounded < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return rounded;
}

export function normalizeViewerInput(raw: unknown): ViewerInput {
  const input = raw as Record<string, unknown>;
  if (input?.type === "click") {
    return {
      type: "click",
      x: nonNegativePixel(input.x, "x"),
      y: nonNegativePixel(input.y, "y"),
    };
  }
  if (input?.type === "drag") {
    return {
      type: "drag",
      x: nonNegativePixel(input.x, "x"),
      y: nonNegativePixel(input.y, "y"),
      toX: nonNegativePixel(input.toX, "toX"),
      toY: nonNegativePixel(input.toY, "toY"),
    };
  }
  if (input?.type === "type" && typeof input.text === "string" && input.text.length > 0) {
    return { type: "type", text: input.text };
  }
  if (input?.type === "press" && typeof input.key === "string" && input.key.length > 0) {
    return { type: "press", key: input.key };
  }
  throw new Error("Unsupported viewer input.");
}

function disconnectBrowser(browser: Browser) {
  (browser as unknown as { _connection?: { close(): void } })._connection?.close();
}

function activePage(browser: Browser): Page {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => {
    const url = candidate.url();
    return !url.startsWith("devtools://") && !url.startsWith("chrome-error://");
  });
  if (!page) throw new Error("No active browser page found.");
  return page;
}

async function withPausedPage<T>(session: string, callback: (page: Page) => Promise<T>) {
  const endpoint = cdpEndpointForSession(session);
  if (!endpoint) {
    throw new Error(`No CDP endpoint available for Libretto session ${session}. Run npm run patch:libretto and restart the workflow.`);
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    return await callback(activePage(browser));
  } finally {
    disconnectBrowser(browser);
  }
}

export async function captureSessionScreenshot(session: string) {
  return await withPausedPage(session, async (page) => {
    return await page.screenshot({
      type: "jpeg",
      quality: 72,
      animations: "disabled",
    });
  });
}

export async function sendViewerInput(session: string, rawInput: unknown) {
  const input = normalizeViewerInput(rawInput);
  await withPausedPage(session, async (page) => {
    if (input.type === "click") {
      await page.mouse.click(input.x, input.y);
      return;
    }
    if (input.type === "drag") {
      await page.mouse.move(input.x, input.y);
      await page.mouse.down();
      await page.mouse.move(input.toX, input.toY, { steps: 12 });
      await page.mouse.up();
      return;
    }
    if (input.type === "type") {
      await page.keyboard.type(input.text, { delay: 20 });
      return;
    }
    await page.keyboard.press(input.key);
  });
}
```

- [ ] **Step 5: Add screenshot route**

Create `src/routes/automation/viewer/screenshot/+server.ts`:

```ts
import { error } from "@sveltejs/kit";
import { captureSessionScreenshot } from "$lib/automation/server/automation-viewer.ts";
import { humanSessionForTask } from "$lib/automation/server/human-session.ts";

export async function GET({ url }) {
  const taskId = url.searchParams.get("taskId");
  if (!taskId) throw error(400, "Missing taskId.");
  try {
    const session = humanSessionForTask(taskId);
    const image = await captureSessionScreenshot(session);
    return new Response(image, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
      },
    });
  } catch (cause) {
    throw error(409, cause instanceof Error ? cause.message : String(cause));
  }
}
```

- [ ] **Step 6: Add input route**

Create `src/routes/automation/viewer/input/+server.ts`:

```ts
import { json, error } from "@sveltejs/kit";
import { sendViewerInput } from "$lib/automation/server/automation-viewer.ts";
import { humanSessionForTask } from "$lib/automation/server/human-session.ts";

export async function POST({ request }) {
  const body = await request.json() as { taskId?: string; input?: unknown };
  if (!body.taskId) throw error(400, "Missing taskId.");
  try {
    const session = humanSessionForTask(body.taskId);
    await sendViewerInput(session, body.input);
    return json({ ok: true });
  } catch (cause) {
    throw error(409, cause instanceof Error ? cause.message : String(cause));
  }
}
```

- [ ] **Step 7: Verify the helper**

Run: `node --no-warnings --experimental-strip-types src/lib/automation/server/automation-viewer.check.ts`

Expected: PASS with no output.

- [ ] **Step 8: Commit**

```bash
git add src/lib/automation/server/human-session.ts src/lib/automation/server/automation-viewer.ts src/lib/automation/server/automation-viewer.check.ts src/routes/automation/viewer
git commit -m "feat: add automation browser viewer endpoints"
```

---

### Task 4: Add The Human Viewer Modal

**Files:**
- Modify: `src/lib/automation/AutomationDashboard.svelte`

- [ ] **Step 1: Add modal state and screenshot polling**

In the `<script lang="ts">` block, add:

```ts
  let humanTask: AutomationTaskRow | null = null;
  let viewerTimer: ReturnType<typeof setInterval> | null = null;
  let viewerImageUrl = "";
  let viewerError = "";
  let dragStart: { x: number; y: number } | null = null;

  function refreshViewerImage() {
    if (!humanTask) return;
    viewerImageUrl = `/automation/viewer/screenshot?taskId=${encodeURIComponent(humanTask.id)}&t=${Date.now()}`;
  }

  function openHumanViewer(task: AutomationTaskRow) {
    humanTask = task;
    viewerError = "";
    refreshViewerImage();
    if (viewerTimer) clearInterval(viewerTimer);
    viewerTimer = setInterval(refreshViewerImage, 750);
  }

  function closeHumanViewer() {
    humanTask = null;
    viewerImageUrl = "";
    viewerError = "";
    dragStart = null;
    if (viewerTimer) clearInterval(viewerTimer);
    viewerTimer = null;
  }

  async function sendViewerInput(input: unknown) {
    if (!humanTask) return;
    const response = await fetch("/automation/viewer/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: humanTask.id, input }),
    });
    if (!response.ok) {
      viewerError = await response.text();
      return;
    }
    viewerError = "";
    refreshViewerImage();
  }

  function pointerPoint(event: PointerEvent) {
    const image = event.currentTarget as HTMLImageElement;
    const rect = image.getBoundingClientRect();
    return {
      x: Math.round((event.clientX - rect.left) * (image.naturalWidth / rect.width)),
      y: Math.round((event.clientY - rect.top) * (image.naturalHeight / rect.height)),
    };
  }
```

Update `onDestroy`:

```ts
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (viewerTimer) clearInterval(viewerTimer);
  });
```

- [ ] **Step 2: Add the Assist button**

In `.task-actions`, after the primary action form and before `Logs`, add:

```svelte
                    {#if task.status === "waiting_for_human" && task.humanSession}
                      <button class="button secondary task-control" type="button" onclick={() => openHumanViewer(task)}>
                        Assist
                      </button>
                    {/if}
```

- [ ] **Step 3: Add the modal markup**

After the logs modal block, add:

```svelte
{#if humanTask}
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="human-viewer-title">
    <button class="modal-backdrop" type="button" aria-label="Close human viewer" onclick={closeHumanViewer}></button>
    <div class="modal-panel human-viewer-modal">
      <div class="modal-head">
        <div>
          <h2 id="human-viewer-title">{humanTask.label} Assist</h2>
          <p>{humanTask.humanSession ?? "No session"}</p>
        </div>
        <div class="viewer-actions">
          <form method="POST" action="?/resume">
            <input type="hidden" name="taskId" value={humanTask.id} />
            <button class="button primary fixed-action" type="submit">Resume</button>
          </form>
          <button class="modal-close" type="button" aria-label="Close" onclick={closeHumanViewer}>x</button>
        </div>
      </div>
      <div class="modal-body viewer-body">
        {#if viewerError}<p class="viewer-error">{viewerError}</p>{/if}
        {#if viewerImageUrl}
          <img
            class="viewer-image"
            src={viewerImageUrl}
            alt="Paused browser"
            draggable="false"
            onload={() => (viewerError = "")}
            onerror={() => (viewerError = "Viewer screenshot is not available yet.")}
            onpointerdown={(event) => {
              dragStart = pointerPoint(event);
              (event.currentTarget as HTMLImageElement).setPointerCapture(event.pointerId);
            }}
            onpointerup={(event) => {
              const end = pointerPoint(event);
              const start = dragStart;
              dragStart = null;
              if (!start) return;
              const moved = Math.abs(start.x - end.x) + Math.abs(start.y - end.y);
              void sendViewerInput(
                moved > 8
                  ? { type: "drag", x: start.x, y: start.y, toX: end.x, toY: end.y }
                  : { type: "click", x: end.x, y: end.y },
              );
            }}
          />
        {/if}
        <div class="viewer-keyboard">
          <input
            class="viewer-text-input"
            placeholder="Type text"
            autocomplete="off"
            onkeydown={(event) => {
              if (event.key !== "Enter") return;
              const input = event.currentTarget as HTMLInputElement;
              if (!input.value) return;
              void sendViewerInput({ type: "type", text: input.value });
              input.value = "";
            }}
          />
          <button class="button secondary fixed-action" type="button" onclick={() => sendViewerInput({ type: "press", key: "Enter" })}>
            Enter
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
```

- [ ] **Step 4: Add modal styles**

Append to the `<style>` block:

```css
  .human-viewer-modal {
    width: min(1040px, 100%);
  }

  .viewer-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .viewer-body {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-5);
  }

  .viewer-image {
    width: 100%;
    max-height: min(68vh, 760px);
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
    touch-action: none;
    user-select: none;
  }

  .viewer-keyboard {
    display: flex;
    gap: var(--space-3);
  }

  .viewer-text-input {
    min-height: 44px;
    flex: 1;
    min-width: 0;
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
  }

  .viewer-error {
    margin: 0;
    color: var(--danger);
    font-size: 13px;
  }
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/automation/AutomationDashboard.svelte
git commit -m "feat: add automation human assist modal"
```

---

### Task 5: End-To-End Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused checks**

Run:

```bash
node scripts/patch-libretto-run-cdp.check.mjs
node --no-warnings --experimental-strip-types src/lib/automation/server/libretto-session.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-viewer.check.ts
```

Expected: all commands exit 0.

- [ ] **Step 2: Patch installed Libretto**

Run: `npm run patch:libretto`

Expected: patch applied, already applied, or skipped if dependencies are not installed.

- [ ] **Step 3: Run full project typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Manual paused-session smoke test**

Start the app:

```bash
npm run dev
```

In `/automation`, run a workflow that reaches `waiting_for_human`. Open `Assist`.

Expected:
- the modal shows a browser screenshot
- clicking in the image forwards a click to the paused page
- dragging in the image forwards a drag to the paused page
- typing text and pressing Enter forwards keyboard input
- `Resume` reuses the existing `/automation` resume action

- [ ] **Step 5: Stop the dev server and close leftover sessions**

Run:

```bash
npx libretto close --all
```

Expected: Libretto reports closed sessions or no open sessions.

---

## Self-Review

- Spec coverage: This plan covers the blocker found in `libretto run` local sessions (`port: 0`), adds a server-only endpoint reader, adds bounded input forwarding, and integrates it into `/automation`.
- Placeholder scan: No placeholder markers or copy-forward instructions remain.
- Type consistency: `humanSession`, `LibrettoSessionState`, `normalizeViewerInput`, `captureSessionScreenshot`, and `sendViewerInput` are introduced before use.
- Deliberate simplification: screenshot polling is used instead of WebSocket screencast. Upgrade only if real challenge latency makes polling unusable.
