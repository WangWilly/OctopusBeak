**Comparison Target**

- Source references:
  - `/var/folders/z9/lk2s3y4x75n5fs1qpph6_ppw0000gn/T/codex-clipboard-f14b33de-2bac-4039-a30a-9722e834bf04.png`
  - `/var/folders/z9/lk2s3y4x75n5fs1qpph6_ppw0000gn/T/codex-clipboard-8fc0d7d6-6204-448c-9fe1-ab713cafc2d5.png`
  - `/var/folders/z9/lk2s3y4x75n5fs1qpph6_ppw0000gn/T/codex-clipboard-259370b9-6c4b-4ddb-af6d-900e990ea38b.png`
  - `/var/folders/z9/lk2s3y4x75n5fs1qpph6_ppw0000gn/T/codex-clipboard-4d355a4a-2b1e-4d04-b603-ed527b9cf62d.png`
- Initial implementation: `/Users/willywangkaa/.codex/visualizations/2026/07/20/019f7d7b-c529-7612-b059-7eb1b053e89d/data-issues-progressive-initial.png`
- Diagnosis implementation: `/Users/willywangkaa/.codex/visualizations/2026/07/20/019f7d7b-c529-7612-b059-7eb1b053e89d/data-issues-progressive-diagnosis.png`
- Preview implementation: `/Users/willywangkaa/.codex/visualizations/2026/07/20/019f7d7b-c529-7612-b059-7eb1b053e89d/data-issues-progressive-preview.png`
- Narrow implementation: `/Users/willywangkaa/.codex/visualizations/2026/07/20/019f7d7b-c529-7612-b059-7eb1b053e89d/data-issues-progressive-narrow.png`
- State: Traditional Chinese data-issue workflow, from report summary through source confirmation and impact preview.

**Full-view Comparison Evidence**

The four source references and all implementation captures were opened together for direct visual comparison. The implementation keeps the report context and all stages inside one continuous card. Clicking `排除錯誤匯入` expands diagnosis in place; continuing expands the impact preview in the same surface. The requested initial `調查中` chip, diagnosis breadcrumb/header region, and visible error-history banner are absent.

**Focused Region Comparison Evidence**

The full captures clearly show the account identity, report facts, source import, impact values, and actions, so no additional crop was needed. Electron frame sampling measured progressive height changes during both stage transitions. The narrow viewport retained every primary action without horizontal overflow.

**Findings**

- No actionable P0, P1, or P2 differences remain.
- Typography: the existing application font stack, weights, and hierarchy are preserved.
- Spacing and layout: the report, diagnosis, and preview share one stable card and fixed account header; desktop and narrow states have no horizontal overflow.
- Colors and tokens: the existing surface, border, text, primary, and success tokens are reused.
- Assets: this flow has no raster or brand assets. Existing Lucide check and chevron icons are used; no handcrafted icon assets were introduced.
- Copy: the entry CTA is exactly `排除錯誤匯入`; reported value, data date, expected balance, import counts, and preview values remain intact.
- Error retention: error records remain in the prototype data model. Only the circled error-history presentation was removed from this page.

**Interaction Verification**

- Initial state: one workflow card, one `排除錯誤匯入` CTA, one account header, zero status chips, zero breadcrumbs, and zero visible error-history components.
- Diagnosis transition: sampled reveal heights progressed from `0` through intermediate values to `396px`, confirming visible motion.
- Preview transition: sampled reveal heights progressed from `0` through intermediate values to `505.5px`, confirming visible motion.
- Account context remained visible in initial, diagnosis, and preview states.
- Preview showed the corrected `354,107 TWD` value.
- Narrow viewport measured `clientWidth=881` and `scrollWidth=881`; the confirmation action remained available.
- Electron console emitted no errors.

**Comparison History**

- P2: the first-stage transition initially failed to animate because its transition node was nested in the parent conditional insertion. The stage blocks were separated; post-fix frame sampling confirms both transitions animate.
- P2: the account label initially disappeared after expansion. The account header was moved outside the list-only state; post-fix Electron checks find it once in every stage.
- Intentional deviation: the account name and report time remain fixed inside the shared card to preserve continuity between stages.
- Requested removals: the diagnosis breadcrumb/header region and error-history banner/disclosure are no longer rendered.

**Implementation Checklist**

- [x] Remove the initial `調查中` chip.
- [x] Rename the entry action to `排除錯誤匯入`.
- [x] Animate diagnosis and preview into one integrated card.
- [x] Preserve account context throughout the flow.
- [x] Remove the diagnosis breadcrumb/header and error-history UI.
- [x] Retain errors in the data model.
- [x] Verify desktop, narrow, transitions, and console behavior in Electron.

**Follow-up Polish**

- None required for this prototype handoff.

final result: passed
