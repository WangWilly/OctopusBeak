---
name: electron-cdp-debugging
description: Use when discussing, debugging, visually comparing, or verifying this project's Electron desktop app, especially with npm run desktop:dev, Chrome DevTools Protocol, CDP, remote debugging port 9222, uploaded screenshots, or desktop UI changes.
---

# Electron CDP Debugging

## Overview

Use the development Electron app as the source of truth. Start it when needed, inspect it through CDP, compare against the user's uploaded screenshot before editing, and verify the final UI through CDP interaction.

## Workflow

1. Check whether the development Electron app is already running and exposing CDP on `127.0.0.1:9222`.
2. If it is not running, start it with `npm run desktop:dev` and keep the process alive while working.
3. Read the console logs for the remote debugging line, for example:

```text
Electron remote debugging listening on port 9222
DevTools listening on ws://127.0.0.1:9222/devtools/browser/...
```

4. Connect to the CDP endpoint at `http://127.0.0.1:9222`.
5. Use the live CDP page state, screenshots, accessibility tree, DOM, console errors, and network state to identify the real target screen.
6. If the user uploaded a screenshot, compare it with the current Electron window before changing code. Confirm the target route, panel, dialog, or component from the live app rather than guessing from file names.
7. Discuss blockers or ambiguous product questions using what CDP shows: current screen, visible text, element states, console output, and reproduction steps.
8. For final validation, interact with the Electron app through CDP and confirm the changed behavior or visual result in the live window.

## Commands

Start the app when no dev instance is available:

```bash
npm run desktop:dev
```

Check the CDP endpoint:

```bash
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list
```

Connect with any available CDP-capable browser tool. If Libretto is being used, connect like this:

```bash
npx libretto connect http://127.0.0.1:9222 --session electron-cdp
npx libretto snapshot --session electron-cdp
```

## Rules

- Do not claim the Electron app was verified unless CDP inspection or interaction confirmed it.
- Do not rely only on static code inspection when the request concerns visible desktop behavior.
- Preserve a running `npm run desktop:dev` session until debugging or verification is complete.
- Use the port printed in logs if it differs from `9222`.
- Treat an uploaded screenshot as the target visual reference and the CDP app state as the runnable truth.

## Common Mistakes

| Mistake | Correction |
| --- | --- |
| Editing from component names only | First identify the live route and element through CDP |
| Assuming port `9222` without checking logs | Read the `desktop:dev` output and use the actual port |
| Verifying with tests only | Also verify visible desktop behavior through CDP |
| Discussing vague UI state | Cite the current CDP-observed screen, text, and console state |
