# Task 7 Design QA

## Comparison target

- Approved initial reference: `/private/var/folders/z9/lk2s3y4x75n5fs1qpph6_ppw0000gn/T/codex-clipboard-259370b9-6c4b-4ddb-af6d-900e990ea38b.png`
- Approved expanded reference: `/private/var/folders/z9/lk2s3y4x75n5fs1qpph6_ppw0000gn/T/codex-clipboard-4d355a4a-2b1e-4d04-b603-ed527b9cf62d.png`
- Final initial/report capture: `.superpowers/sdd/task7-evidence/initial-report-fixed.png`
- Final diagnosis capture: `.superpowers/sdd/task7-evidence/diagnosis-fixed.png`
- Final impact preview capture: `.superpowers/sdd/task7-evidence/preview-fixed.png`
- Final readable failure capture: `.superpowers/sdd/task7-evidence/error-fixed.png`
- Final blocked-restore capture: `.superpowers/sdd/task7-evidence/restore-blocked.png`
- Final compact capture: `.superpowers/sdd/task7-evidence/narrow.png`
- Final unavailable-liability capture: `.superpowers/sdd/task7-evidence/liabilities-unavailable.png`
- Final persisted-history capture: `.superpowers/sdd/task7-evidence/restarted-history-fixed.png`
- Full comparison input: `.superpowers/sdd/task7-evidence/comparison-all.png`
- Focused card-region comparison input: `.superpowers/sdd/task7-evidence/comparison-focused.png`

The final application was captured from Electron at 1280×800 and 360×800, in Traditional Chinese, against a temporary synthetic ledger. The approved references and final captures were assembled into the two comparison inputs above and inspected together, not judged as independent screenshots.

## Findings

- No actionable P0, P1, or P2 visual difference remains.
- Layout: the account context and all workflow stages stay in one progressive card. Measured stage rectangles do not overlap after animation settles, and neither desktop nor 360 px compact capture has positive horizontal overflow.
- Requested simplification: the final flow has no breadcrumb, status chip, page-level error banner, or boxed source-option cards. Source rows are separated only by a divider, matching the annotated removal intent in the approved expanded reference.
- Typography and color: the existing application font stack, hierarchy, surface colors, text colors, and button tokens remain consistent with the surrounding product shell.
- Copy: the primary action is exactly `排除錯誤匯入`; operation-history entries are localized. A failed operation leads with a readable localized summary while the raw IPC error remains available only in collapsed technical details.
- Motion and focus: normal motion uses the existing 220 ms stage transition. With reduced motion emulated, no element animation was invoked. The operation-history disclosure opens with Enter and retains keyboard focus.
- Assets: this workflow needs no imagery. Existing icon components are used; no text-symbol, placeholder, or hand-drawn asset was introduced.

The approved initial reference and the final report modal are adjacent workflow states rather than pixel-identical states; the approved expanded reference and final diagnosis capture provide the closest like-for-like structural comparison. Synthetic account labels, values, and dates intentionally differ from the source incident.

## Comparison history

### Pass 1

- P0 functional: Electron initially remained on `載入中…` because the generated preload required a local Rollup chunk that Electron's sandbox would not load. The preload now has only the allowed Electron runtime dependency; a clean Electron build emits standalone `main.cjs` and `preload.cjs` files.
- P2: source candidates retained boxed borders and radii. The options were changed to unboxed rows with a single separator.
- P2: a mid-transition preview capture showed temporary overlap. The final-state layout was measured after transition completion and all adjacent stage rectangles are non-overlapping.
- P2: operation-history summaries exposed English implementation identifiers. Localized event summaries were added for both English and Traditional Chinese.
- P2: injected write failure displayed a raw IPC exception as primary copy. The final state shows a concise recovery message and keeps the raw exception in an optional details disclosure.

### Pass 2

- Repeated full-view and focused comparison found no remaining P0, P1, or P2 issue.
- Verified initial report, diagnosis, impact preview, confirmed exclusion, persisted resolved history after an explicit Electron restart, unavailable account values, injected write failure, blocked restore after a newer import, compact viewport, reduced motion, keyboard disclosure, and clean renderer console.

## Accepted constraints

- The existing desktop shell is denser than the large annotated reference canvas; the feature follows the product's current spacing and responsive tokens rather than rescaling the whole application.
- Red outlines in the approved reference are annotations identifying elements to remove, not visual styling to reproduce.
- The temporary ledger and evidence captures are QA-only and are not committed.

final result: passed
