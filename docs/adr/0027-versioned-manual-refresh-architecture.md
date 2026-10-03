# Versioned manual refresh architecture

Status: accepted

The desktop app uses one monotonic data version to tell the renderer that a
completed automation run may have changed financial projections. The renderer
chooses when to fetch the new data through a deduplicated, app-wide refresh
coordinator. An automation completion therefore becomes visible immediately
as an invalidation signal without making the UI wait for an unsolicited
reload.

## Context

Financial pages are loaded through separate desktop requests, while the
automation runner finalizes in the Electron main process. Before this
decision, the two paths had no shared freshness contract: a completed run
could update local data without changing an already-rendered page, and a
renderer that missed an event had no lightweight way to discover that it was
out of date. Reopening the app happened to hide the gap by loading every page
again.

The product also needs a responsive shell. A refresh must not block the
renderer on every page or make the user wait for the slowest projection before
the current page can change. At the same time, financial blocks loaded by one
refresh round must describe the same data generation.

## Decision

### 1. One main-process data version is the freshness authority

The main process owns a non-negative, monotonic data version and its stale
state. The existing completed and partial terminal-run rules continue to mark
the version stale exactly once after the task-run transition commits. A failed
or cancelled product-collection run also marks it stale when durable
financial-commit receipts show that an earlier product changed data; those
statuses alone do not claim a change. Waiting for human input alone does not
invalidate data. The invalidation event contains the new version, reason, and
change time.

The event is advisory. It never starts page loads by itself. The renderer can
query the current snapshot when it starts, resumes, or reconnects, so a missed
event is equivalent to observing the same stale version through the query
boundary.

### 2. Query, acknowledgement, and event are the renderer contract

The desktop API exposes three operations:

- query the current `{ version, stale, changedAt }` snapshot;
- acknowledge one version after a successful refresh round; and
- subscribe to invalidation events, receiving an unsubscribe function.

Acknowledgement is conditional on the version still being current. If another
automation run invalidates data while a refresh is in flight, an acknowledgement
of the older version is rejected. The same user-initiated refresh then queries
the latest version and reloads against it, up to three rounds. A failed loader
also triggers a version check: only a newer version justifies retrying the
whole round. Continuous invalidation or a failure without a newer version
leaves the renderer stale or partial instead of claiming current data. IPC
event delivery is best effort because the query is the recovery path.

### 3. Refresh rounds capture one snapshot and prioritize the visible page

The renderer refresh coordinator reads the version once at the start of a
round and passes that same immutable snapshot to every page loader. It awaits
the current page first, then starts all other registered loaders in parallel.
Each loader owns its component-level state and may resolve or fail
independently. A failed loader does not discard successful results, and a
partial round is not acknowledged.

Only one user-initiated refresh may be in flight. It may contain bounded
successive rounds when a newer version supersedes one in progress. Repeated
refresh requests share its Promise, so a double click cannot duplicate
projection work or produce competing snapshots. An invalidation observed
during refresh clears once the successfully acknowledged round covers that
version; a later invalidation remains stale.

### 4. Refresh is explicit, stale-while-revalidate is the presentation policy

An existing page keeps its last successful data while its loader runs. A
component without data may show a skeleton; a component with data shows an
updating indicator and swaps in the result when its loader succeeds. The app
shell, navigation, and unrelated interactions remain available throughout.

## Consequences

- Automation completion no longer requires an app restart to become
  discoverable.
- Existing completed and partial runs keep their freshness behavior, while a
  failed or cancelled product run can also invalidate data after an earlier
  durable financial commit.
- The renderer can recover from sleep, navigation, and renderer restart with
  one cheap version query.
- Current-page data becomes available before background pages, while one round
  cannot accidentally mix generations.
- A partial refresh is observable and retryable without reverting pages that
  already succeeded.
- The in-memory authority is scoped to the running desktop process; a future
  durable data-version source may replace it if automation can outlive that
  process.

## Rejected alternatives

- Automatically fetching every page when an automation run completes: this
  spends network and CPU without user intent and can make the shell appear
  busy at an arbitrary time.
- Keeping a separate freshness flag in every page: pages could disagree after
  a missed event and would duplicate version comparison and retry semantics.
- Waiting for all page loaders before applying the current page: the slowest
  background block would unnecessarily delay the visible result.
- Accepting concurrent refresh requests: duplicate requests could overwrite a
  newer component result with an older round.

## Verification

The public contract tests cover monotonic versions, invalidation subscribers,
missed-event queries, conditional acknowledgement, current-first loading,
same-round snapshots, background fan-out, deduplication, and partial failure.
Renderer components remain responsible for wiring their loaders in a later
phase; this ADR defines the shared boundary they consume.
