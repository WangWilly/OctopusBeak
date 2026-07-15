# Automation Timezone Labels Design

## Goal

Automation timestamps already render in the configured system timezone. Their visible labels must identify that timezone instead of incorrectly saying `UTC`.

## UI

- Task rows show `Latest (<IANA timezone>)` / `最新（<IANA 時區>）`.
- Run-history columns show `Started (<IANA timezone>)`, `Finished (<IANA timezone>)` and their Traditional Chinese equivalents.
- Labels update reactively when the shared system timezone changes.

## Boundaries

- Stored timestamps and structured logs remain UTC.
- Internal APIs, formatter names, and the raw `--scheduled-at-utc` command argument remain unchanged because they describe the actual data contract, not display copy.
- No friendly-name timezone mapping is added; the existing IANA identifier is precise and already available in the dashboard.

## Verification

- Add a focused automated check proving the human-facing automation labels contain no `UTC` and accept the configured timezone identifier.
- Run the relevant checks and typecheck.
- Inspect the Automation task list and run-history modal through Electron CDP.
