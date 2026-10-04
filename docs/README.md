# Documentation Map

Use one authoritative source for each kind of information. Link to it elsewhere instead of copying its content or status.

## Authority

| Information | Authoritative source | Use |
| --- | --- | --- |
| Requirements, priorities, and delivery status | [GitHub Issues](agents/issue-tracker.md) | Issues hold this repo's PRDs and current progress. Keep mutable issue status out of copied Markdown. |
| Shared vocabulary and core concepts | [`CONTEXT.md`](../CONTEXT.md) | Use its domain terms; update it when a concept is actually resolved. |
| Decision rationale | [`docs/adr/`](adr/) | Record accepted decisions and their rationale. A replacement should link the decision it supersedes; retain useful history. |
| Current developer and operational procedures | [`docs/agents/`](agents/), [`docs/runbooks/`](runbooks/), [`docs/desktop-release.md`](desktop-release.md), and the root READMEs | Keep the full procedure in one place and link from other entry points. Check commands and paths against the current project before publishing them. |
| Repository-local agent skills | [`.agents/skills/`](../.agents/skills/) | Keep skill-specific instructions and references with their skill; do not copy a second version into general project guidance. |
| Current technical contracts | [`docs/specs/`](specs/) and accepted ADRs | Check a spec's status and later ADRs before treating it as current behavior. A proposal or implementation plan is not proof that code follows it. |
| Supporting research and incident records | [`docs/research/`](research/) and [`docs/bugs/`](bugs/) | Treat these as evidence or historical diagnosis, not as current requirements by themselves. |
| Dated design and implementation snapshots | [`docs/superpowers/plans/`](superpowers/plans/) and [`docs/superpowers/specs/`](superpowers/specs/) | Their presence, dates, and checkboxes do not establish current approval or progress. Before reusing instructions, check the issue, accepted ADR, current contract, and implementation. |

For the current desktop database ownership and cutover, see [ADR 0030](adr/0030-pglite-owned-live-financial-views.md). For production workflow behavior, see the [App-owned workflow runtime contract](specs/app-owned-workflow-runtime.md). The SQLite-backed dashboard and storage documents retain earlier design history; their status notes identify which runtime details were replaced.

## Lifecycle

- Keep new or substantially revised plans and contracts marked `Proposed`, `Current`, `Historical`, or `Superseded`. Mark a contract `Current` only after checking it against accepted decisions and implementation evidence. If they conflict, preserve the accepted intent and record the discrepancy for review instead of silently changing the requirement to match the code.
- When a decision or contract is replaced, mark the old document `Superseded` and link the replacement. Preserve decision rationale that remains useful; remove confirmed duplicate or invalid operational instructions and let Git retain their history.
- Do not bulk-label existing plans or specs from age, filenames, or unchecked tasks. If their current status cannot be established, treat them as historical input and revalidate them before use.
- Put progress in GitHub Issues, not in a second Markdown tracker. When commands, paths, or runtime details change, update the canonical guide and link to it from any summary that needs to mention them.
