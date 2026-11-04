# Copy lives with the feature that owns it

Status: accepted

Every piece of UI copy lived in `src/lib/i18n/i18n.ts`: one English object of about 1,530 lines, then a Traditional Chinese copy of the same shape. It was the most changed file in the repository, with 93 commits in six weeks, most of them also changing one to fifteen feature files. Changing a single Automation string meant editing two places 1,500 lines apart in a file that did not say which feature a section belonged to, and every feature's copy change touched the same file.

**Each feature's copy lives in a `copy.ts` beside that feature.** For example, `src/lib/automation/copy.ts` holds the `automation` section and `src/lib/spending/copy.ts` holds the four Spending sections. Each file keeps its English object and its Traditional Chinese object next to each other, types the second as `typeof en`, and exports `{ en, "zh-TW": zh } satisfies Record<Locale, …Copy>`. Adding a locale therefore fails the build in every copy file until that file has the new locale.

**`i18n.ts` only assembles.** `translationFor(locale)` maps each section name to the copy file that owns it. `$t`, `translations` and `Translation` keep the same shape, so callers keep reading `$t.<section>.<key>`, including sections owned by another feature.

**Ownership** follows the noun that a section describes, not the features that read it:

| Owner | Sections |
| --- | --- |
| `i18n/shared-copy.ts` | `common`, `chart` |
| `shared-shell` | `nav` |
| `overview`, `assets`, `liabilities`, `manual-assets`, `automation`, `onboarding` | their own section |
| `settings` | `settings`, `usageStatisticsPrompt` |
| `spending` | `spending`, `purchaseSpending`, `spendingInsight`, `spendingReview` |
| `shared-accounts` | `accounts`, `historyTable`, `accountHistory`, `transactions`, `statements`, `positions`, `accountProducts`, `unidentifiedAccount` |
| `preview-sources` | `preview` |
| `welcome` | `firstRunWelcome` |
| `institutions` | `institutions`, read from `institutionNames` |

**The dependency points one way.** `locales`, `Locale` and `localeLabels` are in `src/lib/i18n/locale.ts`, and `i18n.ts` re-exports them. Copy files use only type imports, so `i18n.ts` imports every copy file at runtime and no copy file imports it back.

## Considered options

- **One `{ en, zh }` pair per key.** Rejected. It would rewrite all 3,000 lines, does not fit copy written as functions, and the smaller files already keep the two locales close together.
- **A store per feature, such as `$automationCopy`.** Rejected. It would change every caller, and a feature that reads another feature's section would need two stores.
- **One file per section.** Rejected. Sections such as the four Spending ones change together, and 26 files would cost more navigation than they save.

## Consequences

- To add a key, edit the owning feature's `copy.ts`. A new section is a new key in that file and one line in `translationFor`.
- A check that reads copy source text reads the owning `copy.ts`. `PurchaseSpendingDashboard.check.ts` now reads `spending/copy.ts`.
