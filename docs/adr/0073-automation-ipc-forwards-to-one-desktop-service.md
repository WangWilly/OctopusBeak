# Automation IPC forwards to one desktop service

Status: accepted

`electron/ipc.ts` held the Automation logic behind every `automation:*` channel: the block read with its credential fallback and data-version guard, the device-registration validators, the certificate dialog, the setup-guide, prerequisite and structure-report links, runtime readiness and fatal reporting, and the runtime-changed broadcast. The handlers reached Electron (`dialog`, `shell`, `app`, `BrowserWindow`) and module singletons directly, so nothing but source regexes in `ipc.check.ts` could check them.

**Automation IPC handlers only forward to one desktop service.** `createAutomationDesktopService(deps)` in `src/lib/automation/server/automation-desktop-service.ts` has one method per `automation:*` bridge method, named the same, plus `clearSignInData`, `collectAllSources` and `close`. Electron main constructs it after the Automation runtime and passes it to `registerOctopusBeakIpc`.

- **Electron capabilities are injected ports.** The service asks for `chooseFile`, `openExternal`, `appVersion` and `publishRuntimeChanged`; Electron main supplies them. The service never imports `electron`, and the dialog owner is a type parameter the service only hands back.
- **Host singletons are ports too.** Device registration, the preview structure reports, the pending Sign-in Settings request, Sign-in Erasure and the credential reader arrive in `deps`, so a check can pass recording fakes. The service owns the credential state cache and runtime readiness and fatal reporting. Settings and credentials files stay implicit through the working directory.
- **A new Automation channel goes through `AUTOMATION_SERVICE_CHANNELS`.** The table in `electron/ipc-channels.ts` maps each forwarded channel to its bridge method's name. As with `RENDERER_FINANCIAL_OPERATIONS`, a channel whose service method's arguments or result differ from its bridge method fails to compile. Only `automation:selectCertificateFile` has its own handler, which turns the event into the dialog's owner window.
- **The model stays separate.** `automation-desktop-model.ts` (formerly `desktop-api.ts`) keeps what the runtime needs to build and admit runs; the IPC-only helpers moved to the service.

## Considered options

- **Keep the logic in `ipc.ts` and test it through a fake `ipcMain`.** Rejected. The handlers would still import Electron and the module singletons, so the fake would have to replace both.
- **One service per concern (registration, links, blocks).** Not adopted. They share the runtime readiness check and the credential cache, and the IPC table is the only caller.

## Consequences

- The behaviour that `ipc.check.ts` pinned by regex is now tested by `automation-desktop-service.check.ts`; `ipc.check.ts` keeps the wiring pins.
- Quit closes IPC, then the service (no more runtime broadcasts), then shuts the runtime down.
