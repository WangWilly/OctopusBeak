# Selectable Bank Statement Workflows Design

## Goal

Let users choose the statement types they own and want to collect for every supported bank. Manual and scheduled runs must reuse the saved selection, log in once per bank authentication domain, run the selected statement workflows in that Libretto session, preserve successful downloads when another selected type fails, and leave SQLite import as a separate task.

## Confirmed Decisions

- The selection is persistent per bank and applies to both manual and scheduled runs until the user changes it.
- Every enabled bank must have at least one selected statement type.
- A statement-type failure does not stop the remaining selected types.
- A bank run is `partial` when at least one selected type succeeds and at least one fails.
- A `partial` bank run permits Import; the UI must identify the missing bank and statement types.
- Downloaded files remain under the existing component workflow directories in `downloads/` and are imported later by the existing Import task.
- The selected UI direction is Prototype A: credentials and statement-type selection are separate sections on the same bank detail page in the existing Credentials modal.
- A multi-type bank with no saved selection is not runnable until the user reviews and saves a selection.
- A single-type bank may initialize its only supported type automatically.
- A statement type added in a later release is unchecked until the user explicitly enables it.

## Existing Constraints

- Fubon, Yuanta, and Cathay already run multiple statement components inside one Libretto workflow context. Other bank tasks currently expose one statement workflow but must use the same capability model so later types can be added without redesigning the UI or runner.
- The automation runner owns one Libretto session per task run and already handles pause, resume, timeout, cancellation, and cleanup. Session ownership must remain there.
- `settings.json` currently accepts boolean and string values and is injected into the workflow process as environment variables.
- Secrets remain encrypted in `credentials.json` through Electron `safeStorage`; statement selections are non-secret settings.
- Component workflows already write CSV and matching JSON files to `downloads/<workflow-name>/`.
- Import currently runs separately and deduplicates source files by path.

## Architecture

Use a capability-driven bank task model with thin shared orchestration. Do not create a generic workflow DSL or share a browser session across operating-system processes.

### Statement Capability Catalog

Add a plain shared catalog that can be imported by automation server code, Svelte-facing model builders, and bank workflows without importing Playwright workflow modules. Each bank authentication group may declare:

```ts
type StatementTypeCapability = {
  id: string;
  label: string;
};

type AutomationCredentialGroup = {
  id: string;
  label: string;
  enabledKey: string;
  credentialKeys: readonly string[];
  statementSelectionKey?: string;
  statementTypes?: readonly StatementTypeCapability[];
};
```

Stable IDs are internal values such as `deposit`, `foreign_currency`, `credit_card`, `loan`, and `fund`. Labels are localized in the renderer. A bank with one currently supported type still declares that type. Non-bank groups may omit statement capabilities.

Authentication boundaries, not brand names, define session sharing. For example, Yuanta Trade remains a separate group because it uses a different portal and credentials; it does not join the Yuanta bank session merely because the brand matches.

### Persistent Selection

Store selected IDs as a comma-separated string under the group's non-secret selection key, for example:

```json
{
  "LIBRETTO_CLOUD_YUANTA_ENABLED": true,
  "LIBRETTO_CLOUD_YUANTA_STATEMENT_TYPES": "deposit,foreign_currency,credit_card"
}
```

Comma-separated stable IDs fit the existing boolean/string settings contract and existing `settingsToEnv` injection path. No new persistence format or database table is needed.

One shared parser must:

1. split and trim the saved value;
2. reject unknown IDs at the write boundary;
3. remove duplicates while preserving catalog order;
4. reject an empty selection for an enabled bank;
5. distinguish a missing selection from an explicitly saved selection.

The server validates again before starting a manual or scheduled task. Renderer validation improves the interaction but is not trusted as the only guard.

### Bank Workflow Orchestration

Each bank keeps one top-level workflow responsible for login, bank-specific navigation resets, logout, and cleanup. It supplies an ordered list of component runners keyed by the shared capability IDs.

The shared orchestration helper is intentionally small. It receives the selected IDs and component runners, then returns one result per supported type:

```ts
type StatementComponentResult = {
  typeId: string;
  status: "success" | "failed" | "skipped";
  fileCount?: number;
  error?: string;
};
```

The top-level workflow follows this order:

1. Parse and validate the saved selection.
2. Log in once and retain the existing `ctx`, page, and session.
3. Iterate in catalog order.
4. Mark unselected types `skipped` without invoking their workflow.
5. Prepare bank-specific navigation when required.
6. Run the selected component in the same workflow context.
7. Record a component error and continue with the next selected type.
8. Log out and clean up once in `finally`.
9. Emit the final structured component summary as the last automation result record.

Bank-specific behavior stays in the bank workflow. Fubon may keep its session keep-alive and foreground handling; Yuanta may keep its between-component navigation preparation; Cathay may keep its retryable session reset. The shared helper does not attempt to model those differences.

Future banks use this structure from their first supported type. Adding a later type requires a catalog entry and a component runner in that bank's top-level workflow, not new modal logic or runner session logic.

## Run Status And Import Gate

Aggregate selected component results as follows:

- `completed`: every selected type succeeded.
- `partial`: at least one selected type succeeded and at least one selected type failed.
- `failed`: login or shared-session setup failed, or no selected type succeeded.
- `skipped` component results do not affect the aggregate status.

