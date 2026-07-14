# Electron Display Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent 75%–150% Electron display scaling, Settings controls, standard keyboard shortcuts, and the selected option-1 top-right fading capsule.

**Architecture:** A small Svelte store module owns normalization, persistence, and the single renderer update path. The existing preload bridge applies validated percentages through Electron `webFrame`; `DashboardShell.svelte` owns global shortcuts and the transient capsule, while `SettingsPage.svelte` owns the persistent slider UI.

**Tech Stack:** Electron 43, Svelte 5, TypeScript 5.9, Svelte stores/transitions, Node `assert` checks, existing CSS tokens.

## Global Constraints

- Electron app only; ordinary web builds must not apply or expose display scaling.
- Minimum 75%, maximum 150%, 5% increments, default/reset 100%.
- macOS shortcuts: `Command+-`, `Command++`, `Command+0`.
- Windows/Linux shortcuts: `Ctrl+-`, `Ctrl++`, `Ctrl+0`.
- Persist one device-local value and normalize it again at the preload trust boundary.
- Capsule: 180ms fade/move in, 1.4s idle visibility, 220ms fade out; pause while hovered or focused.
- Respect `prefers-reduced-motion: reduce` with immediate transitions.
- Reuse existing tokens and controls; add no dependency or settings service.

---

### Task 1: Display-scale state and pure behavior

**Files:**
- Create: `src/lib/settings/display-scale.ts`
- Create: `src/lib/settings/display-scale.check.ts`

**Interfaces:**
- Produces: `DISPLAY_SCALE_MIN`, `DISPLAY_SCALE_MAX`, `DISPLAY_SCALE_STEP`, `DISPLAY_SCALE_DEFAULT`, `displayScale`, `normalizeDisplayScale(value)`, `readStoredDisplayScale(storage?)`, `writeStoredDisplayScale(value, storage?)`, `applyDisplayScale(value, storage?)`, and `displayScaleShortcut(event)`.
- Consumes: `window.octopusBeak.display.setScale(percent)` after Task 2; optional access keeps web builds unchanged.

- [ ] **Step 1: Write the failing behavior check**

Create `src/lib/settings/display-scale.check.ts`:

```ts
import assert from "node:assert/strict";
import {
  DISPLAY_SCALE_DEFAULT,
  applyDisplayScale,
  displayScaleShortcut,
  displayScaleStorageKey,
  normalizeDisplayScale,
  readStoredDisplayScale,
} from "./display-scale.ts";

class MemoryStorage {
  #items = new Map<string, string>();
  getItem(key: string) { return this.#items.get(key) ?? null; }
  setItem(key: string, value: string) { this.#items.set(key, value); }
}

const storage = new MemoryStorage();
assert.equal(normalizeDisplayScale(undefined), DISPLAY_SCALE_DEFAULT);
assert.equal(normalizeDisplayScale("bad"), DISPLAY_SCALE_DEFAULT);
assert.equal(normalizeDisplayScale(72), 75);
assert.equal(normalizeDisplayScale(153), 150);
assert.equal(normalizeDisplayScale(103), 105);
assert.equal(readStoredDisplayScale(storage), 100);

storage.setItem(displayScaleStorageKey, "126");
assert.equal(readStoredDisplayScale(storage), 125);
assert.equal(applyDisplayScale(103, storage), 105);
assert.equal(storage.getItem(displayScaleStorageKey), "105");

const shortcut = (key: string, extra = {}) => displayScaleShortcut({
  key,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  defaultPrevented: false,
  ...extra,
});
assert.equal(shortcut("-"), "decrease");
assert.equal(shortcut("="), "increase");
assert.equal(shortcut("+"), "increase");
assert.equal(shortcut("0"), "reset");
assert.equal(shortcut("0", { altKey: true }), null);
assert.equal(shortcut("0", { defaultPrevented: true }), null);
assert.equal(shortcut("0", { metaKey: false }), null);
```

- [ ] **Step 2: Run the check to verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/settings/display-scale.check.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `display-scale.ts`.

