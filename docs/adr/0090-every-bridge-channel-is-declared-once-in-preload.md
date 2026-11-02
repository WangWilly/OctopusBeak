# Every bridge channel is declared once in preload

Status: accepted

Extends [ADR 0073](0073-automation-ipc-forwards-to-one-desktop-service.md) from `automation:*` invoke channels to every channel kind. Follows the one-table rule of [ADR 0072](0072-host-calls-go-through-one-contract-table.md).

`INVOKE_CHANNELS` in `electron/preload.ts` typed every invoke channel, and `OctopusBeakInvokeHandlers` made a missing or mismatched handler a compile error. The other channels had no such check:

- **Push events were literals on both sides.** `data:invalidated`, `automation:runtime-changed`, `automation:notification-target-requested` and `appUpdates:changed` were each spelled once in a preload listener and once in a main-process loop over `BrowserWindow.getAllWindows()`. A misspelled channel or a changed payload still compiled, and the four loops repeated the same skip of destroyed windows.
- **The send and data-view channels drifted the same way.** `display:setScale` and `data-views:enabled` were literals in `ipc.ts`, and the other data-view channels were constants in `pglite-ipc.ts` that preload did not import.
- **Settings and Spending logic lived in `ipc.ts`.** The save rule that only a changed usage flag answers the usage statistics question, the boolean and data-version guards, and the candidate-page abort map were inline handlers. Only source regexes in `ipc.check.ts` covered them.

**Preload declares every channel.** Next to `INVOKE_CHANNELS`, `OctopusBeakPushEvents` maps each push channel to its payload, with `undefined` for `automation:notification-target-requested`. `OctopusBeakSendChannel` names `display:setScale`, and `OctopusBeakDataViewChannels` names the five `data-views:*` channels. The preload listeners take their payload types from `OctopusBeakPushEvents`.

**Main imports only types from preload.** The preload is sandboxed, so its bundle may require only `electron`; a value shared with main would pull in a chunk the sandbox cannot load. Main binds its own literals with `satisfies` against the preload types, so a mismatch fails `tsc` without any shared runtime module.

**One broadcast sends every push event.** `broadcast(channel, payload)` in `electron/broadcast.ts` sends to every window that is not destroyed. Its payload type comes from `OctopusBeakPushEvents`. The data-view rows and errors still go to their one subscribing sender.

**Settings and Spending IPC forward to their own desktop services.** `createSettingsDesktopService(deps)` owns the `settings:*` channels that Automation does not, plus `data:getVersion` and `data:acknowledgeVersion`. `createSpendingDesktopService(deps)` owns `spending:candidate-page`, `spending:candidate-page-cancel` and `spending:pairing-prewarm`. Both take their host singletons as ports and never import `electron`. `SETTINGS_SERVICE_CHANNELS` and `SPENDING_SERVICE_CHANNELS` in `electron/ipc-channels.ts` work like `AUTOMATION_SERVICE_CHANNELS`: a service method whose arguments or result differ from its bridge method fails to compile.

## Considered options

- **Move the channel declarations into a shared module that preload and main both import.** Rejected. The preload bundle would then require that module, which the sandbox cannot load.
- **Keep push events as literals and check them with a regex.** Rejected. A regex checks the spelling, but not the payload.
- **Add Settings and Spending to the Automation desktop service.** Rejected. ADR 0073 kept Automation as one service because its parts share the runtime readiness check and the credential cache. Settings and Spending use neither. A separate service for each does not reopen that decision.

## Consequences

- A new push, send or data-view channel starts in preload, and main fails to compile until it matches.
- `ipc.ts` keeps its own handlers only for `appUpdates:*`, `errorReports:*`, `display:setScale`, `data-views:enabled` and `automation:selectCertificateFile`.
- `settings-desktop-service.check.ts` now tests the settings save rule that `ipc.check.ts` pinned by regex. `spending-desktop-service.check.ts` tests the candidate-page rules, which had no check before.
