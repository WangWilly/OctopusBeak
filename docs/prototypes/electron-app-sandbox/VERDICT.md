# Packaged Electron / helper boundary verdict

Resolved with the human driving
[以封裝版 Electron／App Sandbox probe 決定 helper 執行邊界](https://github.com/WangWilly/OctopusBeak/issues/66)
on 2026-08-01.

## Observed evidence

The repeatable command was:

```sh
npm run prototype:electron-app-sandbox
```

Observed cell:

- macOS 26.2, Apple Silicon arm64, 16 GiB;
- Electron 43.0.0 standard `darwin-arm64` distribution;
- Developer ID Application signing with one Team ID across the app and nested
  Electron code;
- Hardened Runtime enabled, with timestamp disabled only for the local probe;
- recursive strict signature verification passed;
- two launches of the packaged executable passed.

Both packaged launches showed:

- `app.isPackaged === true`;
- a renderer with no `require` or `process` and only one exposed `run` method;
- a sender-validated `probe:v1:run` IPC request;
- a real Swift helper reading the bundled model sentinel;
- a helper-owned `127.0.0.1` round trip returning `pong`;
- explicit termination producing `SIGTERM`;
- injected helper failure producing exit code `42`.

The second launch recovered the checkpoint written by the first launch.

The initial ad-hoc and naive `codesign --deep` attempts failed at runtime with
Team ID mismatches in nested Electron code. Recursive verification alone was
not sufficient. The passing cell used Electron-aware nested signing.

## Decision

First release:

1. Supports Developer ID direct distribution only. Mac App Store and macOS App
   Sandbox are unsupported.
2. Electron main directly owns an embedded Swift/model-runtime child process.
   No XPC or `launchd` service is introduced.
3. Trusted executable code lives in the signed app bundle. Installed model
   artifacts, checkpoints, and mutable runtime state live only in App-managed
   Application Support/cache locations.
4. A built-in helper may use a main-only, authenticated, ephemeral loopback
   endpoint bound only to `127.0.0.1`/`::1`. The renderer never receives its
   endpoint or session token, and the helper has no tool-execution authority.
5. Release qualification is a hard gate: consistent Developer ID signing,
   Hardened Runtime, secure timestamp, strict recursive signature validation,
   accepted and stapled notarization, Gatekeeper assessment, and a rerun from
   the actual release artifact on a clean target Apple Silicon Mac.

## Not proven by this prototype

- Mac App Store or macOS App Sandbox behavior. Electron documents that the
  standard `darwin` build is ineligible; a separate `mas-arm64` build and
  inherited sandbox entitlements would be required.
- Apple notarization, stapling, Gatekeeper acceptance, or clean-target-Mac
  launch. The local probe process had no configured notary profile.
- Real model inference performance or model quality.

Those missing release facts are a separate prerequisite task, not exceptions
to the hard gate.
