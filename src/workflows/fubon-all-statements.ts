import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Page } from "playwright";
import { z } from "zod";
import {
  BANK_STATEMENT_CAPABILITIES,
  resolveStatementSelection,
} from "../lib/automation/statement-selection.js";
import {
  activateControlWithoutPointer,
  keepBrowserWindowOutOfForeground,
} from "./browser-interaction.js";
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
import { runSelectedStatements } from "./run-selected-statements.js";

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
  statements: fubonStatementsOutputSchema.optional(),
  creditCards: fubonCreditCardStatementsOutputSchema.optional(),
  loans: fubonLoanStatementsOutputSchema.optional(),
});

type Input = z.infer<typeof inputSchema> & {
  credentials: FubonCredentials;
};

async function keepFubonSessionAlive(page: Page): Promise<void> {
  const headerFrame = page.frame({ name: "frame1" });
  if (!headerFrame) return;

  await headerFrame.evaluate(() => {
    const bankWindow = globalThis as typeof globalThis & {
      doResume?: (forceCheck?: boolean) => unknown;
      loggedIn?: boolean;
    };
    if (bankWindow.loggedIn && typeof bankWindow.doResume === "function") {
      bankWindow.doResume(true);
    }
  });
}

function startFubonSessionKeepAlive(page: Page): () => void {
  void keepFubonSessionAlive(page).catch(() => undefined);
  const interval = setInterval(() => {
    void keepFubonSessionAlive(page).catch(() => undefined);
  }, 60_000);

  return () => {
    clearInterval(interval);
  };
}

async function signOutFubon(page: Page): Promise<void> {
  const headerFrame = page.frame({ name: "frame1" });
  if (!headerFrame) return;

  const logoutLink = headerFrame
    .locator("#header_form\\:header_logout")
    .first();
  if (!(await logoutLink.isVisible().catch(() => false))) return;

  await activateControlWithoutPointer(logoutLink);
  await headerFrame.evaluate(() => {
    const bankWindow = globalThis as typeof globalThis & {
      logoutNow?: () => unknown;
    };
    if (typeof bankWindow.logoutNow === "function") {
      bankWindow.logoutNow();
    }
  });
  await headerFrame
    .locator("a")
    .filter({ hasText: "登入" })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => undefined);
}

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
    console.log("automation-progress: 0");

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    await signInFubon(page, session, input.credentials);
    await keepBrowserWindowOutOfForeground(page);
    console.log("automation-progress: 20");

    const stopSessionKeepAlive = startFubonSessionKeepAlive(page);
    try {
      const selectedIds = resolveStatementSelection(
        BANK_STATEMENT_CAPABILITIES.fubon,
        process.env,
        true,
      ).selectedIds;
      const run = await runSelectedStatements(selectedIds, [
        {
          typeId: "deposit",
          run: () =>
            runSectionOutOfForeground(page, "statements", () =>
              runFubonStatements(page, input.statements),
            ),
        },
        {
          typeId: "credit_card",
          run: () =>
            runSectionOutOfForeground(page, "creditCards", () =>
              runFubonCreditCardStatements(page, input.creditCards),
            ),
        },
        {
          typeId: "loan",
          run: () =>
            runSectionOutOfForeground(page, "loans", () =>
              runFubonLoanStatements(page, input.loans),
            ),
        },
      ]);
      console.log("automation-progress: 100");

      return {
        statements: run.outputs.deposit as
          | z.infer<typeof fubonStatementsOutputSchema>
          | undefined,
        creditCards: run.outputs.credit_card as
          | z.infer<typeof fubonCreditCardStatementsOutputSchema>
          | undefined,
        loans: run.outputs.loan as
          | z.infer<typeof fubonLoanStatementsOutputSchema>
          | undefined,
      };
    } finally {
      stopSessionKeepAlive();
      await signOutFubon(page).catch((error: unknown) => {
        console.warn("fubon-logout-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  },
});
