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

Those controls do not extend to the automation worker boundary:

| Surface | Current evidence | Result |
| --- | --- | --- |
| Electron main → encrypted credential file | Actual credential writer and codec path; canary absent from envelope; mode `0600` | Pass |
| Repository root → packaged App resources | Forge ignores `.env` and data directories but not the gitignored root `credentials.json` | **Blocker: local secrets can be bundled** |
| Electron main → renderer | Actual status projection contains booleans only | Pass |
| Electron main → automation child env | `automationConfigEnv` merges every stored credential into every child environment | **Blocker: capability is not task-scoped** |
| Child stdout/stderr → log tail | `accumulateAutomationOutput` removes terminal controls only | **Blocker: canary survives** |
| Log tail → persisted failure | `finalFailureMessage` selects a raw log line | **Blocker: canary survives** |
| Cleanup error → diagnostic object | `automationCleanupFailureDetails` copies the raw Error message | **Blocker: canary survives** |
| Host → Agent helper/provider | No production Agent helper/provider adapter exists | **Unproven** |
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
3. Repository root → packaged App: Electron Forge does not exclude the
   gitignored root `credentials.json`. During this audit, a redacted full-tree
   gitleaks scan found credential-shaped values in both the local root file and
   an existing packaged App copy. No secret value was read or recorded in this
   audit artifact.
4. Electron main → automation child: the child receives the full stored
   credential record in environment variables. There is no per-task capability
   projection.
5. Child stdout/stderr → filesystem log → SQLite `log_tail`/`record_json` →
   `error_message`: output is persisted without secret-aware redaction. A
   credential printed by a child can cross every one of these surfaces.
6. Agent helper/provider → tool result → checkpoint/fallback →
   lineage/diagnostics: only the throwaway state-machine shape exists. Its empty
   `secretFields` arrays are a desired schema, not evidence of a production
   enforcement point.

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

Until production helper/provider and recovery paths implement these constraints
and pass canary injection, the runtime support decision must remain no-ship.
