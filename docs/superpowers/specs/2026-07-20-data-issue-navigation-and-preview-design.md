# Data-Issue Navigation And Preview Design

## Goal

Make data-issue reporting available from asset and liability accounts, preserve the user's place when navigating between an account and its issue, and make exclusion impact understandable without exposing internal identifiers as the primary label.

## Navigation

- Account deep links use the existing hash router with `#/assets/{accountId}` and `#/liabilities/{accountId}`.
- The data-issue report step includes a backlink to the originating account route derived from the persisted account group and ID.
- Opening an account deep link selects that account, scrolls its row into view, and moves keyboard focus to the row after rendering.
- Investment-group reports return to the assets page because investments are presented there.
- The existing top-level Back button continues to return to the data-issue list.
- The preview stage adds a secondary Back button beside the exclusion action. It returns to source selection and keeps the selected source.

## Reporting Modal

- Assets and liabilities pass the same `onReportDataIssue` callback to the shared account table and render the same report modal.
- Closing or cancelling the modal unmounts it. A closed native `dialog` must never remain visible through the global `.modal-panel` display rule.
- Submission behavior and persisted case data do not change.

## Impact Preview

- Each affected account shows its account label as the primary text and its masked/internal account ID only as secondary text.
- The backend preview DTO supplies the account label from the validated ledger account context; the renderer does not infer it.
- The three impact metrics remain compact and gain accessible explanations shown on pointer hover and keyboard focus:
  - Rows excluded: physical imported rows owned by the selected exact source version that will become inactive.
  - Rows retained: logical duplicate rows whose complete projections remain supported by another active source version, so their visible data remains.
  - Affected accounts: every account whose visible value or shared capture validity depends on the selected source, including unchanged fallback values.
- Tooltip copy includes the current count and explains why the result is excluded, retained, or affected. Tooltips use the existing hover/focus tooltip pattern and remain available to keyboard users.

## Components And Data Flow

- `+page.svelte` parses an optional account ID for asset/liability routes and passes it to the matching dashboard.
- `AssetsDashboard` and `LiabilitiesDashboard` pass that ID to `AccountTable`.
- `AccountTable` owns selection/focus/scroll because it owns the rendered rows.
- `DataIssuesDashboard` builds the account backlink, renders account labels, metric tooltips, and the preview-stage Back action.
- `store.ts` adds `accountLabel` to each affected-account preview item using the existing before/after account records.
- No new route, dependency, tooltip abstraction, or persistence table is added.

## Error And Accessibility Behavior

- Missing deep-link account IDs fall back to the normal first-row selection without throwing.
- Focus moves only when a valid deep-link account exists and changes; ordinary table interaction is unaffected.
- Tooltip triggers are focusable and use `aria-describedby`; tooltip content uses `role="tooltip"`.
- Reduced-motion behavior remains unchanged; account scrolling uses non-animated positioning.

## Verification

- Source checks cover asset reporting support, modal unmounting, deep-link parsing, account selection/focus, backlink route, account labels, tooltip content/accessibility, and preview Back behavior.
- Store checks verify affected-account labels for available, unavailable, and same-value fallback accounts.
- Electron/CDP reproduces the cancelled-modal bug, exercises asset reporting, follows the backlink to the exact focused row, checks all tooltips with hover and keyboard focus, and returns from preview to source selection.
- Run the full test suite, typecheck, renderer/Electron build, privacy check, and `git diff --check`.
