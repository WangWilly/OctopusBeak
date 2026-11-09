import { randomUUID } from "node:crypto";
import { stderr, stdout } from "node:process";
import {
  authenticateYuantaTradePage,
  yuantaTradeSource,
} from "../src/workflows/yuanta-trade-statements.ts";
import { createWorkflowExecutor, type WorkflowDefinition } from "../src/lib/automation/workflow-executor.ts";
import { strictSourceText } from "../src/lib/automation/source-text.ts";
import { collectionPeriod, taipeiToday } from "../src/lib/automation/collection-period.ts";
import { productCollectionHandle } from "../src/lib/automation/product-collection.ts";
import { workflowBrowserProfileForWorkflow } from "../src/lib/automation/server/app-workflow-registry.ts";
import { YUANTA_TRADE_PRODUCTS } from "../src/lib/automation/server/sources/yuanta-trade.ts";
import {
  createDevelopmentBrowserPort,
  createLocalSolverHumanAssistancePort,
  developmentPageHost,
} from "./workflow-dev.ts";
import { runColumnProbe, type ProbeReport } from "./yuanta-trade-column-probe/probe.ts";

const WORKFLOW_ID = "yuanta-trade-statements";

const CREDENTIAL_VARIABLES = {
  yuanta_trade_user_id: "LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID",
  yuanta_trade_password: "LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD",
  yuanta_trade_ca_path: "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH",
  yuanta_trade_ca_password: "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD",
} as const;

type Credentials = Parameters<typeof authenticateYuantaTradePage>[1];

const USAGE = [
  "Yuanta Trade report column probe (development only)",
  "",
  "  npm run probe:yuanta-trade-columns -- --allow-live-source [--headless]",
  "",
  `Reads ${Object.values(CREDENTIAL_VARIABLES).join(", ")} from the environment.`,
  "Prints each trade report's grid columns as JSON on stdout and stage events on stderr. Writes no files.",
].join("\n");

function credentialsFromEnvironment(): Credentials | string[] {
  const missing = Object.values(CREDENTIAL_VARIABLES).filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) return missing;
  return Object.fromEntries(
    Object.entries(CREDENTIAL_VARIABLES).map(([field, name]) => [field, process.env[name]?.trim()]),
  ) as Credentials;
}

/** The executor's output is a run result, so the report leaves through `onReport`. */
const probeDefinition = (credentials: Credentials, onReport: (report: ProbeReport) => void): WorkflowDefinition => ({
  id: "yuanta-trade-column-probe",
  requiresFinancialCommit: false,
  async run(context) {
    await context.browser.withPage(async (page) => {
      await authenticateYuantaTradePage(page, credentials, context);
      context.signal.throwIfAborted();
      const declaration = YUANTA_TRADE_PRODUCTS[0].collectionPeriod;
      const period = collectionPeriod({ today: taipeiToday(context.now()), ...declaration });
      const product = productCollectionHandle({
        now: context.now,
        text: context.text,
        signal: context.signal,
        event: (stage, outcome, code, counts) => context.event(stage, outcome, code, counts),
        stage: () => { throw new Error("The column probe stages nothing."); },
        reportActivity: async () => undefined,
        collectionPeriod: () => period,
      });
      const source = yuantaTradeSource(page, product);
      await context.event("collection", "started", "collection-started");
      const report = await runColumnProbe(
        async (reportType, params) => ({ page: await source.captureReport(reportType, params), html: await page.content() }),
        {
          dateRange: { startDate: period.start.replaceAll("-", "/"), endDate: period.end.replaceAll("-", "/") },
          rangeDays: declaration.lookBack.days,
          signal: context.signal,
        },
      );
      await context.event("collection", report.complete ? "completed" : "failed", report.complete ? "collection-completed" : "collection-failed");
      onReport(report);
    });
  },
});

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
  const pageHost = developmentPageHost(randomUUID());
  let report: ProbeReport | undefined;
  const definition = probeDefinition(credentials, (value) => { report = value; });
  const executor = createWorkflowExecutor([definition], {
    browser: createDevelopmentBrowserPort(controller.signal, undefined, undefined, {
      headless: args.includes("--headless"),
      profile: workflowBrowserProfileForWorkflow(WORKFLOW_ID),
      pageHost,
    }),
    text: strictSourceText,
    humanAssistance: createLocalSolverHumanAssistancePort(controller.signal, { workflowId: WORKFLOW_ID, pageHost }),
    events: { append: async (event) => { stderr.write(`event ${event.stage}/${event.code}\n`); } },
    now: () => new Date().toISOString(),
  });
  try {
    await executor.run(definition.id, randomUUID(), undefined, controller.signal);
    if (!report) throw new Error("The probe returned no report.");
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.complete ? 0 : 1;
  } catch {
    stderr.write("Yuanta Trade column probe failed before the report; source details were suppressed.\n");
    return 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

process.exitCode = await main(process.argv.slice(2));
