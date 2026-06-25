import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { renderLedgerLensDashboard } from "./financial-dashboard-builder.ts";
import { buildFinancialModel } from "./financial-dashboard-model.ts";

const inputSchema = z.object({
  ledgerDir: z.string().default("data/ledger"),
  outputDir: z.string().default("data/ledger"),
  includeDuplicates: z.boolean().default(false),
});

function parseParams(argv: string[]): Record<string, unknown> {
  const paramsIndex = argv.indexOf("--params");
  const inlineParams = argv.find((arg) => arg.startsWith("--params="));
  const rawParams =
    paramsIndex >= 0 ? argv[paramsIndex + 1] : inlineParams?.slice(9);

  if (!rawParams) return {};

  const parsed = JSON.parse(rawParams) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--params must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

async function main() {
  const input = inputSchema.parse(parseParams(process.argv.slice(2)));
  const outputDir = resolve(input.outputDir);
  const model = await buildFinancialModel(input);
  const dashboardPath = join(outputDir, "financial_dashboard.html");

  await mkdir(dirname(dashboardPath), { recursive: true });
  await writeFile(dashboardPath, renderLedgerLensDashboard(model), "utf8");

  console.log(
    JSON.stringify(
      {
        schemaVersion: model.schemaVersion,
        generatedAt: model.generatedAt,
        status: model.quality.status,
        counts: model.counts,
        totals: model.totals,
        dashboardPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