- [ ] **Step 3: Implement the minimum shared state module**

Create `src/lib/settings/display-scale.ts`:

```ts
import { writable } from "svelte/store";

export const DISPLAY_SCALE_MIN = 75;
export const DISPLAY_SCALE_MAX = 150;
export const DISPLAY_SCALE_STEP = 5;
export const DISPLAY_SCALE_DEFAULT = 100;
export const displayScaleStorageKey = "octopusbeak-display-scale";

type DisplayScaleStorage = Pick<Storage, "getItem" | "setItem">;
type DisplayScaleKeyEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "defaultPrevented"
>;
export type DisplayScaleAction = "decrease" | "increase" | "reset";

export const displayScale = writable(DISPLAY_SCALE_DEFAULT);

export function normalizeDisplayScale(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DISPLAY_SCALE_DEFAULT;
  const stepped = Math.round(numeric / DISPLAY_SCALE_STEP) * DISPLAY_SCALE_STEP;
  return Math.min(DISPLAY_SCALE_MAX, Math.max(DISPLAY_SCALE_MIN, stepped));
}

export function readStoredDisplayScale(storage = browserStorage()) {
  const stored = storage?.getItem(displayScaleStorageKey);
  return stored == null ? DISPLAY_SCALE_DEFAULT : normalizeDisplayScale(stored);
}

export function writeStoredDisplayScale(value: number, storage = browserStorage()) {
  storage?.setItem(displayScaleStorageKey, String(normalizeDisplayScale(value)));
}

export function applyDisplayScale(value: unknown, storage = browserStorage()) {
  const normalized = normalizeDisplayScale(value);
  displayScale.set(normalized);
  writeStoredDisplayScale(normalized, storage);
  if (typeof window !== "undefined") window.octopusBeak?.display?.setScale(normalized);
  return normalized;
}

export function displayScaleShortcut(event: DisplayScaleKeyEvent): DisplayScaleAction | null {
  if (event.defaultPrevented || event.altKey || (!event.metaKey && !event.ctrlKey)) return null;
  if (event.key === "-") return "decrease";
  if (event.key === "+" || event.key === "=") return "increase";
  if (event.key === "0") return "reset";
  return null;
}

function browserStorage(): DisplayScaleStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
```

- [ ] **Step 4: Run the focused check**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/settings/display-scale.check.ts
```

Expected: PASS with exit code 0 and no output.

- [ ] **Step 5: Commit the behavior module**

```bash
git add src/lib/settings/display-scale.ts src/lib/settings/display-scale.check.ts
git commit -m "feat: add display scale state"
```

---

### Task 2: Electron zoom bridge

**Files:**
- Modify: `src/lib/desktop/api.ts`
- Modify: `src/lib/desktop/api.check.ts`
- Modify: `electron/preload.ts`

**Interfaces:**
- Consumes: percentages normalized by `applyDisplayScale(value)` from Task 1.
- Produces: `OctopusBeakApi.display.setScale(percent: number): void` in the renderer and a preload implementation that calls `webFrame.setZoomFactor(factor)`.

- [ ] **Step 1: Add a failing type contract**

Append to `src/lib/desktop/api.check.ts`:

```ts
import type { OctopusBeakApi } from "./api.ts";

const displayApi: OctopusBeakApi["display"] = {
  setScale(percent) {
    assert.equal(percent, 100);
  },
};
displayApi.setScale(100);
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run:

```bash
npm run typecheck
```

Expected: FAIL with `Property 'display' does not exist on type 'OctopusBeakApi'`.

- [ ] **Step 3: Add the typed bridge and trust-boundary validation**

Add to `OctopusBeakApi` in `src/lib/desktop/api.ts`:

```ts
display: {
  setScale(percent: number): void;
};
```

Change the Electron import and add the matching API member in `electron/preload.ts`:

