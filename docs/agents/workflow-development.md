# Developing typed workflows

All 14 production tasks currently run through the desktop App's typed execution path. Use the project-owned `workflow:dev` command while building a browser provider; it loads the same `WorkflowDefinition` used by the App and injects development ports. Do not use generic Libretto `run` commands as the workflow development contract.

For headed development browser sessions, install full Chromium into Playwright's default user cache with `npx playwright install chromium` while `PLAYWRIGHT_BROWSERS_PATH` is unset. Desktop packaging uses a separate project-local cache and installs only Chromium headless shell; the packaging cleanup never removes the developer's default cache.

See [ADR 0032](../adr/0032-app-owned-workflow-runtime.md) and the [App-owned workflow runtime contract](../specs/app-owned-workflow-runtime.md) for production behavior and migration gates.

## Commands

```sh
npm run workflow:dev -- help
npm run workflow:dev -- list
npm run workflow:dev -- validate src/lib/automation/example-workflow.ts exampleWorkflow
npm run workflow:dev -- fixture
npm run workflow:dev -- inspect http://127.0.0.1:4173
```

`list` shows the eleven browser provider definitions in the App registry. `exchange-rates`, `sync-maicoin`, and `sync-tdcc` are typed non-browser workflows and do not use this browser CLI. To inventory the TDCC e-Passbook App protocol endpoints, use the development probe described in [Running the TDCC e-Passbook probe](tdcc-probe.md). To inventory the E.SUN deposit and foreign-currency portal endpoints, use [Running the E.SUN deposit probe](esun-deposit-probe.md). `validate` imports a trusted module under `src/lib/automation` and checks that the named export has a valid workflow ID, a `requiresFinancialCommit` declaration, and a `run(context, input)` handler. The shared `WorkflowDefinition` type has no runtime input schema, so the provider validates its own input before browser activity. `validate` can parse input JSON from an environment variable without displaying it:

```sh
npm run workflow:dev -- validate src/lib/automation/example-workflow.ts exampleWorkflow --input-env WORKFLOW_DEV_INPUT_JSON
```

This command checks JSON syntax and definition shape; it does not validate provider-specific input fields.

`fixture` runs a built-in synthetic workflow through the executor. It exercises the injected browser, strict text decoder, typed stage events, and a dry-run financial commit port without opening a browser or writing files. `inspect` opens a visible, temporary browser for a local page. For a remote page, add `--allow-live-source` explicitly.

## Add a workflow

While you build a provider, export a typed definition from a module under `src/lib/automation`, as `src/lib/automation/example-workflow.ts` does:

```ts
import type { WorkflowDefinition } from "./workflow-executor.ts";

type ExampleInput = Readonly<{ startUrl: string }>;

export const exampleWorkflow: WorkflowDefinition<ExampleInput> = {
  id: "example-workflow",
  requiresFinancialCommit: false,
  async run(context, input) {
    context.signal.throwIfAborted();
    await context.event("collection", "started", "collection-started");
    await context.browser.withPage(async (page) => {
      await page.goto(input.startUrl);
      context.signal.throwIfAborted();
    });
  },
};
```

Provider code uses only the ports supplied by `WorkflowContext`:

- `browser.withPage` supplies the App or development-owned Playwright page. Do not launch a browser or persist a browser profile inside a provider.
- `text.decode`, `text.stream`, and `text.assertIntact` handle source bytes. Reject invalid or incomplete source before commit.
- `event(stage, outcome, code, counts)` reports bounded progress. The outcome is `started`, `advanced`, `completed` or `failed`. Use `completed` only when the stage finished for the run or for one statement type, and `advanced` for one account or page inside it. Readers use the outcome, never the code, which is a lowercase kebab-case diagnostic ([ADR 0059](../adr/0059-run-event-outcome-and-signal.md)).
- `signalEvent(signal)` reports a Run event signal, such as `verification-solver-exhausted`. The signal fixes its own stage and outcome.
- `humanAssistance.request(contract, signal)` declares a verification stage for the solver. Despite its name, no person completes it ([ADR 0039](../adr/0039-solver-only-verification.md)). The stage needs a registered solver route, or the run fails closed. The workflow must resume only after the provider's completion check succeeds.
- Financial definitions set `requiresFinancialCommit: true` and call `context.financialCommit.execute(...)` only after source validation. Do not open a financial database or write an alternate output.
- A run returns its run result from `src/lib/automation/workflow-run-result.ts`, or nothing. A product collection returns `productRunResult(summary, { counts })`; the worker refuses any other shape, so provider data cannot leave the run ([ADR 0060](../adr/0060-product-collection-run-owns-every-verified-product-outcome.md)).

