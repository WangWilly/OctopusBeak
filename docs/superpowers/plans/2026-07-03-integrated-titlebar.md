# Integrated Titlebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OctopusBeak Electron window feel integrated by hiding the macOS title bar while preserving native window controls and keeping Windows/Linux as explicit future-safe fallbacks.

**Architecture:** Put all platform-specific window chrome behavior in one Electron helper, then spread that helper into the existing `BrowserWindow` options. Mark Electron renderer instances with a root class so CSS can add a titlebar safe area and drag regions without changing the browser preview layout.

**Tech Stack:** Electron 43, Svelte 5, SvelteKit static renderer, Vite Electron build, Node assert-based `.check.ts` scripts.

---

## File Structure

- Create `electron/window-options.ts`: pure helper that returns the minimum integrated titlebar options for the current platform.
- Create `electron/window-options.check.ts`: assert-based check for macOS behavior and Windows/Linux native fallback behavior.
- Modify `electron/main.ts`: import and spread the helper into `BrowserWindow` options.
- Modify `src/routes/+layout.svelte`: add an Electron-only root class when `window.octopusBeak` exists.
- Modify `src/app.css`: add desktop-only safe spacing and native drag regions.

Non-goal: do not use `frame: false`; it makes close/minimize/maximize, dragging, resize, and platform edge cases our code.

### Task 1: Add Platform Window Options Helper

**Files:**
- Create: `electron/window-options.ts`
- Create: `electron/window-options.check.ts`

- [ ] **Step 1: Write the failing helper check**

Create `electron/window-options.check.ts`:

```ts
import assert from "node:assert/strict";
import { integratedTitleBarOptions } from "./window-options.ts";

const macOptions = integratedTitleBarOptions("darwin");

assert.deepEqual(macOptions, {
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 14, y: 14 },
});
assert.equal(Object.hasOwn(macOptions, "frame"), false);

assert.deepEqual(integratedTitleBarOptions("win32"), {});
assert.deepEqual(integratedTitleBarOptions("linux"), {});
```

- [ ] **Step 2: Run the check to verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types electron/window-options.check.ts
```

Expected: FAIL because `electron/window-options.ts` does not exist.

- [ ] **Step 3: Add the helper**

Create `electron/window-options.ts`:

```ts
import type { BrowserWindowConstructorOptions } from "electron";

type IntegratedTitleBarOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay"
>;

export function integratedTitleBarOptions(
  platform: NodeJS.Platform = process.platform,
): Partial<IntegratedTitleBarOptions> {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 },
    };
  }

  // ponytail: keep non-mac native until Windows/Linux integrated titlebars are visually verified.
  return {};
}
```

- [ ] **Step 4: Run the check to verify it passes**

Run:

```bash
node --no-warnings --experimental-strip-types electron/window-options.check.ts
```

Expected: PASS with no output.

- [ ] **Step 5: Commit**

```bash
git add electron/window-options.ts electron/window-options.check.ts
git commit -m "feat: add integrated titlebar window options"
```

### Task 2: Wire Options Into BrowserWindow

**Files:**
- Modify: `electron/main.ts:1-90`

- [ ] **Step 1: Import the helper**

Update the import block in `electron/main.ts`:

```ts
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog } from "electron";
import { registerAutomationCredentialSafeStorage } from "./credential-codec.ts";
import { registerOctopusBeakIpc } from "./ipc.ts";
import { integratedTitleBarOptions } from "./window-options.ts";
// @ts-expect-error runtime.cjs is bundled by Vite; keeping it CJS avoids changing the packaged entry.
import runtime from "./runtime.cjs";
```

- [ ] **Step 2: Spread the helper into the window options**

Update the `BrowserWindow` construction in `electron/main.ts`:

```ts
    const window = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 980,
      minHeight: 700,
      title: "OctopusBeak",
      ...integratedTitleBarOptions(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: preloadPath,
      },
    });
