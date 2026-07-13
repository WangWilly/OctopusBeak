# Card Task 7 Report

Status: DONE

Commit: `fix: use latest imported unbilled balances` (this report is included in the task commit)

Implemented:
- Credit-card positions now select only the latest imported `unbilled` snapshot per bank/product/card by `captured_at` and `snapshot_id`; `billed` snapshots are excluded from balances.
- Daily history normalizes to those latest unbilled snapshots, so historical unbilled captures (including TWD 160 and TWD 142) are not replayed; transaction rows remain available.
- Added migration 16 `latest_imported_unbilled_snapshots`, retaining the latest unbilled row per bank/product/card while preserving billed snapshots and transaction provenance.
- Added account, daily-history, and migration regressions, including TWD 14,844 for card 8397.

Verification:
- `node --no-warnings --experimental-strip-types src/lib/shared-ledger/server/accounts.check.ts` — pass
- `node --no-warnings --experimental-strip-types src/lib/overview/server/daily-history.check.ts` — pass
- `node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts` — pass
- `npm run typecheck` — pass, 0 errors and 0 warnings
- `git diff --check` — pass

Concerns: none.
