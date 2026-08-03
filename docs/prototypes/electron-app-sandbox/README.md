# THROWAWAY PROTOTYPE — packaged Electron / App Sandbox helper probe

This prototype answers one question for
[以封裝版 Electron／App Sandbox probe 決定 helper 執行邊界](https://github.com/WangWilly/OctopusBeak/issues/66):

> Can a packaged Electron main process own a real Swift helper through a
> versioned renderer IPC boundary, and which parts of the proposed signing,
> Hardened Runtime, notarization, and App Sandbox support claim can this host
> actually prove?

It is not production Agent Runtime code. It creates a minimal Electron app in
`out/prototype-electron-app-sandbox`, compiles a tiny Swift helper, packages the
standard `darwin-arm64` Electron distribution, signs every nested binary with
the host's Developer ID identity and Hardened Runtime (timestamp disabled for
the local probe), and launches the packaged executable twice.

## Run

```sh
npm run prototype:electron-app-sandbox
```

The command prints the full evidence object and writes:

- `out/prototype-electron-app-sandbox/report.json`
- `out/prototype-electron-app-sandbox/report.md`

## What the direct-distribution cell exercises

- a hidden renderer with `sandbox: true`, `contextIsolation: true`, and
  `nodeIntegration: false`;
- a single versioned `probe:v1:run` renderer-to-main request;
- a real compiled Swift helper owned by Electron main;
- model-sentinel reads from the packaged app bundle;
- helper writes inside Electron `userData`;
- a helper-owned loopback listener;
- explicit termination and an injected exit-code `42` crash;
- a checkpoint observed after a second packaged-app launch;
- recursive signature verification and Hardened Runtime flags.

## Deliberate limits

Developer ID signing with timestamp disabled proves local package structure,
Team ID consistency, and runtime behavior. The resulting local probe is not a
release artifact and is not submitted to Apple's notary service.

The installed Electron artifact is the standard `darwin` build. Electron's
official Mac App Store guidance says only the `mas` build can run under macOS
App Sandbox. The sandbox preflight therefore reports missing prerequisites
instead of adding an entitlement to an ineligible binary and calling the
result an App Sandbox test.

The prototype does not download a model or benchmark inference. Its bundled
model file is only a path/readability sentinel.
