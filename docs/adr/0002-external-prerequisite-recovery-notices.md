# External prerequisite recovery notices

Status: accepted

When an automation task cannot finish because a user-repairable external prerequisite is unavailable, the workflow must emit a structured prerequisite ID and the task run finalization layer must persist a deduplicated in-app recovery notice. Task metadata owns the localized instructions and HTTPS allowlisted official download link; the notice remains active across app restarts until the user repairs the prerequisite and successfully uses Run again. The product does not infer prerequisites from error strings, backfill historical logs, automatically toggle workflow enablement, automatically rerun tasks, or send OS notifications. A dedicated notice record is preferred over deriving state from logs so repeated failures, partial success, shared prerequisites, and resolved history remain explicit and traceable.

## Consequences

- Workflows and the automation server need a stable structured signal contract.
- Notice persistence needs a task/prerequisite identity, active and resolved lifecycle, latest run reference, and enough data to preserve traceability.
- The dashboard can group notices for a shared prerequisite while retaining task-level Run again actions.
- Provider URLs and user-facing recovery text are product metadata and must be maintained with the affected task definition.
