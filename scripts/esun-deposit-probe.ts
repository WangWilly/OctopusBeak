import { randomUUID } from "node:crypto";
import { stderr, stdout } from "node:process";
import { authenticateEsunPage, type EsunCredentials } from "../src/workflows/esun-credit-card-statements.ts";
import { createWorkflowExecutor, type WorkflowDefinition } from "../src/lib/automation/workflow-executor.ts";
import { strictSourceText } from "../src/lib/automation/source-text.ts";
import { workflowBrowserProfileForTask } from "../src/lib/automation/server/app-workflow-registry.ts";
import { createDevelopmentBrowserPort } from "./workflow-dev.ts";
import { runDepositProbe, type ProbeReport } from "./esun-deposit-probe/probe.ts";
import { createPageTransport, observePortalRequests, waitForPortalSession } from "./esun-deposit-probe/page.ts";

const CREDENTIAL_VARIABLES = {
  esun_user_id: "LIBRETTO_CLOUD_ESUN_USER_ID",
  esun_account: "LIBRETTO_CLOUD_ESUN_ACCOUNT",
  esun_password: "LIBRETTO_CLOUD_ESUN_PASSWORD",
} as const;

const USAGE = [
  "E.SUN deposit and foreign-currency probe (development only; Phase 0 of issue #219)",
  "",
  "  npm run probe:esun-deposit -- --allow-live-source [--headless]",
  "",
  `Reads ${Object.values(CREDENTIAL_VARIABLES).join(", ")} from the environment.`,
  "Prints a sanitized structural report as JSON on stdout and stage events on stderr. Writes no files.",
].join("\n");

function credentialsFromEnvironment(): EsunCredentials | string[] {
  const missing = Object.values(CREDENTIAL_VARIABLES).filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) return missing;
  return Object.fromEntries(
    Object.entries(CREDENTIAL_VARIABLES).map(([field, name]) => [field, process.env[name]?.trim()]),
  ) as EsunCredentials;
}

const probeDefinition: WorkflowDefinition<EsunCredentials, ProbeReport> = {
  id: "esun-deposit-probe",
  requiresFinancialCommit: false,
  async run(context, credentials) {
    return await context.browser.withPage(async (page) => {
      page.on("dialog", (dialog) => { void dialog.accept().catch(() => undefined); });
      const observedRequests = observePortalRequests(page);
      await context.event("authentication", "authentication-started");
      await authenticateEsunPage(page, credentials, context);
      await context.event("authentication", "authentication-completed");
      await waitForPortalSession(page);
      context.signal.throwIfAborted();
      await context.event("collection", "collection-started");
      const report = await runDepositProbe(createPageTransport(page, context.signal), {
        now: new Date(context.now()),
        observedRequests,
      });
      await context.event("collection", report.complete ? "collection-completed" : "collection-failed");
      return report;
    });
  },
};

async function main(args: readonly string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const unknown = args.filter((arg) => arg !== "--allow-live-source" && arg !== "--headless");
  if (unknown.length > 0 || !args.includes("--allow-live-source")) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  const credentials = credentialsFromEnvironment();
  if (Array.isArray(credentials)) {
    stderr.write(`Missing environment variables: ${credentials.join(", ")}\n`);
    return 2;
  }

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  const executor = createWorkflowExecutor([probeDefinition as WorkflowDefinition], {
    browser: createDevelopmentBrowserPort(controller.signal, undefined, undefined, {
      headless: args.includes("--headless"),
      profile: workflowBrowserProfileForTask("esun-credit-card-statements"),
    }),
    text: strictSourceText,
    humanAssistance: { request: async () => { throw new Error("The deposit probe has no verification route."); } },
    events: { append: async (event) => { stderr.write(`event ${event.stage}/${event.code}\n`); } },
    now: () => new Date().toISOString(),
  });
  try {
    const report = await executor.run(probeDefinition.id, randomUUID(), credentials, controller.signal) as ProbeReport;
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.complete ? 0 : 1;
  } catch {
    stderr.write("E.SUN deposit probe failed before the report; source details were suppressed.\n");
    return 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

process.exitCode = await main(process.argv.slice(2));