```ts
import { contextBridge, ipcRenderer, webFrame } from "electron";

const api: OctopusBeakApi = {
  display: {
    setScale(percent) {
      if (!Number.isFinite(percent)) throw new TypeError("Display scale must be finite.");
      webFrame.setZoomFactor(Math.min(1.5, Math.max(0.75, percent / 100)));
    },
  },
  // keep the existing overview/assets/liabilities/spending/automation members
};
```

Do not add an IPC channel; `webFrame` is the native renderer zoom API and the preload bridge is already the renderer trust boundary.

- [ ] **Step 4: Run the contract, type, and Electron builds**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/desktop/api.check.ts
npm run typecheck
npm run build:electron
```

Expected: all three commands exit 0; the Electron build emits `build-electron/preload.cjs` and `build-electron/main.cjs`.

- [ ] **Step 5: Commit the bridge**

```bash
git add src/lib/desktop/api.ts src/lib/desktop/api.check.ts electron/preload.ts
git commit -m "feat: expose Electron display scaling"
```

---

### Task 3: Global shortcuts and option-1 capsule

**Files:**
- Modify: `src/lib/shared-shell/components/DashboardShell.svelte`

**Interfaces:**
- Consumes: Task 1 store/constants/functions and Task 2 `window.octopusBeak.display`.
- Produces: keyboard handling on every route and the transient top-right capsule with pause/resume behavior.

- [ ] **Step 1: Add shell lifecycle, shortcut, and timer logic**

In the script of `DashboardShell.svelte`, add these imports and state/functions while preserving existing sidebar/value-visibility behavior:

```ts
import { onMount } from "svelte";
import { fade, fly } from "svelte/transition";
import {
  DISPLAY_SCALE_DEFAULT,
  DISPLAY_SCALE_MAX,
  DISPLAY_SCALE_MIN,
  DISPLAY_SCALE_STEP,
  applyDisplayScale,
  displayScale,
  displayScaleShortcut,
  readStoredDisplayScale,
} from "$lib/settings/display-scale.ts";

let scaleHudVisible = false;
let scaleHudHovered = false;
let scaleHudFocusWithin = false;
let scaleHudTimer: ReturnType<typeof setTimeout> | null = null;
let reduceMotion = false;

onMount(() => {
  if (!window.octopusBeak?.display) return;
  reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  applyDisplayScale(readStoredDisplayScale());
  return clearScaleHudTimer;
});

function clearScaleHudTimer() {
  if (scaleHudTimer) clearTimeout(scaleHudTimer);
  scaleHudTimer = null;
}

function scheduleScaleHudDismissal() {
  clearScaleHudTimer();
  if (scaleHudHovered || scaleHudFocusWithin) return;
  scaleHudTimer = setTimeout(() => { scaleHudVisible = false; }, 1400);
}

function revealScaleHud() {
  scaleHudVisible = true;
  scheduleScaleHudDismissal();
}

function changeDisplayScale(next: number) {
  applyDisplayScale(next);
  revealScaleHud();
}

function enterScaleHud() {
  scaleHudHovered = true;
  clearScaleHudTimer();
}

function leaveScaleHud() {
  scaleHudHovered = false;
  scheduleScaleHudDismissal();
}

function focusScaleHud() {
  scaleHudFocusWithin = true;
  clearScaleHudTimer();
}

function handleScaleHudFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null;
  if (next && (event.currentTarget as HTMLElement).contains(next)) return;
  scaleHudFocusWithin = false;
  scheduleScaleHudDismissal();
}

function handleDisplayScaleKeydown(event: KeyboardEvent) {
  if (!window.octopusBeak?.display) return;
  const action = displayScaleShortcut(event);
  if (!action) return;
  event.preventDefault();
  if (action === "decrease") changeDisplayScale($displayScale - DISPLAY_SCALE_STEP);
  if (action === "increase") changeDisplayScale($displayScale + DISPLAY_SCALE_STEP);
  if (action === "reset") changeDisplayScale(DISPLAY_SCALE_DEFAULT);
}
```

- [ ] **Step 2: Add the window listener and accessible capsule markup**

Place the listener after `</script>` and the capsule inside `<main class="page">`, after the topbar and before the page slot:

```svelte
<svelte:window onkeydown={handleDisplayScaleKeydown} />

