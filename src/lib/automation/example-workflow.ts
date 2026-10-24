import type { WorkflowDefinition } from "./workflow-executor.ts";

type ExampleInput = Readonly<{ startUrl: string }>;

/** The starting point in docs/agents/workflow-development.md; the App never registers it. */
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
