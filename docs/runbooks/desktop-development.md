# Desktop development lifecycle

Status: Current

From the repository root, run `npm run desktop:dev -- <Electron flags>`. This
builds the renderer and main process, then starts Electron under
`scripts/desktop-dev.mjs`. Arguments such as the recording background-rendering
flags are forwarded unchanged.

Stop the development app with **Ctrl+C in its launch terminal**, or quit the app
normally. The supervisor owns a separate process group for each launch. When
the main process exits, crashes, or the terminal sends SIGINT, SIGTERM, or SIGHUP,
it sends SIGTERM to that group, waits up to three seconds, and sends SIGKILL to
any remaining group members. It does not match process names or touch another
desktop instance.

The supervisor also checks the project directory, Electron runtime directory,
and main entrypoint once per second. Missing paths, filesystem queries that take
longer than 1.5 seconds, and changed device/inode identities stop that launch and
return exit code 1. Its code uses only Node built-ins after startup, so it can
still clean the Electron group if an external project volume disappears while
the host Node runtime remains available. Use a Node installation on the internal
disk when the project is on an external volume.

**Quit the app before ejecting or disconnecting its project disk.** The guard
limits leftover processes; it cannot preserve an app or database whose backing
volume is forcibly removed. Running the development checkout and dependencies
on the internal disk avoids that dependency. Killing the supervisor itself with
SIGKILL bypasses its cleanup; use the handled signals above. This guard covers
`desktop:dev`, including the CDP fixture and the documented recording commands;
direct `electron .` invocations and packaged releases do not use it.

The recording scripts attach to an existing app over CDP. Their
`browser.close()` disconnects Playwright; it does not quit the existing app.
After every recording, return to the launch terminal and press Ctrl+C before
re-seeding the demo profile or removing its disk.

Verify the lifecycle protection without opening an app or using a real ledger:

```bash
node --test scripts/desktop-process-supervisor.check.mjs
```

The checks use real isolated Node process groups, including workers that ignore
SIGTERM, and cover main-process exit/crash, interruption, missing/replaced
backing paths, failed launch, and interruption before launch. macOS and Linux
process groups are required for this development launcher.

## Usage statistics in development

A development build never sends usage statistics (ADR 0077); only packaged apps do. With
`OCTOPUSBEAK_USAGE_PING_URL=https://<worker host>/v1/ping` set before `npm run desktop:dev`, the
build carries the endpoint and asks the one-time question; without it, the app does not ask.

To see the one-time usage statistics dialog again, start with
`OCTOPUSBEAK_ASK_USAGE_STATISTICS=1 npm run desktop:dev`. The dialog then appears on every launch
until it is answered, even after an earlier answer and without the endpoint. Answering it still
writes the switch to `settings.json`. Packaged apps ignore this variable.

