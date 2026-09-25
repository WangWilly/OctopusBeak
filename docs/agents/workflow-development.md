# Developing typed workflows

The desktop App is the only production entry point for workflow collection. Use the project-owned `workflow:dev` command while building a provider workflow; it loads the same `WorkflowDefinition` used by the App and injects development ports. Do not use generic Libretto `run` commands as the workflow development contract.

See [ADR 0032](../adr/0032-app-owned-workflow-runtime.md) and the [App-owned workflow runtime contract](../specs/app-owned-workflow-runtime.md) for production behavior and migration gates.

## Commands

```sh
npm run workflow:dev -- help
npm run workflow:dev -- list
npm run workflow:dev -- validate src/lib/automation/example-workflow.ts exampleWorkflow
npm run workflow:dev -- fixture
npm run workflow:dev -- inspect http://127.0.0.1:4173
```

`list` shows definitions already registered with the App. `validate` imports a trusted module under `src/lib/automation` and checks that the named export has a valid workflow ID, a `requiresFinancialCommit` declaration, and a `run(context, input)` handler. It can also parse input JSON from an environment variable without displaying it:

```sh
npm run workflow:dev -- validate src/lib/automation/example-workflow.ts exampleWorkflow --input-env WORKFLOW_DEV_INPUT_JSON
```

The shared `WorkflowDefinition` type currently does not expose a runtime input schema. This command checks JSON syntax and definition shape; the provider must validate its own input before browser activity.

`fixture` runs a built-in synthetic workflow through the executor. It exercises the injected browser, strict text decoder, typed stage events, and a dry-run financial commit port without opening a browser or writing files. `inspect` opens a visible, temporary browser for a local page. For a remote page, add `--allow-live-source` explicitly.

## Add a workflow

Create a provider function and export its typed definition from `src/lib/automation/<workflow>-workflow.ts`:

```ts
import type { WorkflowDefinition } from "./workflow-executor.ts";

type ExampleInput = Readonly<{ startUrl: string }>;

export const exampleWorkflow: WorkflowDefinition<ExampleInput> = {
  id: "example-workflow",
  requiresFinancialCommit: false,
  async run(context, input) {
    context.signal.throwIfAborted();
    await context.event("collection", "collection-started");
    return await context.browser.withPage(async (page) => {
      await page.goto(input.startUrl);
      context.signal.throwIfAborted();
      return await page.title();
    });
  },
};
```

Provider code uses only the ports supplied by `WorkflowContext`:

- `browser.withPage` supplies the App or development-owned Playwright page. Do not launch a browser or persist a browser profile inside a provider.
- `text.decode`, `text.stream`, and `text.assertIntact` handle source bytes. Reject invalid or incomplete source before commit.
- `event(stage, code, counts)` reports bounded progress. Event codes must be lowercase kebab-case.
- `humanAssistance.request(contract, signal)` pauses for a person when the provider has declared verification targets. The workflow must resume only after the provider's completion check succeeds.
- Financial definitions set `requiresFinancialCommit: true` and call `context.financialCommit.execute(...)` only after source validation. Do not open a financial database or write an alternate output.

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

Set credential and input environment variables through a local secret manager or an interactive shell prompt. Do not put real credentials in command arguments, checked-in files, tests, or logs. The command does not echo input values.

Every workflow run requires `--allow-live-source` because provider code may contact a real service. It opens a visible, non-persistent browser context, refuses downloads, and closes the browser when the workflow ends or is cancelled. Human assistance shows only a generic prompt in the terminal: complete the step in the open browser and press Enter, or type `cancel`. The CLI prints typed stage codes and counts; it suppresses provider error details that might contain source data or sign-in information.

The development financial port is always a dry-run. It counts the commit items and returns synthetic success receipts so the workflow can finish its provider-side checks. It never calls the Canonical Financial Commit module or writes to a database. A passing local dry-run verifies collection, decoding, completeness checks, and construction of commit items; it does not prove that Canonical Financial Commit will admit them. Keep commit admission covered by focused tests that inject the existing commit port, and run production collection only from the desktop App.

The development browser has no persistent user-data directory. The CLI creates no workflow log, source download, generated output, or telemetry file; its fixture check verifies an empty temporary directory after execution. Development browser state ends when the process closes and is separate from App-managed browser state.

## Activate for production

After provider tests pass, register the definition and its credential/start-URL mapping in `src/lib/automation/server/app-workflow-registry.ts`, then route the product task through the App executor. Production activation is a separate migration phase with acceptance checks for real injected Canonical Financial Commit, malformed-source rejection, cancellation, human assistance, and absence of source/output/log artifacts. Do not add a provider-owned production CLI or persistence path.
