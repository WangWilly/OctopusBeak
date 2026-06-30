import { workflow, type LibrettoWorkflowContext } from "libretto";
import { z } from "zod";
import {
  type CathayCredentials,
  createCathaySession,
  downloadCathayStatements,
  signInCathay,
} from "./cathay-statements.js";
import { downloadCathayForeignStatements } from "./cathay-foreign-statements.js";

const statementTypeSchema = z.enum(["domestic", "foreign"]);
const defaultStatementTypes: StatementType[] = ["domestic", "foreign"];

const dateRangeSchema = z.enum([
  "one_week",
  "one_month",
  "three_months",
  "six_months",
  "one_year",
]);

type StatementType = z.infer<typeof statementTypeSchema>;

function createInputSchema(defaultTypes: StatementType[]) {
  return z.object({
    statementTypes: z.array(statementTypeSchema).min(1).default(defaultTypes),
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
  statementTypes: z.array(statementTypeSchema),
  usedExistingSession: z.boolean(),
  count: z.number().int().nonnegative(),
  downloads: z.array(z.union([domesticDownloadSchema, foreignDownloadSchema])),
});

export function createCathayAllStatementsWorkflow(
  workflowName = "cathayAllStatements",
  defaultTypes: StatementType[] = defaultStatementTypes,
) {
  const inputSchema = createInputSchema(defaultTypes);

  return workflow(workflowName, {
    credentials: ["cathay_user_id", "cathay_account", "cathay_password"],
    input: inputSchema,
    output: outputSchema,
    handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
      const input = rawInput as z.infer<typeof inputSchema> & {
        credentials: CathayCredentials;
      };
      const { page } = ctx;
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
      const cathaySession = await createCathaySession(page);
      const statementTypes = Array.from(new Set(input.statementTypes));
      const downloads = [];
      console.log("automation-progress: 25");

      if (statementTypes.includes("domestic")) {
        console.log("combined-workflow-section-start", { section: "domestic" });
        const domesticDownloads = await downloadCathayStatements(
          page,
          input.dateRange,
          input.domesticAccountFilters ?? input.accountFilters,
          cathaySession,
        );
        downloads.push(
          ...domesticDownloads.map((download) => ({
            type: "domestic" as const,
            ...download,
          })),
        );
      }
      console.log("automation-progress: 60");

      if (statementTypes.includes("foreign")) {
        console.log("combined-workflow-section-start", { section: "foreign" });
        const foreignDownloads = await downloadCathayForeignStatements(
          page,
          input.dateRange,
          input.foreignAccountFilters ?? input.accountFilters,
          input.currencyFilters,
          cathaySession,
        );
        downloads.push(
          ...foreignDownloads.map((download) => ({
            type: "foreign" as const,
            ...download,
          })),
        );
      }
      console.log("automation-progress: 100");

      return {
        dateRange: input.dateRange,
        statementTypes,
        usedExistingSession: authResult.usedExistingSession,
        count: downloads.length,
        downloads,
      };
    },
  });
}

export default createCathayAllStatementsWorkflow();