```

- [ ] **Step 3: Build the Electron entry**

Run:

```bash
npm run build:electron
```

Expected: Vite builds `build-electron/main.cjs` and `build-electron/preload.cjs` without TypeScript or Rollup errors.

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts
git commit -m "feat: apply integrated titlebar options"
```

### Task 3: Add Desktop-Only Safe Area And Drag Regions

**Files:**
- Modify: `src/routes/+layout.svelte:1-8`
- Modify: `src/app.css:76-96`
- Modify: `src/app.css:267-280`

- [ ] **Step 1: Mark Electron renderer instances**

Replace `src/routes/+layout.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import "../app.css";

  onMount(() => {
    if ("octopusBeak" in window) document.documentElement.classList.add("desktop-shell");
  });
</script>

<slot />
```

- [ ] **Step 2: Add desktop-only titlebar spacing and drag regions**

Add this block after the `.sidebar` rule in `src/app.css`:

```css
html.desktop-shell {
  --titlebar-safe-top: 28px;
}

html.desktop-shell .sidebar,
html.desktop-shell .topbar {
  -webkit-app-region: drag;
}

html.desktop-shell .sidebar :is(a, button),
html.desktop-shell .topbar :is(a, button, input, select, textarea, [role="button"]) {
  -webkit-app-region: no-drag;
}

html.desktop-shell .sidebar {
  padding-top: calc(var(--space-6) + var(--titlebar-safe-top));
}

html.desktop-shell .shell-page.sidebar-collapsed .sidebar {
  padding-top: calc(var(--space-4) + var(--titlebar-safe-top));
}
```

- [ ] **Step 3: Typecheck renderer and Electron code**

Run:

```bash
npm run typecheck
```

Expected: `svelte-check` and `tsc --noEmit` pass.

- [ ] **Step 4: Commit**

```bash
git add src/routes/+layout.svelte src/app.css
git commit -m "feat: add desktop titlebar safe area"
```

### Task 4: Verify The Desktop Window Visually

**Files:**
- Read-only verification of the running Electron app.

- [ ] **Step 1: Build everything**

Run:

```bash
npm run build
```

Expected: renderer and Electron builds both complete successfully.

- [ ] **Step 2: Start the Electron app with CDP**

Run and keep it running:

```bash
npm run desktop:dev
```

Expected output includes:

```text
Electron remote debugging listening on port 9222
DevTools listening on ws://127.0.0.1:9222/devtools/browser/
```

- [ ] **Step 3: Confirm CDP is reachable**

Run:

```bash
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list
```

Expected: JSON responses from Electron, including one page target for the OctopusBeak renderer.

- [ ] **Step 4: Inspect the live app**

Using the Electron CDP/browser tool, navigate the renderer to:

```text
file:///Volumes/projects02/libretto-playground/build/index.html#/liabilities
```

Expected visual checks:

- No white native titlebar strip above the app.
- macOS traffic lights remain visible.
- Traffic lights do not overlap the OctopusBeak logo or title.
- Sidebar links remain clickable.
- Topbar search and value visibility toggle remain clickable.
- The window can be dragged from the topbar or unused sidebar background.
- Console has no new errors.

- [ ] **Step 5: Commit verification-only adjustments if needed**

If the traffic lights still overlap the brand, adjust only `--titlebar-safe-top` in `src/app.css` by 4px increments, then repeat Step 4.

After the visual check passes:

```bash
git add src/app.css
git commit -m "fix: tune titlebar safe area"
```

Skip this commit when no CSS tuning was needed.

## Future Windows/Linux Expansion

When Windows/Linux packaging is added, change only `electron/window-options.ts` after visual verification on those platforms. The expected future branch is `titleBarOverlay`, not `frame: false`, so native close/minimize/maximize controls stay owned by the OS.

## Self-Review

- Spec coverage: macOS integration is implemented by Tasks 1-4; Windows/Linux future risk is contained by the helper fallback and final expansion note.
- Placeholder scan: no placeholder tokens, vague edge handling, or undefined helper names remain.
- Type consistency: `integratedTitleBarOptions` is defined in Task 1, imported in Task 2, and covered by `electron/window-options.check.ts`.
