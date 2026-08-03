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

**REVIEWED PRODUCTION SURFACES GREEN.** The combined #75/#76 audit establishes
the packaged App, task-scoped worker, zero-secret helper/provider launch, and
automation redaction/persistence boundaries. Broader future Agent runtime
surfaces remain outside this integration ticket.

The packaged desktop credential path has two useful controls: the Electron main
process installs a `safeStorage` codec before credential IPC is registered, and
the credential file is an encrypted envelope written with mode `0600`.
Renderer-facing desktop state projects credential presence as booleans and does
not return values.

The packaging, credential writer, automation worker, helper/provider launch
contracts, and shared redaction gate now establish narrower capabilities. The
remaining provisional or unproven rows are future runtime surfaces and are not
blockers attributable to #75 or #76.

| Surface | Current evidence | Result |
| --- | --- | --- |
| Electron main → encrypted credential file | Actual credential writer and codec path; canary absent from envelope; mode `0600` | Pass |
| Repository root → packaged App resources | Forge explicitly ignores `.env`, root `credentials.json`, and data directories; the qualification test stages a canary in denied files | Pass |
| Electron main → renderer | Actual status projection contains booleans only | Pass |
| Electron main → automation child env | `automationProcessEnv` strips every known credential from the inherited environment, then projects only the selected task's declared credential keys | Pass |
| Host → Agent helper/provider | The production launch-env builders inherit only explicitly allowlisted non-secret process plumbing; a child-process assertion injects canaries into helper and provider inputs | Pass (launch contract; adapter pending in parent issue) |
| Child stdout/stderr → log tail | Shared redaction/assertion gate removes runtime canaries across chunks and reports the source surface | Pass |
| Log tail → filesystem and SQLite | Shared gate protects the log writer, SQLite columns, and `record_json` | Pass |
| Log tail → persisted failure | `finalFailureMessage` uses the shared gate before projecting a failure | Pass |
| Cleanup error → diagnostic object | Cleanup errors use the shared gate before console/error projection | Pass |
| Automation history → support export | Explicit schema allowlist plus shared redaction/assertion gate | Pass |
| Libretto patch stdout/stderr → console | Shared gate redacts diagnostics and turns a hit into deterministic failure | Pass |
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
   `error_message`: the shared fail-closed gate removes known Authentication
   secret values before accumulation, validates persistence/export schemas, and
   converts a hit into a deterministic surface/reason failure projection.
6. Agent helper/provider launch: production environment builders inherit a
   narrow non-secret allowlist, and the re-runnable process assertion verifies
   injected Authentication-secret canaries do not cross into either child.
7. Agent tool results, checkpoint/fallback, lineage, and diagnostics remain
   represented only by the throwaway state-machine shape. Its empty
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

Later runtime slices still need their own production helper/provider adapters,
recovery gates, and crash/telemetry export controls; those are outside #91 and
must not be inferred from this integration audit.
