# Spending Dashboard Design

## Goal

Add a top-level **Spending / 消費** page that turns normalized personal e-invoice data into the monthly, daily, and invoice-detail views shown in the approved wireframe. Each invoice item receives an automatic category when first imported, and users can change that category from the invoice detail modal with the result persisted in SQLite.

Reference wireframe:

```text
/Users/willywangkaa/Library/Application Support/Open Design/namespaces/release-stable/data/projects/c9dbc36e-e247-4ee5-aab8-fceaed74c8ab/index.html
```

## Scope

The first version includes:

- A new `#/spending` route and top-level sidebar item.
- Monthly category spending as a stacked bar chart.
- Month selection and a daily spending chart modal.
- A category-filterable invoice list for the selected month.
- An invoice detail modal containing seller metadata and item lines.
- Per-item category editing with immediate SQLite persistence.
- Automatic category assignment for existing and newly imported items.
- English and Traditional Chinese labels through the existing i18n store.

It does not include custom category creation, category-rule editing, bulk recategorization, category history, budgets, or audit logging.

## Existing Components And Patterns

The page uses the existing application shell and visual language rather than copying the wireframe as a standalone document:

- `DashboardShell.svelte` supplies the sidebar, top bar, and responsive application frame.
- Global `.card`, `.panel-title`, `.chip`, `.filter-btn`, `.button`, `.modal`, `.modal-panel`, `.modal-head`, `.modal-body`, and `.modal-close` styles remain the base components.
- The installed LayerChart dependency renders stacked monthly and daily bars, following `StackedBalanceChart.svelte` conventions.
- Existing modal behavior supplies backdrop dismissal, Escape handling, focus restoration, and compact mobile layout.
- Existing money formatting and i18n stores supply display formatting and translated labels.

Feature-specific CSS is limited to chart dimensions, month controls, invoice rows, category colors, and the item category selector.

## Navigation And Page Layout

Add `spending` to the route union, hash-route dispatcher, `DashboardShell` active-page type, and sidebar navigation between Liabilities and Automation. The new page title is **Spending** in English and **消費** in Traditional Chinese.

The page follows the wireframe in four sections:

1. A monthly stacked spending chart with category legend and selected-month emphasis.
2. A horizontal month selector with a compact action for opening the daily chart.
3. A selected-month summary showing total amount and invoice count.
4. A category filter and invoice list whose rows open invoice details.

The page shows an existing-style empty state when no confirmed personal invoices exist. On narrow screens, month controls scroll horizontally, invoice metadata wraps without overlap, and both modals use the existing mobile modal treatment.

## Category Model

Use these fixed category identifiers from the wireframe:

| Identifier | English | Traditional Chinese |
| --- | --- | --- |
| `food` | Dining | 餐飲 |
| `daily` | Daily essentials | 日常採買 |
| `transport` | Transport | 交通移動 |
| `shopping` | Shopping | 購物 |
| `home` | Home bills | 居家帳單 |
| `leisure` | Health and leisure | 健康休閒 |
| `other` | Other services | 其他服務 |

A pure category module owns the identifiers, validation, and automatic classifier. The initial keyword lists and precedence match the wireframe:

1. Match item product-name rules.
2. Match seller-name and seller-address rules.
3. Fall back to `other`.

The classifier accepts normalized item and seller text and returns one valid identifier. Category labels and colors remain presentation data in the spending feature and i18n files.

## SQLite Persistence

Add a non-null `category` column to `personal_invoice_items`, constrained to the seven identifiers and defaulting to `other`.

Migration 11 adds the column to existing databases and backfills every existing item with the shared classifier using its product name and joined invoice seller metadata. New databases receive the column through the personal-invoice table creation schema.

The CSV importer assigns an automatic category in the record passed to the item insert. Crucially, `category` is not added to `PERSONAL_INVOICE_ITEM_UPDATE_COLUMNS`. Therefore:

- A new item receives an automatic category.
- Reimporting the same logical item refreshes its source and amount fields.
- Reimporting never overwrites a category that the user changed.

The original source CSV and `raw_payload_json` remain unchanged.

