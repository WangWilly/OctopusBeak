# Automation Control Panel Design

## Goal

Add a local `/automation` page that replaces manual statement update commands with in-app controls for:

- editing local credentials in `.env`
- starting existing statement/sync/import tasks
- viewing task status, attempts, and log tails
- retrying failed tasks
- automatically running CSV import only after its crawler dependencies have succeeded for the current business day

The implementation wraps existing scripts. It does not rewrite bank workflows.

## Existing Commands

The page exposes these update tasks:

- `run:fubon-all-statements`
- `run:esun-credit-card-statements`
- `run:yuanta-all-statements`
- `run:yuanta-trade-statements`
- `run:cathay-all-statements`
- `run:hncb-statements`
- `run:sync-maicoin`
- `run:import-downloads-csv`

CSV import dependencies are the crawler tasks that produce downloaded CSV files:

- Fubon all statements
- ESun credit card statements
- Yuanta all statements
- Yuanta trade statements
- Cathay all statements
- HNCB statements

`sync-maicoin` is an update task but does not block CSV import because it writes directly to the ledger.

## UI

Use the design language from `docs/specs/001-dynamic-dashboard`:

- same shell, sticky topbar, cards, table, chips, buttons, modal, tokens, spacing, radius, and responsive behavior
- add an `Automation` nav item
- topbar shows current automation summary and a fixed-size `Credentials` button
- credentials form opens in a modal; credentials are not shown after save
- the main page is a task table
- there is no global `Run selected` button
- every task row has its own fixed-size controls: `Run`, `Resume`, `Retry`, `Logs`, or disabled `Locked`
- control buttons keep stable dimensions across states so rows do not shift
- each row shows status, attempt count, latest UTC time, and latest log tail
- detailed logs open from the row, backed by the task run log file, not from a separate bottom log panel

## Credentials

The credentials modal reads and writes the existing `.env` keys used by the workflows:

- Fubon: `LIBRETTO_CLOUD_FUBON_USER_ID`, `LIBRETTO_CLOUD_FUBON_ACCOUNT`, `LIBRETTO_CLOUD_FUBON_PASSWORD`
- ESun: `LIBRETTO_CLOUD_ESUN_USER_ID`, `LIBRETTO_CLOUD_ESUN_ACCOUNT`, `LIBRETTO_CLOUD_ESUN_PASSWORD`
- Yuanta: `LIBRETTO_CLOUD_YUANTA_USER_ID`, `LIBRETTO_CLOUD_YUANTA_ACCOUNT`, `LIBRETTO_CLOUD_YUANTA_PASSWORD`
- Yuanta trade: `LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID`, `LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD`, `LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH`, `LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD`
- Cathay: `LIBRETTO_CLOUD_CATHAY_USER_ID`, `LIBRETTO_CLOUD_CATHAY_ACCOUNT`, `LIBRETTO_CLOUD_CATHAY_PASSWORD`
- HNCB: `LIBRETTO_CLOUD_HNCB_USER_ID`, `LIBRETTO_CLOUD_HNCB_ACCOUNT`, `LIBRETTO_CLOUD_HNCB_PASSWORD`
- MAX/MaiCoin: `MAX_ACCESS_KEY`, `MAX_SECRET_KEY`, `MAX_SUB_ACCOUNT`

Credential save preserves unrelated `.env` lines and comments when possible. Secret inputs show saved/missing state but do not echo existing secret values back into the page.

## Runner

The server keeps a fixed task registry with:

- task id
- display name
- npm script
- kind: `crawler`, `sync`, or `import`
- dependencies
- credential group
- max attempts

Task execution uses the current scripts through `spawn("npm", ["run", script])`.

The runner only allows one active task at a time. A task can be started from its row. If another task is running, the start request is rejected with a clear message.

Crawler tasks get up to two total attempts: the first run plus one automatic retry after a non-zero exit. If the retry fails, the task is `failed`.

## Human In The Loop

CAPTCHA, OTP, device trust, certificate selection, and similar manual bank steps remain inside the Libretto browser session. OctopusBeak only shows that the task is waiting for human action.

`waiting_for_human` is an application status derived from task output or Libretto pause/resume indicators while the process is still alive. It is not a failure state.

## Import Gate

`run:import-downloads-csv` is locked until every CSV-producing crawler dependency has a latest successful run for the current business day.

The lock is checked on the server from SQLite task run history. It does not depend on current page state, selected rows, or client memory.

When the dependency check passes, import may be started manually from its row or automatically by the server after the last dependency completes.

## Time Rules

The database stores UTC timestamps only, as ISO strings.

The application computes the current business-day window from an env variable:

- `AUTOMATION_BUSINESS_TIMEZONE`
- value is an IANA timezone, for example `Asia/Taipei`
- default is `Asia/Taipei`

For dependency checks, the app converts the current business day in `AUTOMATION_BUSINESS_TIMEZONE` to a UTC start/end range, then queries task runs by UTC timestamps.

No local-time business date needs to be persisted in SQLite.

## SQLite Tables

Add a small automation history schema to the existing ledger database:

- `automation_task_runs`
  - `task_run_id`
  - `task_id`
  - `script`
  - `kind`
  - `status`
  - `attempt`
  - `max_attempts`
  - `started_at`
  - `finished_at`
  - `exit_code`
  - `signal`
  - `error_message`
  - `log_path`
  - `log_tail`
  - `record_json`

Existing `import_runs`, `import_run_events`, and `maicoin_sync_runs` remain unchanged. They continue to record domain-specific import/sync details.

Full task stdout/stderr is written to `data/automation/logs/<task_run_id>.log`. SQLite stores only the path and latest tail for fast page loads.

## Statuses

Task statuses:

- `queued`
- `running`
- `waiting_for_human`
- `retrying`
- `completed`
- `failed`
- `locked`

`locked` is used by the import task when dependency checks fail.

## API Shape

Use SvelteKit server routes/actions for:

- loading task registry, current statuses, and credential saved/missing state
- saving `.env`
- starting one task
- retrying one failed task
- reading task logs/history

The status endpoint returns server-derived state. The client polls while any task is active.

## Error Handling

- missing credentials fail before spawning the task when the missing keys are known
- spawn failure is recorded as `failed`
- non-zero exit records exit code, error summary, and log tail
- first non-zero crawler exit triggers one automatic retry
- second non-zero crawler exit remains `failed`
- failed dependency keeps import locked
- server restart does not resurrect active processes, but existing UTC task history remains visible

## Testing

Add focused checks for:

- timezone business-day window conversion from `AUTOMATION_BUSINESS_TIMEZONE`
- import gate reads dependency status from SQLite history, not client state
- retry policy allows one automatic retry for crawlers
- `.env` update preserves unrelated keys/comments
- task registry exposes the expected scripts and dependencies

UI verification should include desktop and mobile viewports from `docs/specs/001-dynamic-dashboard/DESIGN-MANIFEST.json`, with no horizontal overflow and stable task-row controls.
