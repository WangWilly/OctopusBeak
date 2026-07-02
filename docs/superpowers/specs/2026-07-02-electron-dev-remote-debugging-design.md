# Electron Dev Remote Debugging Design

Date: 2026-07-02

## Context

The app is now developed through Electron rather than plain Vite browser mode. `npm run desktop:dev` builds the static renderer, builds the Electron main/preload bundle, then runs `electron .`.

`package.json` still exposes `dev` and `dev:mock`, but those scripts start plain Vite without the Electron preload API. That path cannot run the desktop UI correctly.

## Decision

Make `npm run desktop:dev` expose Electron remote debugging on port `9222` in development mode and print the port to the main-process console.

Remove the unsupported plain Vite scripts:

- `dev`
- `dev:mock`

Update the mock seed helper output so it points developers to `npm run desktop:dev`.

## Design

In `electron/main.ts`, define a single development remote debugging port:

```ts
const devRemoteDebuggingPort = 9222;
```

Before `app.whenReady()`, enable the Electron switch only when the app is not packaged:

```ts
if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", String(devRemoteDebuggingPort));
  console.info(`Electron remote debugging listening on port ${devRemoteDebuggingPort}`);
}
```

This keeps packaged builds from exposing a debug port.

In `package.json`, delete `dev` and `dev:mock`. Keep `desktop:dev` unchanged.

In `src/ledger/seed-mock-ledger-db.ts`, replace the printed plain-Vite command with a desktop command:

```text
Run with: LEDGER_DIR=<mock-ledger-dir> npm run desktop:dev
```

## Non-Goals

- Do not add a configurable port until there is a real need.
- Do not reintroduce browser-only dev mode.
- Do not change the desktop build pipeline.
- Do not expose remote debugging in packaged apps.

## Verification

- `npm run typecheck`
- `npm run build:electron`
- `node --no-warnings --experimental-strip-types src/ledger/seed-mock-ledger-db.ts /tmp/octopusbeak-dev-seed-smoke`

Manual smoke check:

- Run `npm run desktop:dev`
- Confirm console prints `Electron remote debugging listening on port 9222`
- Confirm the Electron app opens
