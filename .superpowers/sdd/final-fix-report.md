# Final review fix report

## Scope and commits

- Review base: `d8a09fa23e43e70ba39c81792d00ae8bf8980839`
- Verified implementation commit: `ffea8e85544be9d803579da53e25401f03e5e271` (`fix: resolve selectable workflow review findings`)
- This report is committed separately after the implementation commit; its hash is included in the parent-agent handoff.
- The checkout is an externally managed detached worktree. It was not moved, branched, pushed, or removed.
- Root-owned `design-qa.md` and `.superpowers/design-qa/` artifacts were not modified.

## Findings resolved

1. **Yuanta authentication ownership and fail-fast behavior**
   - `yuanta-all-statements` now authenticates before starting any selected component, so an authentication failure prevents every component and preparation callback from running.
   - The domestic workflow now uses the shared `librettoAuthenticate` path instead of unconditionally reopening the login page. Selected components therefore reuse the signed-in page/session.
   - The single top-level authentication inherits `replaceActiveSession` from the first selected component, preserving the selected workflow's input behavior.

2. **Partial-run cleanup failure**
   - A confirmed Libretto cleanup failure now promotes both `completed` and `partial` task outcomes to `failed`, while retaining the partial statement summary and successful files.

3. **Durable bounded statement summaries**
   - Sentinel errors are bounded to 100 source characters. This keeps the five-component Yuanta sentinel below the 4,000-character SQLite tail even when JSON escaping expands control characters sixfold.
   - Full component diagnostics remain in ordinary component error logs.
   - The runner appends a freshly normalized sentinel to the full log and makes it the final retained tail record after cleanup.
   - Tests cover tail eviction, output split across chunks, oversized errors, full diagnostic retention, and worst-case escaped control characters.

4. **Concrete Import warnings**
   - Import warnings now retain the generic explanation and list each localized task/bank label with its localized failed statement-type labels.

5. **Cathay legacy input compatibility**
   - Explicit legacy Cathay input `foreign` is accepted and normalized to capability ID `foreign_currency` before selection and execution.

6. **Stale persisted statement IDs**
   - Desktop model loading tolerates unknown persisted IDs, returns the known catalog-ordered subset, and marks the group as needing setup so the UI can repair it.
   - Fresh task start and save boundaries remain strict and reject unknown IDs.

7. **Stable accessible selection validation**
   - Statement-selection validation has separate state from page-wide action errors.
   - The error region remains mounted with `aria-live`; the focused fieldset dynamically references it with `aria-describedby`; actual checkbox controls carry valid `aria-invalid` and error descriptions.
   - The validation state clears when the user changes group, search, enabled state, or statement choices.
   - `aria-invalid` is intentionally not placed on `<fieldset>` because Svelte correctly warns that the fieldset's implicit group role does not support it. The final typecheck has zero accessibility warnings.

8. **Canonical save normalization**
   - Submitted selection keys are parsed strictly, deduplicated, and serialized in capability-catalog order before persistence. Selection keys absent from the submitted update retain their existing value.

9. **README import-gate wording**
   - English and Traditional Chinese quick-start and automation-panel text now state that Import unlocks after every enabled producing crawler has a `completed` or `partial` run for the business day.

10. **Settings/credentials persistence consistency**
    - Credential reads and encryption complete before any settings write.
    - When both files change, credential-write failure restores the previous settings bytes; rollback failure is surfaced together with the original write failure.
    - Tests prove unchanged settings and credentials after credential read, encryption, and atomic-write failures.

11. **Live status precedence over setup state**
    - Resume failures remain failed, then `waiting_for_human` and active `running`/`retrying` states take precedence over `needs_setup`. A currently running or paused task therefore keeps its cancel/assist controls even if persisted selection repair is required.

## Red-green evidence

- Oversized sentinel: `statement-run-summary.check.ts` initially failed `boundedLine.length < 4_000`; bounded serialization made it green.
- Escaped sentinel: five Yuanta failures containing NUL characters initially exceeded 4 KB; lowering the per-error bound from 300 to 100 made the exact regression green.
- Partial cleanup: the focused runner test initially returned `partial` when `failed` was expected; the cleanup promotion made it green.
- Yuanta: the workflow check initially lacked the `authenticate` call and allowed component execution to remain reachable after auth failure; central authentication made both success ordering and fail-fast assertions green.
- Yuanta option preservation: a foreign-only selection initially passed `true` instead of the component's `replaceActiveSession: false`; selecting auth input from the first selected component made it green.
- Cathay: Zod initially rejected explicit `foreign`; schema normalization made it green.
- Stale selection: tolerant resolution initially threw on `unknown`, and desktop load failed on `retired_type`; tolerant DTO loading plus strict boundaries made both green.
- Save normalization: persisted value was initially `loan, deposit,loan` instead of `deposit,loan`; catalog serialization made it green.
- Config consistency: a forced credential temp-path failure now proves paired rollback keeps settings and credentials byte-identical; separate checks cover pre-write encryption and credential-read failures.
- Row precedence: an active setup-required task initially rendered `needs_setup` instead of `running`; reordered precedence made active and waiting cases green.
- Dashboard source checks initially lacked per-warning detail and stable linked validation state; the localized warning loop and stable live region made them green.

## Verification commands and results

Focused checks included:

```text
node --no-warnings --experimental-strip-types src/lib/automation/statement-selection.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/statement-run-summary.check.ts
node --no-warnings --experimental-strip-types src/workflows/run-selected-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/yuanta-all-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/yuanta-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/cathay-all-statements.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-api.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/AutomationDashboard.check.ts
```

Result: all exit 0; the final runner check reported 35 passed, 0 failed.

Repository gates:

```text
npm test
npm run typecheck
npm run build
npm run privacy-check
git diff --cached --check
```

- Final `npm test`: 222 passed, 0 failed.
- Final typecheck: `svelte-check found 0 errors and 0 warnings`; `tsc --noEmit` exited 0.
- Final build: renderer/static adapter and Electron builds exited 0.
- Staged privacy check: scanned about 23.39 KB and found no leaks.
- Cached diff whitespace check: silent/exit 0.

The first sandboxed Vite check could not write under linked `node_modules/.vite-temp`; rerunning with the required linked-worktree permission succeeded. One later full-suite pass hit the pre-existing timing-sensitive import-claim assertion under concurrent load; the exact isolated test passed 1/1 in 152 ms, and the subsequent full rerun passed 222/222. No production change was made for that unrelated transient.

## Self-review and concerns

- Independent read-only review approved the final diff after identifying the JSON-escaping boundary; that issue was fixed with a failing regression before the final gates.
- The implementation keeps strictness at write/start boundaries while limiting tolerant behavior to desktop repair DTO loading.
- The paired JSON-file update is rollback-based rather than a filesystem transaction; synchronous read, encryption, and write failures are covered and leave both files unchanged. Process or machine loss between the two atomic renames remains an inherent two-file filesystem limitation and is not introduced by this feature.
- No unresolved product, privacy, accessibility, or test concerns remain.
