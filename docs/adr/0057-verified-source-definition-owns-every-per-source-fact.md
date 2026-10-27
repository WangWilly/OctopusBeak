# The Verified source definition owns every per-source fact

Status: accepted

## Decision

Before this decision, one [Verified source](../../CONTEXT.md)'s facts were hand-kept in about ten tables keyed by task id or integration namespace. They included the credential group and task in `tasks.ts`, the workflow registry's start URL and environment-to-input mapping, `BANK_STATEMENT_CAPABILITIES`, `expected-sources`, `TASK_LOGOS` and `TASK_NAMESPACES`, the two CAPTCHA routing sets, `taskLabels` in i18n, and the default settings in `electron/runtime.cjs`. Adding TDCC edited seven non-test files. The HNCB credential keys and login URL were each written twice, and tasks found their credential group by array position.

So each Verified source has one definition, `VerifiedSource`, the counterpart of `PreviewSource`. Both share a `SupportedSource` base: display name, search aliases, credential fields, setup guide, and start URL. Every table above is derived from the definitions, and the Supported Source Name lives only there.

- **One definition, one Source connection.** A definition owns its credential group and its single automation task. Exchange-rate sync is not a source and stays outside.
- **Workflow code loads lazily.** The definition is imported by the Electron main process, so it holds `load: () => import(...)` for `run` (and an optional `verification.route`, the only place a per-source Verification route is chosen, which imports its module when a stage is requested), never the workflow module itself. Static facts the host needs before loading, such as runtime, browser profile, `requiresFinancialCommit`, `requiresAccountIdentity`, and attached preview products, stay on the definition.
- **Persisted setting keys are spelled out.** Enabled, statement-selection, and credential keys keep their existing strings and are declared literally, not derived from the id. A registry invariant check enforces uniqueness and prefixes.
- **The renderer gets derived data.** Logos reach the renderer on the page model's task row; the renderer never imports definitions.
- **Default settings keep their precedence.** First-run `settings.json` still writes every enabled key as `false`, now derived from the definitions, because settings take precedence over environment variables.

## Considered options

- **Split a renderer-safe metadata table from a worker-side binding table keyed by id.** Rejected. It recreates a second hand-synchronized table, the friction this decision removes. A lazy `load` keeps workflow code out of the main process and renderer without the split.
- **Put `run` directly on the definition, as `PreviewSource` does.** Rejected. The main process would load every verified workflow at startup.
- **Derive setting keys from the id (`LIBRETTO_CLOUD_${ID}_ENABLED`).** Rejected. MaiCoin already uses `MAX_*`, and renaming persisted keys would need a settings migration for no behavioural gain.
- **Merge Verified and Preview sources into one type with a `stage` discriminator.** Rejected. Under [ADR 0047](0047-preview-sources-outside-canonical-admission.md) they differ in input, commit, and admission. A shared base gives the reuse without mixing the two paths.

## Consequences

- The capability ports table ([82ea4a027](https://github.com/WangWilly/OctopusBeak/commit/82ea4a027)) still reads its flags from the assembled `WorkflowDefinition`. Only where those flags are declared moves.
- Ten pass-through `*-workflow.ts` modules and the registry's lazy-import shims are deleted. The MaiCoin and TDCC workflow modules hold real implementation and remain as `load` targets.
- Tests that pinned copy and environment keys with `deepEqual` are replaced by one registry invariant check and one check of the generic environment-to-input derivation.
