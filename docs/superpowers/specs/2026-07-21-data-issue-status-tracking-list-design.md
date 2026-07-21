# Data Issue Status Tracking List Design

## Goal

Make the data-issue list readable as a status-tracking view while preserving the existing case model and navigation.

## Design

- Rename the list heading to “Status tracking” / “狀態追蹤”.
- Present the existing status filters as one segmented container using the spending month selector’s visual treatment.
- Show each case status beside its account name with the existing localized status label.
- Format each case update timestamp with the configured system timezone and locale.
- Show “Handle incorrect imports” / “處理錯誤匯入” in the sidebar while the list is open; detail views continue to show the case status.

## Constraints

- Reuse `formatUtcDateTime`, `systemTimezone`, and the existing status labels.
- Do not add a component, dependency, data field, or `design-qa.md`.
- Preserve keyboard-accessible buttons and the existing filter behavior.

