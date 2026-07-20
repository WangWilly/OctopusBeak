# Compact Data-Issue Workflow Redesign

Date: 2026-07-20
Status: Approved

## Goal

Make the existing clickable data-issue prototype read as one continuous workflow, keep every failed or blocked attempt visible, and replace the account-page report text action with an accessible warning icon.

## Approved visual target

Use the simplified revision of visual option 3 with one requested removal: the data-issue page must not show the extra top-right report icon or tooltip.

## Layout

- Keep the existing `DashboardShell` and product tokens.
- Render diagnosis and preview as one compact vertical workflow.
- Show `回報內容`, `確認來源`, and `預覽影響` as three connected rows separated by dividers.
- Collapse completed rows to one-line summaries; expand only the active row.
- Keep the current-versus-proposed value comparison, row counts, reason, acknowledgement, and actions in the expanded preview row.
- Remove the user-facing prototype scenario selector.
- Avoid nested cards and large gaps.

## Error history

- Keep every blocked or failed attempt as an append-only record in prototype state.
- Show a compact error-history disclosure with count and latest summary.
- Expanded records show time, stage, summary, status, and technical details.
- A failed attempt never changes the displayed ledger value.

## Report entry

- On the account page, replace the `回報資料問題` text button with the installed icon library's warning-triangle icon.
- Preserve the accessible name and native tooltip text `回報資料問題`.
- Do not repeat this report action inside the data-issue workflow page.

## Scope

This remains a renderer-only prototype. It does not persist errors, quarantine imports, or mutate SQLite. No new dependency, route, or backend API is added.

## Verification

- Model check proves blocked and failed attempts append error records without changing the value.
- Component check proves the account action uses an icon and accessible label.
- Typecheck and the full test suite pass.
- Electron verification covers compact diagnosis, preview, error disclosure, icon action, and narrow-layout reflow.
