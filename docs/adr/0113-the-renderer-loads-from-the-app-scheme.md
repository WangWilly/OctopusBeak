# The renderer loads from the app scheme

Status: accepted

Follows Electron's security checklist item "use a custom protocol instead of file://". Keeps the IPC sender check of the renderer document and the renderer CSP; both now name `app://octopusbeak/index.html`.

## Context

The renderer loaded from `file://…/build/index.html`. Every `file:` URL shares one origin, so any local HTML file the App was made to open would share the renderer's storage and pass an origin-only sender check. Electron's `GrantFileProtocolExtraPrivileges` fuse also had to stay on for the renderer to work.

The renderer keeps the person's preferences in `localStorage`: language, Welcome and onboarding progress, display scale, the collapsed sidebar and value visibility. Storage belongs to an origin, so a new origin starts empty.

## Decision

**The renderer is served at `app://octopusbeak/`.** `electron/app-protocol.ts` registers the `app` scheme as standard and secure before `ready` and serves files from `build/` only. It refuses another host, a path that leaves `build/`, a NUL byte and malformed escapes.

**Preferences move once, inside the main window, before the renderer loads.** `electron/renderer-storage-migration.ts` loads a blank `file:` page and reads its `localStorage`. It then loads a blank page the protocol serves at `app://octopusbeak/__storage-migration.html` and writes each key the app origin does not hold yet. A marker file in `userData` records success, and a failure leaves no marker, so the next launch tries again. The window always ends on the app origin before it loads the renderer, even with nothing to copy. A cross-origin jump straight from the `file:` page to the renderer left CDP clients attached to a stale frame.

**`GrantFileProtocolExtraPrivileges` stays on for now.** With that fuse off, a `file:` page cannot use `localStorage`, so the migration could not read anything. It can be turned off in a later release, once installed Apps have run the migration. An App that skips every release in between would start with default preferences.

## Considered options

- **A separate hidden window for the migration.** Rejected. Closing it before the main window exists emits `window-all-closed`, which quits the App off macOS, and CDP clients could attach to the wrong page.
- **Parse Chromium's `Local Storage` LevelDB in main.** Rejected. It depends on an undocumented on-disk format.
- **Turn the fuse off in the same release.** Rejected. Every installed App would lose its preferences.
