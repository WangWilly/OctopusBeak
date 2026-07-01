# Electron Packaged App Design

Date: 2026-07-01

## Goal

Package OctopusBeak as an installable Electron desktop app for non-developer users, starting with macOS. Windows support should remain possible, but it is out of scope for the first distributable if it materially slows down the macOS release.

The first version keeps the existing SvelteKit dashboard, automation panel, SQLite ledger, and Libretto workflows. It should change the launch and packaging layer, not rewrite the product.

## Non-Goals

- No Tauri implementation.
- No dashboard redesign.
- No rewrite of Libretto workflows.
- No auto-update in the first version.
- No Windows installer in the first version.
- No migration UI for existing developer-local data.
- No Keychain or Windows Credential Manager integration in the first version.

## Recommended Approach

Use Electron Forge to package the current SvelteKit `adapter-node` app.

Electron is the smaller change because the app already depends on a Node server runtime:

- SvelteKit server routes and form actions run in Node.
- Automation tasks spawn Libretto workflows.
- Ledger reads and writes use local SQLite files.
- Credentials and settings are currently stored through local `.env` text.

Tauri remains technically possible with a Node sidecar, but that adds Rust shell code, sidecar permissions, and static frontend constraints while still requiring Node for the existing server behavior.

## Architecture

```text
Electron main process
  -> create per-user app data directory
  -> set process cwd and environment for packaged runtime
  -> start local SvelteKit production server
  -> open BrowserWindow to http://127.0.0.1:<port>/overview
  -> stop server and owned child processes on app quit

SvelteKit server
  -> serves existing routes and form actions
  -> reads and writes ledger, credentials, logs, downloads
  -> starts Libretto automation tasks

Libretto workflows
  -> run from bundled project files
  -> write outputs under app data downloads directory
  -> use bundled or first-launch-installed Playwright browser binaries
```

## Components

### Electron Main

Add a small Electron entrypoint under `electron/`.

Responsibilities:

- Resolve `app.getPath("userData")`.
- Ensure `.env`, `.libretto/`, `downloads/`, `data/ledger/`, and `data/automation/logs/` exist under user data.
- Start the built SvelteKit server on `127.0.0.1` with a free local port.
- Set `HOST`, `PORT`, `ORIGIN`, `NODE_ENV`, `LEDGER_DIR`, and any packaged runtime paths.
- Create a `BrowserWindow` with node integration disabled.
- Clean up owned child processes on app shutdown.

### SvelteKit Server

Keep `@sveltejs/adapter-node`.

Use the generated `build/handler.js` with a tiny custom server instead of relying only on `node build`, because Electron needs to choose a local port and know when the server is ready.

### Runtime Data Directory

Use Electron `userData` as the write root:

```text
<userData>/
  .env
  .libretto/
  downloads/
  data/
    ledger/
      ledger.sqlite
    automation/
      logs/
```

The lazy first implementation can set `process.cwd()` to `userData` before starting server code, because many workflows currently write to `process.cwd()/downloads`. Later, if this becomes too implicit, replace those call sites with shared path helpers.

### Automation Runner

Current code starts tasks through `npm run <script>` or `npx libretto ...`. Packaged apps should not depend on a system npm install.

First packaged version should replace those calls with bundled executable paths:

- Run Libretto through its bundled CLI entrypoint.
- Run project workflow files from app resources.
- Keep stdout/stderr log handling unchanged.

This change should stay localized around the existing automation runner.

### Playwright Browser Runtime

For non-developer users, bundle the required browser runtime in the first macOS build. The app will be larger, but installation is simpler and support is lower.

If the packaged app becomes too large to distribute, switch this single component to a first-launch setup step that downloads browser binaries and reports clear progress and errors.

## Data Flow

1. User launches OctopusBeak.app.
2. Electron prepares the user data directory and starts the local server.
3. BrowserWindow opens `/overview`.
4. Dashboard routes read SQLite from `LEDGER_DIR`.
5. Automation actions invoke the existing server actions.
6. Runner starts bundled Libretto workflow process.
7. Workflow writes downloaded CSV/JSON files under `<userData>/downloads`.
8. Import task reads `<userData>/downloads` and writes `<userData>/data/ledger/ledger.sqlite`.
9. UI refreshes from the same local ledger.

## Error Handling

- If server startup fails, show a native error dialog and write a startup log under `<userData>/data/automation/logs/`.
- If the local port is unavailable, retry a small number of ports before failing.
- If Libretto or Playwright runtime is missing, surface a task failure in the existing automation log UI.
- If app data directory creation fails, stop startup and show the path in the error dialog.
- If an automation task is running when the app quits, terminate owned child processes and leave the task marked failed or interrupted through the existing run status path.

## Security And Privacy

- Keep the app local-only. Bind the SvelteKit server to `127.0.0.1`, never `0.0.0.0`.
- Disable Node integration in renderer windows.
- Do not expose Electron IPC APIs until there is a concrete need.
- Keep downloaded statements, credentials, logs, and SQLite under `userData`.
- Do not store credentials in macOS Keychain in the first version. The existing `.env` behavior remains, just moved under app data.
- For external distribution on macOS, plan for code signing and notarization before sending builds to non-technical users.

## Testing

Add the smallest checks that prove packaging did not break runtime behavior:

- Existing `npm run typecheck`.
- Existing Libretto patch check.
- Packaged smoke test: app starts, `/overview` loads, and `/automation` loads.
- Data path smoke test: app creates `.env`, `downloads`, `data/ledger`, and automation log directories under `userData`.
- Automation smoke test with mock or harmless task if available. Do not run real bank workflows in CI.

Manual release checklist:

- Build macOS distributable.
- Install on a clean macOS user account or VM.
- Launch app without local repo or global npm assumptions.
- Save credentials in automation panel.
- Generate or import mock ledger data.
- Verify `/overview`, `/assets`, `/liabilities`, and `/automation`.

## Implementation Plan Preview

The implementation should be split into small steps:

1. Add Electron Forge and Electron main entrypoint.
2. Add custom SvelteKit server bootstrap for Electron.
3. Move packaged runtime write root to Electron `userData`.
4. Localize automation runner command resolution.
5. Package Libretto and Playwright runtime assets.
6. Add smoke checks and release docs.

## Open Decisions

- Exact macOS signing/notarization identity and release channel.
- Whether existing developer-local data needs a manual migration guide.

## Acceptance Criteria

- A macOS user can install and launch OctopusBeak without cloning the repo.
- The app opens to the existing dashboard in an Electron window.
- Existing dashboard routes work against the app-local ledger path.
- Existing automation panel can read and save credentials in app-local `.env`.
- Existing task logs are written under app-local logs.
- The app does not require global `npm`, global `npx`, or a checked-out source tree.
- Windows remains a later packaging task, not a blocker for the first macOS distributable.
