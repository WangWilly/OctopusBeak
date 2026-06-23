import { workflow, type LibrettoWorkflowContext } from "libretto";
import { z } from "zod";
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

    console.log("combined-workflow-section-start", { section: "statements" });
    const statements = await runFubonStatements(page, input.statements);

    console.log("combined-workflow-section-start", {
      section: "creditCards",
    });
    const creditCards = await runFubonCreditCardStatements(
      page,
      input.creditCards,
    );

    console.log("combined-workflow-section-start", { section: "loans" });
    const loans = await runFubonLoanStatements(page, input.loans);

    return {
      statements,
      creditCards,
      loans,
    };
  },
});