A Preview Source does not use `financialCommit`. Follow [Building on Preview Sources](preview-sources.md) instead.

Add a focused `*.check.ts` test alongside the provider. Exercise success, malformed or incomplete input before commit, cancellation, event reporting, and that the injected commit port receives the expected items.

## Run a workflow locally

For a workflow under development, provide its JSON input through an environment variable and point it at a local fixture server where possible:

```sh
npm run workflow:dev -- run src/lib/automation/example-workflow.ts exampleWorkflow \
  --input-env WORKFLOW_DEV_INPUT_JSON \
  --start-url http://127.0.0.1:4173 \
  --allow-live-source
```

For an App-registered workflow, its existing environment mapping can be used:

```sh
npm run workflow:dev -- run-app linebank-statements --allow-live-source
```

`--now INSTANT` fixes the workflow clock at one UTC instant, so a source's Collection period ([ADR 0077](../adr/0077-a-verified-product-declares-its-collection-period.md)) can be probed at a date boundary without waiting for it. For example, `2028-02-28T16:30:00Z` is 2028-02-29 in Taipei:

```sh
npm run workflow:dev -- run-app cathay-all-statements --now 2028-02-28T16:30:00Z --allow-live-source
```

The provider still sees today's real date. Use the flag only to check that a provider accepts the request dates a boundary produces, not to fetch data as of that day.

Set credential and input environment variables through a local secret manager or an interactive shell prompt. Do not put real credentials in command arguments, checked-in files, tests, or logs. The command does not echo input values.

Every workflow run requires `--allow-live-source` because provider code may contact a real service. It opens a visible, non-persistent browser context, refuses downloads, and closes the browser when the workflow ends or is cancelled. Verification stages run through the App's local solver route against the open development page. The command does not prompt in the terminal. A workflow or stage that the App would not route fails closed. The command does not run the App's CAPTCHA Retry Campaign, so a retryable outcome such as solver exhaustion ends the run. The CLI prints typed stage codes and counts; it suppresses provider error details that might contain source data or sign-in information.

The development financial port is always a dry-run. It counts the commit items and returns synthetic success receipts so the workflow can finish its provider-side checks. It never calls the Canonical Financial Commit module or writes to a database. A passing local dry-run verifies collection, decoding, completeness checks, and construction of commit items; it does not prove that Canonical Financial Commit will admit them. Keep commit admission covered by focused tests that inject the existing commit port, and run production collection only from the desktop App.

The development browser has no persistent user-data directory. The CLI creates no workflow log, source download, generated output, or telemetry file; its fixture check verifies an empty temporary directory after execution. Development browser state ends when the process closes and is separate from App-managed browser state.

## Activate for production

For a new provider, add a Verified source definition in `src/lib/automation/server/sources/<id>.ts` and list it in `sources/index.ts` ([ADR 0057](../adr/0057-verified-source-definition-owns-every-per-source-fact.md)). It declares the sign-in fields, products, start URL, capability flags, and a `load()` that imports the provider's `run` function. The credential group, App task, workflow registration, Overview expectation, preview coverage, and CAPTCHA routing are derived from it. All existing catalog tasks already use the App-owned execution path. Focused checks should cover the real injected Canonical Financial Commit contract, malformed-source rejection, cancellation, solver-routed verification where needed, and the absence of source/output/log artifacts. Do not add a provider-owned production CLI or persistence path.

## Test evidence and live service acceptance

Provider checks use deterministic input, browser, or HTTP fixtures to verify the contract implemented by the code. They do not prove that a bank's current production login or export page still matches those fixtures. HNCB's local HTTP/browser fixture uses synthetic CP950/Big5 export bytes and verifies in-memory collection and injected commit behavior; it is not a live HNCB login/export run. Record live-site acceptance separately when it has actually been performed.
