# E-Invoice Item Sequence Normalization Design

## Goal

Store `personal_invoice_items.item_sequence_number` as a canonical SQLite integer and ensure padded source values such as `1`, `01`, and `001` identify the same invoice item.

## Root Cause

The e-invoice API returns item sequence numbers as strings with seller-specific zero padding. The workflow writes the raw string to CSV. The CSV parser currently copies that string into a `TEXT` column and embeds it unchanged in `item_key`.

Consequently, equivalent sequence values have inconsistent database representations and can produce different stable keys.

The current ledger contains 1,067 item rows. All sequence values are numeric, 505 are zero-padded, and canonical integer conversion creates no duplicate `(invoice_key, sequence)` pairs in the current data.

## Canonical Model

`personal_invoice_items.item_sequence_number` is a nullable, non-negative SQLite `INTEGER`.

The parser converts a non-empty sequence using strict decimal validation:

- `"0"` becomes `0`.
- `"1"`, `"01"`, and `"001"` become `1`.
- An empty value becomes `NULL` and keeps the existing content-based fallback item key.
- A non-decimal, negative, or unsafe integer causes the import to fail with an actionable error rather than silently changing identity.

For numeric sequences, the stable item key is:

```text
<invoice_key>|<canonical integer sequence>
```

The original CSV row remains unchanged in `raw_payload_json`, retaining source fidelity for debugging and audit purposes.

## Parser Changes

Add a focused sequence parser in `src/ledger/source-csv-parsers.ts`. Both `personalInvoiceItemKey` and `personalInvoiceItemFields` use that function so identity and stored value cannot diverge.

The e-invoice workflow and generated CSV retain the provider's raw sequence string. Normalization occurs at the typed SQLite import boundary, including imports of historical CSV files.

## Schema And Migration

Change the table creation schema so new databases define:

```sql
item_sequence_number INTEGER
  CHECK (
    item_sequence_number IS NULL
    OR (typeof(item_sequence_number) = 'integer' AND item_sequence_number >= 0)
  )
```

Add migration version 10 for databases that already applied migration 9.

The migration runs in the existing migration transaction and:

1. Reads the declared `item_sequence_number` column type.
2. Returns without rebuilding when the type is already `INTEGER`.
3. Counts non-empty legacy values that are not decimal digits and aborts with an error containing only the count if any exist.
4. Creates a replacement `personal_invoice_items` table with the canonical schema.
5. Copies empty sequence values as `NULL` while preserving their existing fallback keys.
6. Copies numeric values as integers and rewrites their item keys with the canonical sequence.
7. If multiple legacy rows collapse to one canonical `(invoice_key, sequence)`, retains the newest row by `imported_at`, then `source_row_index`, `created_at`, and `rowid` descending. This matches the importer's latest-import-wins semantics.
8. Replaces the old table and recreates its indexes and foreign key.

The migration preserves all provenance, hashes, raw payloads, timestamps, quantities, prices, and product names from the retained row.

## Import Behavior

Historical padded CSV files remain importable. After migration, reimporting them produces the same canonical item keys and updates existing rows instead of creating padded variants.

The existing invoice key is unchanged. Only item keys with numeric sequences are rewritten.

## Error Handling

- Invalid new CSV sequence values fail at the parser boundary before database writes commit.
- Invalid non-empty legacy sequence values abort migration 10 and roll back the migration transaction.
- Error messages report the field and invalid-row count, not invoice or purchase data.
- Canonical collisions are resolved deterministically without retaining duplicate logical items.

## Testing

Use test-driven development with focused assertion checks:

1. Parser checks prove `"001"` becomes integer `1` and key suffix `|1`.
2. Parser checks prove `"0"` remains integer `0` and uses key suffix `|0`.
3. Parser checks prove invalid, negative, and unsafe values throw.
4. Import checks prove a padded CSV value is stored with SQLite type `integer` and repeated import remains idempotent.
5. Migration checks create a version-9-style `TEXT` table, run migration 10, and verify integer storage, canonical keys, raw payload preservation, index recreation, and foreign-key preservation.
6. Migration collision checks verify the newest legacy row is retained when padded variants collapse to one key.
7. Migration invalid-data checks verify a non-decimal legacy value aborts without modifying the original table.
8. Run the existing e-invoice parser, importer, migration, automation, typecheck, and build verification commands.

## Success Criteria

- New and migrated `item_sequence_number` values have SQLite type `integer` or `null`.
- Zero padding never affects `item_key` identity.
- Existing padded rows are normalized automatically during migration.
- Reimporting historical CSV files does not recreate padded keys or duplicate items.
- Original source values remain available in `raw_payload_json`.
- Invalid values fail without partial writes or disclosure of purchase data.
