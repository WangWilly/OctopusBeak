# Authentication secret host-only boundary audit

This audit answers whether the current desktop and local-runtime paths provide
enough evidence to call Authentication secrets host-only.

Run:

```sh
npm run audit:agent-secret-boundary
```

The command creates two random, non-production canary values in a temporary
directory, exercises exported production functions, emits observations without
printing either canary, and removes the temporary directory. A changed
observation fails the command so the evidence cannot silently drift.

## Verdict

**BLOCKED.** The current repository does not yet establish a production
host-only boundary.

The packaged desktop credential path has two useful controls: the Electron main
process installs a `safeStorage` codec before credential IPC is registered, and
the credential file is an encrypted envelope written with mode `0600`.
Renderer-facing desktop state projects credential presence as booleans and does
not return values.

The packaging, credential writer, automation worker, and future Agent-process
launch contracts now establish narrower capabilities. The remaining blockers in
this audit are the existing automation log and diagnostic redaction gaps, which
are outside issue #75:

| Surface | Current evidence | Result |
| --- | --- | --- |
| Electron main → encrypted credential file | Actual credential writer and codec path; canary absent from envelope; mode `0600` | Pass |
| Repository root → packaged App resources | Forge explicitly ignores `.env`, root `credentials.json`, and data directories; the qualification test stages a canary in denied files | Pass |
| Electron main → renderer | Actual status projection contains booleans only | Pass |
| Electron main → automation child env | `automationProcessEnv` strips every known credential from the inherited environment, then projects only the selected task's declared credential keys | Pass |
| Child stdout/stderr → log tail | `accumulateAutomationOutput` removes terminal controls only | **Blocker: canary survives** |
| Log tail → persisted failure | `finalFailureMessage` selects a raw log line | **Blocker: canary survives** |
| Cleanup error → diagnostic object | `automationCleanupFailureDetails` copies the raw Error message | **Blocker: canary survives** |
| Host → Agent helper/provider | The production launch-env builders inherit only explicitly allowlisted non-secret process plumbing; a child-process assertion injects canaries into helper and provider inputs | Pass (launch contract; adapter pending in parent issue) |
| Tool gateway → provider | Throwaway state machine rejects secret tools and projects `authority: "none"` | Provisional contract evidence only |
| Checkpoint/fallback → lineage/logs | Throwaway state machine excludes an injected canary | Provisional contract evidence only |
| Crash/telemetry export | No production Agent crash/telemetry schema or redaction gate exists | **Unproven** |

## Data-flow and capability inventory

1. Renderer credential form → preload IPC → Electron main: raw secret values
   cross versioned IPC into the trusted host process. The save response does not
   echo them.
2. Electron main → `safeStorage` envelope: Authentication secrets are encrypted
   at rest in the packaged desktop path. The no-codec writer can still produce
   plaintext and therefore must remain outside the released App contract.
3. Repository root → packaged App: Electron Forge explicitly excludes root
   `credentials.json`, `.env` variants, and data directories. The packaging
   qualification stages a canary in denied files and asserts it cannot reach
   simulated App resources.
4. Electron main → automation child: the child environment removes all known
   credentials before adding back only the selected task's declared keys.
5. Child stdout/stderr → filesystem log → SQLite `log_tail`/`record_json` →
   `error_message`: output is persisted without secret-aware redaction. A
   credential printed by a child can cross every one of these surfaces.
6. Agent helper/provider launch: production environment builders inherit a
   narrow non-secret allowlist, and the re-runnable process assertion verifies
   injected Authentication-secret canaries do not cross into either child.
   Tool results and checkpoint/fallback remain represented only by the
   throwaway state-machine shape.

## Required production contract

- Authentication secret values stay in an Electron-main-owned vault and are
  never serialized into renderer state, provider input, model context,
  checkpoint/fallback state, lineage, logs, diagnostics, or crash reports.
- Each worker/helper receives an explicit allowlisted environment. Automation
  workers receive only credentials required by the selected task; Agent helpers
  and model providers receive none.
- Authorized tool calls carry opaque capability references. Only a host adapter
  may resolve a reference to a secret, and the result returned to the model must
  contain derived domain data rather than the credential.
- One shared redaction/assertion gate covers stdout, stderr, log tails, database
  records, error messages, diagnostics, and crash export. Canary presence is a
  hard test failure.
- Packaged desktop startup must fail closed when secure credential storage is
  unavailable. Plaintext credential persistence is not part of the supported
  App boundary.
- Packaging must use an allowlist or an explicit secret-file denylist and must
  fail qualification if any credential canary is present in the App bundle.

Until the remaining production log/diagnostic paths implement shared redaction
and later runtime slices complete their own gates, the overall audit remains
no-ship.
