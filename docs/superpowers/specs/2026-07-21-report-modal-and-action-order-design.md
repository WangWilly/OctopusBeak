# Report modal and action order design

## Goal

- Keep the report-data-issue dialog centered in the app viewport regardless of page scroll.
- Keep the report-data-issue icon as the rightmost account action on asset and liability pages.

## Design

`ReportDataIssueModal.svelte` will override the shared panel positioning with fixed viewport positioning and automatic margins. The change stays local because the other modal components are outside this request.

`AccountTable.svelte` will render the report button after every optional account action. DOM order will therefore match visual and keyboard focus order without CSS `order` rules.

## Verification

- Extend the existing data-issues UI check to pin fixed dialog positioning and final action order.
- Run the focused check, typecheck, and full test suite.
- In the Electron development app, scroll the assets page, open the report dialog, and confirm it remains centered; confirm the report icon is the rightmost action.

No `design-qa.md` file will be created.
