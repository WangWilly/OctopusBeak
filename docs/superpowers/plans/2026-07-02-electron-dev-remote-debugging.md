# Electron Dev Remote Debugging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run desktop:dev` expose Electron remote debugging on port `9222`, print that port, and remove unsupported plain Vite dev scripts.

**Architecture:** Use Electron's built-in `app.commandLine.appendSwitch()` before `app.whenReady()` and guard it with `!app.isPackaged`. Keep script cleanup in `package.json` and update the existing seed helper message so developers are not pointed at removed commands.

**Tech Stack:** Electron 43, SvelteKit static renderer, TypeScript, npm scripts, Node strip-types checks.

---

## Scope

Implement `docs/superpowers/specs/2026-07-02-electron-dev-remote-debugging-design.md`.

Do not change the desktop build pipeline.

Do not add a configurable port.

Do not reintroduce `npm run dev` or `npm run dev:mock`.

Do not edit historical completed plan/spec documents that mention old commands.

## File Structure

- Modify: `electron/main.ts`
  - Add the development-only remote debugging switch and `console.info()` output.
- Modify: `package.json`
  - Remove `dev` and `dev:mock`.
- Modify: `src/ledger/seed-mock-ledger-db.ts`
  - Update the printed command to `npm run desktop:dev`.

---

### Task 1: Enable Electron Dev Remote Debugging

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: Inspect the current Electron startup**

Run:

```bash
sed -n '1,150p' electron/main.ts
```

Expected: file imports `app` from `electron`, sets app name/path, then calls `app.whenReady().then(start).catch(showStartupError);` near the bottom.

- [ ] **Step 2: Add the dev-only remote debugging switch**

In `electron/main.ts`, add this block after the `runtime` destructuring and before `app.setName("OctopusBeak");`:

```ts
const devRemoteDebuggingPort = 9222;

if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", String(devRemoteDebuggingPort));
  console.info(`Electron remote debugging listening on port ${devRemoteDebuggingPort}`);
}
```

This must run before `app.whenReady()` so Chromium receives the switch during Electron startup.

- [ ] **Step 3: Verify Electron build**

Run:

```bash
npm run build:electron
```

Expected: command exits `0` and produces `build-electron/main.cjs` without TypeScript or Vite errors.

- [ ] **Step 4: Verify typecheck**

Run:

```bash
npm run typecheck
```

Expected: command exits `0` and `svelte-check found 0 errors and 0 warnings`.

- [ ] **Step 5: Commit the Electron main change**

Run:

```bash
git add electron/main.ts
git commit -m "feat: enable electron dev remote debugging"
```

Expected: commit succeeds and includes only `electron/main.ts`.

---

### Task 2: Remove Plain Vite Dev Scripts

**Files:**
- Modify: `package.json`
- Modify: `src/ledger/seed-mock-ledger-db.ts`

- [ ] **Step 1: Remove unsupported scripts from `package.json`**

In `package.json`, remove these two script entries:

```json
"dev": "vite dev",
"dev:mock": "LEDGER_DIR=data/mock-ledger vite dev",
```

After removal, the `scripts` block should start like this:

```json
"scripts": {
  "postinstall": "node scripts/patch-libretto-run-cdp.mjs",
  "build": "npm run build:renderer && npm run build:electron",
  "build:renderer": "vite build",
  "build:electron": "vite build --config electron.vite.config.ts",
  "preview": "vite preview",
  "typecheck": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json && tsc --noEmit",
  "desktop:dev": "npm run build && electron .",
```

- [ ] **Step 2: Update the seed helper output**

In `src/ledger/seed-mock-ledger-db.ts`, replace the existing final `console.log(...)` that mentions `npm run dev` / `npm run dev:mock` with:

```ts
  console.log(`Run with: LEDGER_DIR=${ledgerDir} npm run desktop:dev`);
```

- [ ] **Step 3: Verify removed command references in active files**

Run:

```bash
rg -n "npm run dev|dev:mock|vite dev|LEDGER_DIR=data/mock-ledger" package.json src README.md electron --glob '!node_modules/**'
```

Expected: no output.

- [ ] **Step 4: Verify seed helper smoke command**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/seed-mock-ledger-db.ts /tmp/octopusbeak-dev-seed-smoke
```

Expected: command exits `0` and output includes:

```text
Run with: LEDGER_DIR=/tmp/octopusbeak-dev-seed-smoke npm run desktop:dev
```

- [ ] **Step 5: Verify typecheck**

Run:

```bash
npm run typecheck
```

Expected: command exits `0` and `svelte-check found 0 errors and 0 warnings`.

- [ ] **Step 6: Commit script cleanup**

Run:

```bash
git add package.json src/ledger/seed-mock-ledger-db.ts
git commit -m "chore: remove plain vite dev scripts"
```

Expected: commit succeeds and includes only `package.json` and `src/ledger/seed-mock-ledger-db.ts`.

---

## Self-Review

Spec coverage:

- Development-only remote debugging port: Task 1.
- Console output with port number: Task 1.
- No packaged-app debug port: Task 1 uses `!app.isPackaged`.
- Remove `dev` / `dev:mock`: Task 2.
- Update mock seed helper: Task 2.

Placeholder scan:

- No placeholders remain.
- Each command has expected output or exit status.
- Each edit step includes the exact code to add, remove, or replace.

Type consistency:

- `devRemoteDebuggingPort` is a number and is converted with `String(...)` for `appendSwitch`.
- `ledgerDir` already exists in `seed-mock-ledger-db.ts` and is reused in the new message.

## Execution Choice

Plan complete and saved to `docs/superpowers/plans/2026-07-02-electron-dev-remote-debugging.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