{#if scaleHudVisible}
  <div
    class="display-scale-hud"
    role="group"
    aria-label={$t.settings.displaySize}
    onmouseenter={enterScaleHud}
    onmouseleave={leaveScaleHud}
    onfocusin={focusScaleHud}
    onfocusout={handleScaleHudFocusOut}
    in:fly={{ y: reduceMotion ? 0 : -6, duration: reduceMotion ? 0 : 180 }}
    out:fade={{ duration: reduceMotion ? 0 : 220 }}
  >
    <output aria-live="polite">{$displayScale}%</output>
    <button
      type="button"
      aria-label={$t.settings.decreaseScale}
      disabled={$displayScale <= DISPLAY_SCALE_MIN}
      onclick={() => changeDisplayScale($displayScale - DISPLAY_SCALE_STEP)}
    >−</button>
    <button
      type="button"
      aria-label={$t.settings.increaseScale}
      disabled={$displayScale >= DISPLAY_SCALE_MAX}
      onclick={() => changeDisplayScale($displayScale + DISPLAY_SCALE_STEP)}
    >+</button>
    <button
      type="button"
      disabled={$displayScale === DISPLAY_SCALE_DEFAULT}
      onclick={() => changeDisplayScale(DISPLAY_SCALE_DEFAULT)}
    >{$t.settings.resetScale}</button>
  </div>
{/if}
```

- [ ] **Step 3: Add selected option-1 styling**

Append to the component `<style>`:

```css
.display-scale-hud {
  position: fixed;
  top: calc(var(--titlebar-safe-top, 0px) + 24px);
  right: 24px;
  z-index: 30;
  min-height: 56px;
  display: inline-flex;
  align-items: stretch;
  overflow: hidden;
  border: 1px solid color-mix(in oklch, var(--border) 70%, transparent);
  border-radius: 999px;
  background: color-mix(in oklch, var(--surface) 92%, transparent);
  box-shadow: 0 16px 34px rgb(15 23 42 / 0.12);
  backdrop-filter: blur(18px) saturate(1.08);
}

.display-scale-hud :is(output, button) {
  min-width: 52px;
  display: grid;
  place-items: center;
  padding: 0 16px;
  border: 0;
  border-left: 1px solid var(--border);
  background: transparent;
  color: var(--fg);
}

.display-scale-hud output {
  min-width: 92px;
  border-left: 0;
  font-size: 20px;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
}

.display-scale-hud button {
  min-height: 56px;
  font-size: 20px;
}

.display-scale-hud button:last-child {
  min-width: 78px;
  font-size: 13px;
  font-weight: 680;
}

.display-scale-hud button:hover:not(:disabled) { background: var(--surface-soft); }
```

- [ ] **Step 4: Run static verification**

Run:

```bash
npm run typecheck
npm run build:renderer
```

Expected: both commands exit 0 with no Svelte accessibility warnings for the capsule.

- [ ] **Step 5: Commit the global control**

```bash
git add src/lib/shared-shell/components/DashboardShell.svelte src/lib/settings/display-scale.check.ts
git commit -m "feat: add display scale shortcuts"
```

---

### Task 4: Settings card, localization, and live Electron verification

**Files:**
- Modify: `src/lib/settings/SettingsPage.svelte`
- Modify: `src/lib/i18n/i18n.ts`
- Modify: `src/lib/i18n/i18n.check.ts`

**Interfaces:**
- Consumes: Task 1 display store/constants/update function.
- Produces: Electron-only option-1 Settings card and complete English/Traditional Chinese labels.

- [ ] **Step 1: Add a failing translation contract**

Extend the existing settings assertions in `src/lib/i18n/i18n.check.ts`:

```ts
assert.equal(translations.en.settings.displaySize, "Display size");
assert.equal(translations["zh-TW"].settings.displaySize, "顯示大小");
assert.equal(translations.en.settings.scaleRange(75, 150), "Minimum 75% · Maximum 150%");
assert.equal(translations["zh-TW"].settings.scaleRange(75, 150), "最小 75% · 最大 150%");
```

- [ ] **Step 2: Run the translation check to verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts
```

Expected: FAIL because `settings.displaySize` and `settings.scaleRange` do not exist.

- [ ] **Step 3: Add matching English and Traditional Chinese copy**

Add these fields to both `settings` dictionaries in `src/lib/i18n/i18n.ts`:

```ts
// English
displaySize: "Display size",
displaySizeDescription: "Adjust the overall size of the Electron app.",
displayScaleAria: "Display scale",
scaleRange: (min: number, max: number) => `Minimum ${min}% · Maximum ${max}%`,
keyboardShortcuts: "Keyboard shortcuts",
decreaseScale: "Decrease display size",
increaseScale: "Increase display size",
resetScale: "Reset",

// Traditional Chinese
displaySize: "顯示大小",
displaySizeDescription: "調整 Electron app 的整體顯示大小。",
displayScaleAria: "顯示比例",
scaleRange: (min, max) => `最小 ${min}% · 最大 ${max}%`,
keyboardShortcuts: "鍵盤快速鍵",
decreaseScale: "縮小顯示",
increaseScale: "放大顯示",
resetScale: "重設",
```

- [ ] **Step 4: Add Electron detection and scale bindings to Settings**

In `SettingsPage.svelte`, add:

```ts
import { onMount } from "svelte";
import {
  DISPLAY_SCALE_DEFAULT,
  DISPLAY_SCALE_MAX,
  DISPLAY_SCALE_MIN,
  DISPLAY_SCALE_STEP,
  applyDisplayScale,
  displayScale,
} from "$lib/settings/display-scale.ts";

let displayScaleAvailable = false;
let shortcutModifier = "Ctrl";

onMount(() => {
  displayScaleAvailable = Boolean(window.octopusBeak?.display);
  shortcutModifier = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl";
});
```

Below the existing language card, render only when `displayScaleAvailable`:

```svelte
{#if displayScaleAvailable}
  <section class="card display-scale-card">
    <div class="panel-title">
      <div>
        <h2>{$t.settings.displaySize}</h2>
        <p class="lead">{$t.settings.displaySizeDescription}</p>
      </div>
    </div>
    <div class="display-scale-body">
      <output class="display-scale-value">{$displayScale}%</output>
      <div class="display-scale-slider">
        <input
          type="range"
          min={DISPLAY_SCALE_MIN}
          max={DISPLAY_SCALE_MAX}
          step={DISPLAY_SCALE_STEP}
          value={$displayScale}
          aria-label={$t.settings.displayScaleAria}
          oninput={(event) => applyDisplayScale((event.currentTarget as HTMLInputElement).valueAsNumber)}
        />
        <div class="display-scale-labels">
          <span>{DISPLAY_SCALE_MIN}%</span>
          <span>{DISPLAY_SCALE_DEFAULT}%</span>
          <span>{DISPLAY_SCALE_MAX}%</span>
        </div>
      </div>
      <button
        class="button"
        type="button"
        disabled={$displayScale === DISPLAY_SCALE_DEFAULT}
        onclick={() => applyDisplayScale(DISPLAY_SCALE_DEFAULT)}
      >{$t.settings.resetScale}</button>
      <div class="display-scale-shortcuts">
        <strong>{$t.settings.keyboardShortcuts}</strong>
        <span><kbd>{shortcutModifier} −</kbd>{$t.settings.decreaseScale}</span>
        <span><kbd>{shortcutModifier} +</kbd>{$t.settings.increaseScale}</span>
        <span><kbd>{shortcutModifier} 0</kbd>{$t.settings.resetScale}</span>
      </div>
      <p class="display-scale-range">
        {$t.settings.scaleRange(DISPLAY_SCALE_MIN, DISPLAY_SCALE_MAX)}
      </p>
    </div>
  </section>
{/if}
```

- [ ] **Step 5: Style the card with existing tokens**

Append to the component style; keep the existing 880px content width:

```css
.settings-content { display: grid; gap: var(--space-6); }

.display-scale-body {
  display: grid;
  grid-template-columns: auto minmax(240px, 1fr) auto;
  align-items: center;
  gap: var(--space-5);
  padding: var(--space-5);
}

.display-scale-value {
  min-width: 92px;
  font-size: 32px;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
}

.display-scale-slider { display: grid; gap: var(--space-2); }
.display-scale-slider input { width: 100%; accent-color: var(--accent); }
.display-scale-labels { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; }

.display-scale-shortcuts {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}

.display-scale-shortcuts span { display: inline-flex; align-items: center; gap: var(--space-2); }
.display-scale-shortcuts kbd { padding: 5px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--fg); font: inherit; }
.display-scale-range { grid-column: 1 / -1; margin: 0; color: var(--muted); font-size: 12px; }

@media (max-width: 760px) {
  .display-scale-body { grid-template-columns: 1fr; }
  .display-scale-shortcuts { grid-column: auto; align-items: flex-start; flex-direction: column; }
  .display-scale-range { grid-column: auto; }
}
```

- [ ] **Step 6: Run all focused and static checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/settings/display-scale.check.ts
node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 7: Verify the live Electron app through CDP**

Run `npm run desktop:dev`, use the printed remote-debugging port, and inspect the app through CDP. If local policy blocks GUI startup, request explicit approval rather than claiming verification.

Verify:

- Settings shows the scale card only in Electron.
- Slider applies and persists 75%, 100%, and 150% after restart.
- `Command/Ctrl+-`, `Command/Ctrl++`, and `Command/Ctrl+0` work on every route.
- Bounds disable the matching capsule button.
- Capsule enters in 180ms, dismisses after 1.4s idle with a 220ms fade, and remains while hovered or focused.
- Focus is not removed during dismissal.
- Reduced-motion mode removes movement and transition duration.
- Capsule stays below a modal (`z-index: 40`) and above ordinary content.
- Settings and capsule visually match option 1 at the normal desktop window size.

- [ ] **Step 8: Commit the Settings UI**

```bash
git add src/lib/settings/SettingsPage.svelte src/lib/i18n/i18n.ts src/lib/i18n/i18n.check.ts
git commit -m "feat: add display scale settings"
```

---

### Task 5: Final regression pass

**Files:**
- No new files expected.

**Interfaces:**
- Consumes: all prior task deliverables.
- Produces: one verified, dependency-free Electron display-scale feature.

- [ ] **Step 1: Run the complete relevant command set**

```bash
node --no-warnings --experimental-strip-types src/lib/settings/display-scale.check.ts
node --no-warnings --experimental-strip-types src/lib/desktop/api.check.ts
node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0 and `git diff --check` prints nothing.

- [ ] **Step 2: Review the final diff for scope**

Confirm the diff contains only:

```text
electron/preload.ts
src/lib/desktop/api.ts
src/lib/desktop/api.check.ts
src/lib/settings/display-scale.ts
src/lib/settings/display-scale.check.ts
src/lib/settings/SettingsPage.svelte
src/lib/shared-shell/components/DashboardShell.svelte
src/lib/i18n/i18n.ts
src/lib/i18n/i18n.check.ts
```

Expected: no dependency, lockfile, unrelated refactor, custom shortcut editor, per-page scaling, or web-only UI changes.

- [ ] **Step 3: Commit any verification-only correction**

Only if Step 1 or CDP verification required a correction:

```bash
git add electron/preload.ts src/lib/desktop/api.ts src/lib/desktop/api.check.ts \
  src/lib/settings/display-scale.ts src/lib/settings/display-scale.check.ts \
  src/lib/settings/SettingsPage.svelte \
  src/lib/shared-shell/components/DashboardShell.svelte \
  src/lib/i18n/i18n.ts src/lib/i18n/i18n.check.ts
git commit -m "fix: finish display scale verification"
```

If no correction was required, skip this commit.
