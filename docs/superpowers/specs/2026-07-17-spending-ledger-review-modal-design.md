# Spending Ledger and Account Review Modal Design

## Goal

Replace the current daily spending cards and inline account-transaction controls with the approved continuous-ledger layout and Modal A review flow. Preserve the existing spending classification rules, optimistic updates, invoice details, category filters, and excluded-record toggle.

## Scope

This change covers the daily-detail section of the Spending page only:

- redesign the daily record list as a continuous ledger;
- move account transaction details and include/exclude controls into a modal;
- expose the transaction time already stored in `account_transactions`;
- infer a destination account from a recognized note format for display;
- replace the excluded-record banner with an icon-only control and accessible tooltip.

The monthly and daily charts, CSV import, database schema, automatic classification rules, and invoice-detail modal are outside this change.

## Data contract

`SpendingAccountTransactionInput` and `SpendingAccountRecord` will carry the existing transaction fields needed by the modal:

- bank;
- outgoing account number;
- transaction date;
- transaction time, when present;
- currency;
- amount;
- original note;
- inferred destination bank code and account number, when recognizable.

`loadSpending` will add `transaction_time` to its existing account transaction query. No database column or migration is required.

### Destination inference

The database has no normalized destination-account field. The UI will therefore label the destination as inferred from the original note, not as authoritative account data.

A small pure function in `src/lib/spending/model.ts` will inspect only the first whitespace-delimited note token. It recognizes a 16- or 17-digit token as a three-digit bank code followed by a 13- or 14-digit account number. Examples:

- a 17-digit token beginning with `066` becomes bank code `066` plus its 14-digit account suffix;
- a 16-digit token beginning with `002` becomes bank code `002` plus its 13-digit account suffix.

Anything else returns no destination. The modal then shows the localized unavailable value while retaining the original note verbatim. This narrow rule limits inference to a bank-code-plus-account-like shape without claiming that the inferred value is authoritative.

## Continuous ledger

The daily-detail card keeps its existing title, total, record count, and category filters, with these approved reductions:

- remove the confirmed-record count beside the monthly total;
- remove the “newest first” label;
- show automatically excluded records through an icon-only control in the section header;
- add one ledger column header: date, transaction, amount.

Each calendar date is one semantic group. Its summary strip appears above the group rows and contains only the localized date and included daily total. It does not mention confirmed, excluded, or pending counts.

Each transaction row uses three aligned areas:

- date and weekday, or time for an account transaction when available;
- merchant or account description with source, category, and relevant status chips;
- currency-formatted amount.

Invoice rows keep opening `InvoiceDetailModal`. Every account row is a button that opens the account review modal. Pending rows may retain a subtle neutral warm background and pending chip, but have no colored edge and no chevron. Inline selects and include/exclude/restore links are removed.

## Excluded-record control

The control uses an inline Lucide-style `list-filter` SVG, so no dependency is added. It keeps the existing `showExcludedRecords` behavior and exposes:

- an `aria-label` containing the excluded-record count;
- `aria-expanded` reflecting the current toggle state;
- a hover and keyboard-focus tooltip stating that the records are excluded from daily totals and can be reviewed or changed.

The icon has no visible count badge or adjacent banner.

## Account review modal

Create `AccountTransactionReviewModal.svelte` using the same backdrop, focus containment, Escape handling, initial focus, and responsive modal primitives as the existing invoice modal.

The modal contains:

1. transaction description, amount, and current status;
2. a details list for outgoing account, inferred destination account, transfer date, optional time, currency, amount, and original note;
3. the spending-category selector;
4. include-in-spending and exclude choice controls;
5. cancel and confirm actions;
6. a restore-automatic-decision action when the record has a manual override.

The modal initializes from the current record. Confirm calls the existing `updateTransactionState` path. The parent keeps the current optimistic model update and server reload. The modal closes only after a successful save; on failure it remains open and shows the existing localized error. Cancel, backdrop, and Escape restore focus to the originating ledger row.

## Accessibility and interaction

- Ledger groups use sections with labelled headers.
- Invoice and account rows remain native buttons.
- Account row labels include description, date/time, amount, and “review transaction”.
- The modal is `role="dialog"`, `aria-modal="true"`, focus-contained, Escape-dismissable, and returns focus on close.
- The excluded icon tooltip is available on both hover and focus.
- Saving disables competing month, filter, ledger, and modal actions as today.

## Error handling

- Missing time, account number, note, or inferred destination renders the localized unavailable value.
- A failed override save rolls back the optimistic model, leaves the modal open, and exposes an alert message.
- Destination parsing never changes the stored note or writes inferred data to the database.

## Verification

- Model checks cover recognized and rejected destination-note formats and preservation of all account detail fields.
- Store checks prove `transaction_time` reaches the spending model.
- A focused browser check proves the approved ledger structure, simplified group summaries, icon tooltip/toggle, account modal contents, save flow, focus restoration, and absence of the old inline controls, colored edge, and chevron.
- Run the focused checks, full test suite, typecheck, production build, and `git diff --check`.
