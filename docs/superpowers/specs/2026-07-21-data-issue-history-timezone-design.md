# Data Issue History and Timezone Presentation

Date: 2026-07-21
Status: Approved for implementation planning

## Goal

Make the data-issue detail page easier to navigate and audit without changing stored ledger or audit data.

## Confirmed changes

- Display source-import timestamps in the configured system timezone.
- Display operation-event timestamps in the configured system timezone.
- Make the account title the link back to that account and remove the separate `Back to account` button.
- Explain the account link with a tooltip on hover and keyboard focus.
- Replace the inline operation-history disclosure with a history icon button beside the account title.
- Open operation history in a modal.

## Reused product patterns

- Use the existing `systemTimezone` and locale stores with `formatUtcDateTime`; keep the original UTC strings unchanged in storage and API responses.
- Use the installed Lucide icon set for the history action.
- Match the existing data-issue tooltip styling and modal treatment. Add no route or dependency.

## Interaction design

The account title is a normal text link. Hovering or focusing it shows `Back to account page`. Activating it preserves the existing deep link and account screen focus behavior.

A history icon button sits immediately after the account title. Hovering or focusing it shows `Operation history`. Activating it opens a modal containing the existing chronological event list. Each event shows its localized summary, system-timezone timestamp, and the existing collapsible technical details when present.

The modal:

- receives focus when opened;
- closes from its close button, Escape, or backdrop;
- returns focus to the history icon button when closed;
- has a labelled title, scrollable body, and empty state;
- does not change issue workflow state.

The existing page-level `Back` button remains unchanged. The inline operation-history section at the bottom of the workflow card is removed.

## Formatting and failure behavior

`formatUtcDateTime(value, $systemTimezone, $locale)` formats source-import and operation-event timestamps. The formatter remains the shared validation boundary for offset-bearing timestamps. Existing page-level error handling remains responsible for malformed API data; this change adds no fallback that could hide invalid timestamps.

## Accessibility

- The account link and history button are keyboard reachable.
- Tooltips appear on hover and focus and are connected with `aria-describedby`.
- The icon button has an accessible name independent of the icon.
- Modal focus is restored to the triggering button after close.
- Reduced-motion settings and existing screen-reader status announcements remain intact.

## Verification

The smallest required checks cover:

- both source-import and event timestamps use the shared system-timezone formatter;
- the account title carries the existing account deep link and tooltip;
- no separate `Back to account` button remains;
- the history icon button opens the modal;
- no inline operation-history disclosure remains;
- modal close paths restore focus to the trigger;
- operation technical details and empty state remain available;
- Electron verification covers mouse hover, keyboard focus, modal focus, Escape close, and the configured system-timezone display.

## Non-goals

- No database, DTO, IPC, ledger, or audit-schema changes.
- No editing, filtering, exporting, or pagination of operation history.
- No new shared modal or tooltip abstraction.
- No change to account return routing or issue workflow stages.
