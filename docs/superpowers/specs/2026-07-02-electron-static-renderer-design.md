# Electron Static Renderer Design

## Goal

Remove the SvelteKit SSR/server runtime from the desktop app. The renderer becomes a static Electron-only UI, and all ledger, automation, settings, credentials, and human-assist operations move behind a typed preload API backed by the Electron main process.

## Scope

In scope:

- Replace `@sveltejs/adapter-node` server output with a static renderer build.
- Remove SvelteKit server routes: `+page.server.ts` and `+server.ts`.
- Replace clean browser routes with hash routes: `#/overview`, `#/assets`, `#/liabilities`, `#/automation`.
- Add an Electron preload bridge exposed as `window.octopusBeak`.
- Move dashboard data loading, automation actions, and automation viewer operations to Electron main IPC handlers.
- Keep automation polling in the renderer with a simple 2 second reload loop.
- Keep current JSON settings and credentials files as the storage layer.

Out of scope:

- General browser support for `npm run dev`.
- HTTP API compatibility for old SvelteKit endpoints.
- `safeStorage` encryption for `credentials.json`.
- UI redesign or migration to shadcn-svelte/TanStack/LayerChart.

## Architecture

The desktop app has three layers:

- Electron main process: owns filesystem access, SQLite, automation runner state, Libretto control, settings, credentials, and app lifecycle.
- Preload script: exposes a small typed API to the renderer through `contextBridge`.
- Static Svelte renderer: owns presentation, hash routing, polling, forms, and user interaction.

The renderer never imports server modules. It only imports shared types and calls `window.octopusBeak`.

## Routing

Use one static renderer entry and hash-based navigation:

- `#/overview`
- `#/assets`
- `#/liabilities`
- `#/automation`

The previous `/` and `/dashboard` redirects become renderer-side hash normalization. On startup, an empty hash or unknown hash should route to `#/overview`.

This avoids Electron `file://` deep-link handling and keeps the implementation small.

## Preload API

Expose this minimal shape:

```ts
type OctopusBeakApi = {
  overview: {
    load(): Promise<OverviewPageModel>;
  };
  assets: {
    load(): Promise<AssetsPageModel>;
  };
  liabilities: {
    load(): Promise<LiabilitiesPageModel>;
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
```

`AutomationDesktopModel` contains the current `AutomationPageModel` plus credential groups:

```ts
type AutomationDesktopModel = {
  automation: AutomationPageModel;
  credentialGroups: CredentialGroup[];
};
```

## Main Process IPC

Main process handlers are thin wrappers around existing server-side modules:

- overview load calls `loadOverview()`
- assets load calls `loadAssets()`
- liabilities load calls `loadLiabilities()`
- automation load uses the current automation page model logic
- automation save splits updates into settings and credentials
- automation run/resume validates task state before starting runner work
- viewer screenshot/input/force-quit reuse existing human-session and automation-viewer helpers

The validation currently embedded in `src/routes/automation/+page.server.ts` should move to a small reusable main-side automation API module before the route file is deleted.

## Renderer Changes

Each dashboard page becomes a client-loaded component:

- show a compact loading state while the preload call is pending
- show the existing dashboard component after data loads
- show a simple error state if IPC rejects

Automation replaces SvelteKit forms and `fetch()` calls:

- Save credentials calls `window.octopusBeak.automation.saveCredentials(updates)`.
- Run/resume buttons call `run(taskId)` or `resume(taskId)`.
- Polling calls `automation.load()` every 2 seconds while a task is active.
- Human viewer screenshot uses `viewerScreenshot(taskId)` and creates a blob URL in the renderer.
- Viewer input and force quit call preload API methods.

## Build And Runtime

Use a static SvelteKit build for the renderer. The Electron main process should stop importing `build/handler.js` and stop starting a local HTTP server.

Runtime startup becomes:

1. `ensureDataRoot(userData)`
2. `Object.assign(process.env, buildDesktopEnv(...))`
3. `process.chdir(userData)`
4. create a `BrowserWindow` with `preload`
5. load the static renderer entry

`desktop:dev` remains the primary development path. Plain browser dev is not supported for this feature.

## Error Handling

IPC handlers return typed success objects or throw `Error` with the same user-facing messages currently returned by SvelteKit route failures.

Renderer components keep errors local:

- dashboard load errors show a reload action
- automation action errors show the message near the task or viewer
- screenshot errors show the existing viewer error text

Do not leak credential values in errors, logs, or renderer state.

## Testing

Small checks are enough:

- preload API shape check: verifies all expected bridge keys exist.
- main automation API check: covers missing credential, disabled task, locked import, and save split behavior without starting real workflows.
- runtime check: verifies Electron no longer starts a local HTTP server and loads a static entry with preload configured.
- renderer routing check: verifies empty hash redirects to `#/overview` and known hashes select the right view.
- existing server checks stay green while modules are moved, then server route checks are removed with the routes.

Manual smoke test:

```bash
npm run desktop:dev
```

Then verify:

- overview/assets/liabilities render from local ledger data
- automation credentials modal saves settings and credentials
- a simple Libretto workflow starts from automation
- human-assist screenshot/input path still works

## Migration Notes

Keep the current `settings.json` and `credentials.json` contract unchanged. Moving access into Electron main creates the right boundary for `safeStorage`, but encryption remains a separate follow-up.

Delete SSR only after equivalent preload IPC paths exist for every current server route. The final implementation should leave no `src/routes/**/*.server.ts` or `src/routes/**/+server.ts` files.
