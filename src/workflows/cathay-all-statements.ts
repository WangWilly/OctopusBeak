import { workflow, type LibrettoWorkflowContext } from "libretto";
import { z } from "zod";
import {
  BANK_STATEMENT_CAPABILITIES,
  resolveStatementSelection,
} from "../lib/automation/statement-selection.js";
import {
  type CathayCredentials,
  createCathaySession,
  downloadCathayStatements,
  signInCathay,
} from "./cathay-statements.js";
import { downloadCathayForeignStatements } from "./cathay-foreign-statements.js";
import { retryableStage } from "./retryable-stage.js";
import { runSelectedStatements } from "./run-selected-statements.js";

const statementTypeSchema = z
  .enum(["domestic", "foreign_currency", "foreign"])
  .transform((type) => type === "foreign" ? "foreign_currency" as const : type);
const outputStatementTypeSchema = z.enum(["domestic", "foreign"]);

const dateRangeSchema = z.enum([
  "one_week",
  "one_month",
  "three_months",
  "six_months",
  "one_year",
]);

function createInputSchema() {
  return z.object({
    statementTypes: z.array(statementTypeSchema).min(1).optional(),
    dateRange: dateRangeSchema.default("one_year"),
    accountFilters: z.array(z.string()).default([]),
    domesticAccountFilters: z.array(z.string()).optional(),
    foreignAccountFilters: z.array(z.string()).optional(),
    currencyFilters: z.array(z.string()).default([]),
    trustDevice: z.boolean().default(false),
  });
}

const domesticDownloadSchema = z.object({
  type: z.literal("domestic"),
  accountId: z.string(),
  account: z.string(),
  queryPeriods: z.array(z.string()),
  branchName: z.string(),
  baseName: z.string(),
  csvFilename: z.string(),
  csvPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonFilename: z.string(),
  jsonPath: z.string(),
  jsonBytes: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
});

const foreignDownloadSchema = z.object({
  type: z.literal("foreign"),
  accountId: z.string(),
  account: z.string(),
  currencies: z.array(z.string()),
  queryPeriods: z.array(z.string()),
  branchName: z.string(),
  baseName: z.string(),
  csvFilename: z.string(),
  csvPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonFilename: z.string(),
  jsonPath: z.string(),
  jsonBytes: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: dateRangeSchema,
  statementTypes: z.array(outputStatementTypeSchema),
  usedExistingSession: z.boolean(),
  count: z.number().int().nonnegative(),
  downloads: z.array(z.union([domesticDownloadSchema, foreignDownloadSchema])),
});

const inputSchema = createInputSchema();
const cathayAllStatementsDependencies = {
  signInCathay,
  createCathaySession,
  retryableStage,
  downloadCathayStatements,
  downloadCathayForeignStatements,
};

export async function runCathayAllStatements(
  ctx: LibrettoWorkflowContext,
  rawInput: unknown,
  overrides: Partial<typeof cathayAllStatementsDependencies> = {},
) {
  const {
    signInCathay,
    createCathaySession,
    retryableStage,
    downloadCathayStatements,
    downloadCathayForeignStatements,
  } = { ...cathayAllStatementsDependencies, ...overrides };
  const input = rawInput as z.infer<typeof inputSchema> & {
    credentials: CathayCredentials;
  };
  const { page } = ctx;
  const requestedIds = new Set(
    input.statementTypes ??
      resolveStatementSelection(
        BANK_STATEMENT_CAPABILITIES.cathay,
        process.env,
        true,
      ).selectedIds,
  );
  const selectedIds = BANK_STATEMENT_CAPABILITIES.cathay.statementTypes
    .map((type) => type.id)
    .filter((typeId) => requestedIds.has(typeId));
  console.log("automation-progress: 0");

  page.on("dialog", async (dialog) => {
    console.warn("bank-dialog", { type: dialog.type() });
    await dialog.accept();
  });

  const authResult = await signInCathay(
    ctx,
    input.credentials,
    input.trustDevice,
  );
  let cathaySession = await createCathaySession(page);
  console.log("automation-progress: 25");

  const run = await runSelectedStatements(selectedIds, [
    {
      typeId: "domestic",
      run: async () => {
        console.log("combined-workflow-section-start", {
          section: "domestic",
        });
        const downloads = await retryableStage({
          name: "cathay-domestic-statements",
          session: ctx.session,
          reset: async () => {
            cathaySession = await createCathaySession(page);
          },
          run: async () =>
            downloadCathayStatements(
              page,
              input.dateRange,
              input.domesticAccountFilters ?? input.accountFilters,
              cathaySession,
            ),
        });
        return downloads.map((download) => ({
          type: "domestic" as const,
          ...download,
        }));
      },
      fileCount: (output) => (output as unknown[]).length,
    },
    {
      typeId: "foreign_currency",
      run: async () => {
        console.log("combined-workflow-section-start", {
          section: "foreign",
        });
        const downloads = await retryableStage({
          name: "cathay-foreign-statements",
          session: ctx.session,
          reset: async () => {
            cathaySession = await createCathaySession(page);
          },
          run: async () =>
            downloadCathayForeignStatements(
              page,
              input.dateRange,
              input.foreignAccountFilters ?? input.accountFilters,
              input.currencyFilters,
              cathaySession,
            ),
        });
        return downloads.map((download) => ({
          type: "foreign" as const,
          ...download,
        }));
      },
      fileCount: (output) => (output as unknown[]).length,
    },
  ]);
  const downloads = [
    ...((run.outputs.domestic as
      | z.infer<typeof domesticDownloadSchema>[]
      | undefined) ?? []),
    ...((run.outputs.foreign_currency as
      | z.infer<typeof foreignDownloadSchema>[]
      | undefined) ?? []),
  ];
  const statementTypes: Array<z.infer<typeof outputStatementTypeSchema>> =
    selectedIds.map((typeId) =>
      typeId === "foreign_currency" ? "foreign" : "domestic",
    );
  console.log("automation-progress: 100");

  return {
    dateRange: input.dateRange,
    statementTypes,
    usedExistingSession: authResult.usedExistingSession,
    count: downloads.length,
    downloads,
  };
}

export function createCathayAllStatementsWorkflow(
  workflowName = "cathayAllStatements",
) {
  return workflow(workflowName, {
    credentials: ["cathay_user_id", "cathay_account", "cathay_password"],
    input: inputSchema,
    output: outputSchema,
    handler: runCathayAllStatements,
  });
}

export default createCathayAllStatementsWorkflow();