The workflow emits a final structured log sentinel containing the component results. The runner detects the sentinel while it already accumulates process output and persists the aggregate status through the existing task-run row. The final sentinel remains in the log tail so the page model can display failed type labels and short errors. This avoids a database migration.

Import readiness treats `completed` and `partial` producing tasks as ready. A `partial` task adds a warning listing its failed statement types. The Import action remains available and imports only files that exist; it does not synthesize empty files or rows for failures.

## Download Contract

Each component workflow keeps its current output directory and CSV/JSON schema. A component returns `success` only after its expected files have been written successfully. A file-write failure is a component failure and participates in `partial` or `failed` aggregation.

No bank-level copy or merged statement file is added. The structured run summary records the component outcome and file count; the existing component outputs remain the import source of truth.

## Upgrade And Default Behavior

- For an enabled multi-type bank with no selection key, show `Needs setup` and disable both manual Run and its scheduled execution. The Credentials modal opens directly to the unresolved bank when the user acts on this state.
- For a single-type bank with no selection key, initialize the only supported type as selected. Saving the modal persists it explicitly.
- When a release adds a capability ID, an existing explicit selection remains unchanged. The new type appears unchecked and does not start running until selected.
- Disabling a bank preserves its selection for later re-enabling.
- Re-enabling a bank with an empty or missing multi-type selection requires the user to select at least one type before saving.

## Credentials Modal: Selected Prototype A

Keep the existing modal shell, provider search, left bank navigation, Enabled switch, credential fields, Cancel, Save, and close controls.

The selected bank detail uses two sections:

1. `Login credentials` contains the existing fields and saved/missing states.
2. `Statements to collect` contains native checkboxes for every capability in catalog order.

The statement section includes the instruction `Choose at least one while this bank is enabled` and a compact `Select all` action. It does not add per-type date filters or scheduling controls.

The left bank row replaces the generic Enabled sublabel with useful configuration state:

- `3 of 5 selected` for a valid enabled bank;
- `Needs setup` for an enabled multi-type bank without a saved selection;
- `Disabled` for a disabled bank.

On Save, the modal validates all enabled banks, not only the visible bank. If one is invalid, it selects that bank, focuses the statement section, announces the error, and does not write any settings. This preserves the current all-at-once modal save behavior.

### Prototype Alternatives Considered

- Prototype B separated Credentials and Statements into tabs. It offered more room for descriptions but hid required setup behind a second navigation layer.
- Prototype C showed a cross-bank selection matrix and moved credentials into a secondary drawer. It improved bulk overview but required a larger redesign than the current number of sources justifies.
- Prototype A was selected because it makes login and collection scope visible together and requires the smallest change to the existing modal.

## Automation Page States

- A task that needs statement setup shows `Needs setup` instead of credential-ready status and offers a Configure action.
- A running task may show the current statement type in its existing progress area.
- A `partial` task uses a warning treatment, not the failure treatment, and exposes the failed type list in its log/details area.
- The Import row remains runnable after partial producing runs and shows a warning summary of missing types.
- Run history uses the same `partial` label and warning treatment.

## Error Handling

- Invalid selection writes fail before either `settings.json` or `credentials.json` changes.
- Login, CAPTCHA/session creation, or shared navigation bootstrap failure fails the entire bank run.
- Component navigation, download, parsing, or file-write failure is isolated to that component and does not stop later selected components.
- Logout and cleanup failures follow the runner's existing cleanup-failure behavior and may turn an otherwise completed run into failed when session safety cannot be confirmed.
- Error summaries shown in the UI contain statement type and a short message; full details remain in the existing automation log.
- Cancelling a task stops further components and follows existing session cleanup and task cancellation behavior.

## Accessibility And Responsive Behavior

- Use native checkboxes grouped by `fieldset` and `legend`.
- Keep visible focus styles and keyboard access for every checkbox and Select all action.
- Associate validation text with the fieldset and announce save errors through an `aria-live` region.
- Do not use color alone for selected, missing, partial, or failed states.
- At narrow modal widths, credential fields and statement choices collapse to one column while the existing provider navigation behavior remains unchanged.

## Verification

Leave the smallest checks that cover the new behavior:

1. A settings/parser check for valid round-trip, duplicate normalization, unknown IDs, missing multi-type selection, single-type initialization, disabled-bank preservation, and newly added types remaining unchecked.
2. An orchestration check proving selected components share one context, unselected components are skipped, a failed component does not stop the next one, and aggregation produces `completed`, `partial`, and `failed` correctly.
3. A runner/page-model check proving the final sentinel produces `partial`, failed type details remain available, manual and scheduled start validation match, and `partial` unlocks Import with a warning.
4. Existing Fubon, Yuanta, and Cathay workflow checks updated to assert their capability-to-component mapping.
5. `npm run typecheck` and the focused automation checks.
6. Manual desktop verification of modal keyboard operation, all-bank save validation, Needs setup routing, selected counts, partial task treatment, run history, and Import warning behavior.

## Non-Goals

- No generic workflow DSL, plugin system, or runtime discovery of bank capabilities.
- No browser session shared across separate task processes.
- No automatic SQLite import at the end of a bank workflow.
- No new date-range, account-number, currency, or schedule controls in this change.
- No merged bank-level download file or download directory migration.
- No automatic opt-in when a future release adds a statement type.
