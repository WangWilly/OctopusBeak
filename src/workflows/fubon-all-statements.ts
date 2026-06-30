import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Page } from "playwright";
import { z } from "zod";
import { keepBrowserWindowOutOfForeground } from "./browser-interaction.js";
import {
  fubonCreditCardStatementsInputSchema,
  fubonCreditCardStatementsOutputSchema,
  runFubonCreditCardStatements,
} from "./fubon-credit-card-statements.js";
import {
  fubonLoanStatementsInputSchema,
  fubonLoanStatementsOutputSchema,
  runFubonLoanStatements,
} from "./fubon-loan-statements.js";
import {
  type FubonCredentials,
  fubonStatementsInputSchema,
  fubonStatementsOutputSchema,
  runFubonStatements,
  signInFubon,
} from "./fubon-statements.js";

const inputSchema = z.object({
  statements: fubonStatementsInputSchema.default(() =>
    fubonStatementsInputSchema.parse({}),
  ),
  creditCards: fubonCreditCardStatementsInputSchema.default(() =>
    fubonCreditCardStatementsInputSchema.parse({}),
  ),
  loans: fubonLoanStatementsInputSchema.default(() =>
    fubonLoanStatementsInputSchema.parse({}),
  ),
});

const outputSchema = z.object({
  statements: fubonStatementsOutputSchema,
  creditCards: fubonCreditCardStatementsOutputSchema,
  loans: fubonLoanStatementsOutputSchema,
});

type Input = z.infer<typeof inputSchema> & {
  credentials: FubonCredentials;
};

async function runSectionOutOfForeground<T>(
  page: Page,
  section: string,
  run: () => Promise<T>,
): Promise<T> {
  console.log("combined-workflow-section-start", { section });
  await keepBrowserWindowOutOfForeground(page);

  const keepOutOfForeground = setInterval(() => {
    void keepBrowserWindowOutOfForeground(page).catch(() => undefined);
  }, 1_000);
  try {
    return await run();
  } finally {
    clearInterval(keepOutOfForeground);
    await keepBrowserWindowOutOfForeground(page).catch(() => undefined);
  }
}

export default workflow("fubonAllStatements", {
  credentials: ["fubon_user_id", "fubon_account", "fubon_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as Input;
    const { page, session } = ctx;

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    await signInFubon(page, session, input.credentials);
    await keepBrowserWindowOutOfForeground(page);

    const statements = await runSectionOutOfForeground(
      page,
      "statements",
      () => runFubonStatements(page, input.statements),
    );

    const creditCards = await runSectionOutOfForeground(
      page,
      "creditCards",
      () => runFubonCreditCardStatements(page, input.creditCards),
    );

    const loans = await runSectionOutOfForeground(page, "loans", () =>
      runFubonLoanStatements(page, input.loans),
    );

    return {
      statements,
      creditCards,
      loans,
    };
  },
});