## Data Loading And Aggregation

Add a small spending server module using the existing ledger database client and prepared SQLite statements. One joined query loads confirmed invoices and their items ordered by issue time, invoice key, and item sequence.

The returned DTO retains normalized invoice and item entities. Pure view-model helpers derive:

- Available months in chronological order.
- Monthly totals split by item category.
- Selected-month total and invoice count.
- Daily totals split by item category.
- Categories present in the selected month.
- Invoice filtering by selected category.

All calendar grouping uses `Asia/Taipei` because `issued_at` is a Unix timestamp and invoice dates are local Taiwan dates. Negative item amounts remain negative in category totals. Any difference between the invoice amount and summed item amounts is assigned to the first item category, or `other` when the invoice has no items, matching the wireframe and preserving the invoice total.

Only invoices with `status = 'confirmed'` contribute to spending totals and lists. Other statuses remain stored in the ledger but are excluded from this view.

## Category Editing

In the invoice detail modal, each item displays a native seven-option category selector styled like the wireframe category chip. A selection change:

1. Validates the category in the renderer.
2. Calls `spending:updateItemCategory` with `itemKey` and `category`.
3. Validates both values again in the Electron handler.
4. Runs a prepared `UPDATE personal_invoice_items SET category = ? WHERE item_key = ?` statement.
5. Updates the local item and recomputes charts, totals, filters, and invoice category chips without closing the modal.

If the update fails or affects no row, the selector returns to its previous value and shows a compact inline error. There is no separate Save button because each change is a complete one-field update.

## Desktop API

Add two IPC operations following the existing overview/assets/liabilities pattern:

- `spending:load(): Promise<SpendingPageDto>`
- `spending:updateItemCategory(input): Promise<{ ok: true }>`

Register them in `electron/ipc.ts`, expose them in `electron/preload.ts`, and add them to the typed desktop API and channel check. The update input contains only the stable item key and one valid category identifier.

## Interaction And Accessibility

- Month and category filters use real buttons with pressed/selected state.
- Invoice rows are buttons with descriptive accessible labels.
- Chart legends and bars expose readable labels and values.
- Modals have labelled headings, close buttons, Escape dismissal, backdrop dismissal, and focus restoration.
- Category editing uses a labelled native select, supporting keyboard and assistive-technology interaction without custom menu code.
- Amounts and dates use locale-aware formatters while identifiers remain selectable text.

## Error Handling

- A failed page load uses the route's existing error state.
- An unknown category is rejected before SQLite execution.
- An empty or unknown item key is rejected and does not report success.
- Category updates use prepared statements and never interpolate user input into SQL.
- Import and migration failures remain transactional, preventing partially categorized imports or migrations.
- Empty datasets, months with no invoices, and invoices with no item rows render stable empty states instead of blank charts.

## Testing

Use focused assertion checks and existing build tools:

1. Category checks cover item-rule precedence, merchant fallback, case-insensitive matching, and `other` fallback.
2. Migration checks verify schema constraints and classifier backfill for existing rows.
3. Import checks verify new items receive categories and duplicate imports preserve user-edited categories.
4. Spending-model checks verify Taipei month/day boundaries, category totals, negative items, balancing differences, filters, and confirmed-status exclusion.
5. Desktop API checks verify valid updates, invalid-category rejection, and missing-item failure.
6. i18n and channel checks cover the new navigation and IPC keys.
7. Typecheck and production builds must pass.
8. Electron CDP verification captures desktop and mobile-sized screenshots of the page, daily chart modal, and invoice detail/category edit flow, checking for blank charts, overflow, and overlapping controls.

## Success Criteria

- Spending appears as a top-level page in both supported languages.
- The page matches the wireframe's information hierarchy while remaining visually consistent with OctopusBeak.
- Monthly and daily totals reconcile to confirmed invoice amounts.
- New invoice items receive deterministic automatic categories.
- Existing invoice items are backfilled during migration.
- User edits persist immediately and survive repeated CSV imports and application restarts.
- Fixed-category editing is keyboard accessible and rejects invalid writes.
- No new runtime dependency or parallel category table is introduced.
