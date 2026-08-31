import { createHmac } from "node:crypto";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Page } from "playwright";
import { z } from "zod";
import {
  BANK_STATEMENT_CAPABILITIES,
  allSupportedStatementTypeIds,
} from "../lib/automation/statement-selection.js";
import {
  activateControlWithoutPointer,
  keepBrowserWindowOutOfForeground,
} from "./browser-interaction.ts";
import {
  fubonCreditCardStatementsInputSchema,
  fubonCreditCardStatementsOutputSchema,
  runFubonCreditCardStatements,
} from "./fubon-credit-card-statements.ts";
import {
  fubonLoanStatementsInputSchema,
  fubonLoanStatementsOutputSchema,
  runFubonLoanStatements,
} from "./fubon-loan-statements.ts";
import {
  type FubonCredentials,
  fubonStatementsInputSchema,
  fubonStatementsOutputSchema,
  runFubonStatements,
  signInFubon,
} from "./fubon-statements.ts";
import { runSelectedStatements } from "./run-selected-statements.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import { FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../lib/automation/server/config-files.ts";

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
  componentResults: z.array(
    z.object({
      typeId: z.string(),
      status: z.enum(["success", "failed", "skipped"]),
      skipReason: z.enum(["absent", "not_selected"]).optional(),
      fileCount: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
    }),
  ),
});

type Input = z.infer<typeof inputSchema> & {
  credentials: FubonCredentials;
};

const FUBON_CREDIT_CARD_IDENTITY_EPOCH =
  "fubon-credit-card-human-attested-v2" as const;

function normalizedFubonLoginPart(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toUpperCase();
}

function fubonLoginScope(credentials: FubonCredentials): readonly [string, string] | null {
  const userId = normalizedFubonLoginPart(credentials.fubon_user_id);
  const account = normalizedFubonLoginPart(credentials.fubon_account);
  if (!userId || !account) return null;
  return [userId, account];
}

function hmacFubonIdentity(secret: string, value: unknown): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(value))
    .digest("base64url");
}

/**
 * Derive the source connection and portfolio attestation in memory from the
 * device-owned managed secret and the stable Fubon login scope (user ID plus
 * online-banking code; password rotation must not create a new account). The
 * login values and managed secret are never returned, logged, or persisted. The
 * managed secret is intentionally part of both HMACs: moving the encrypted
 * credentials file with the same secret preserves identity, while a fresh
 * device secret deliberately starts a new portable source scope.
 */
export function deriveFubonCanonicalHumanAttestation(
  credentials: FubonCredentials,
  managedSecret: string,
): {
  sourceConnectionKey: string;
  identityEpochKey: typeof FUBON_CREDIT_CARD_IDENTITY_EPOCH;
  humanAttestedAccountKey: string;
} | undefined {
  const secret = managedSecret.trim();
  const scope = fubonLoginScope(credentials);
  if (!secret || !scope) return undefined;
  const scopeDigest = hmacFubonIdentity(secret, [
    "fubon-login-scope-v2",
    ...scope,
  ]);
  const sourceConnectionKey = `fubon_connection_${scopeDigest}`;
  const humanAttestedAccountKey = `portfolio_${hmacFubonIdentity(secret, [
    "fubon-primary-cardholder-portfolio-v2",
    sourceConnectionKey,
    ...scope,
  ])}`;
  return {
    sourceConnectionKey,
    identityEpochKey: FUBON_CREDIT_CARD_IDENTITY_EPOCH,
    humanAttestedAccountKey,
  };
}

function optionalFubonManagedSecret(): string | undefined {
  const secret = process.env[FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]?.trim();
  return secret || undefined;
}

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

const fubonAllStatementsDependencies = {
  signInFubon,
  keepBrowserWindowOutOfForeground,
  startFubonSessionKeepAlive,
  runSectionOutOfForeground,
  runFubonStatements,
  runFubonCreditCardStatements,
  runFubonLoanStatements,
  signOutFubon,
};

const FUBON_SOURCE_LEDGER_DIR_ENV = "OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR";
const FUBON_FINANCIAL_LEDGER_DIR_ENV =
  "OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR";
const FUBON_LEGACY_FINANCIAL_LEDGER_DIR_ENV =
  "OCTOPUSBEAK_CANONICAL_LEDGER_DIR";

function readFubonLedgerDirectory(envName: string): string | undefined {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error(`Invalid Fubon ledger directory in ${envName}.`);
  }
  return raw;
}

/**
 * Resolve the combined workflow's two ledger destinations.
 *
 * Source evidence is always enabled. The old generic canonical-ledger
 * variable is retained only as a financial opt-in alias; it must never be
 * silently reused as the source destination by this caller. If both financial
 * aliases are configured with different paths, fail before login so the run
 * cannot write to an unintended ledger.
 */
function resolveFubonLedgerOverrides(): {
  canonicalLedgerDir: string;
  canonicalFinancialLedgerDir?: string;
} {
  const sourceLedgerDir =
    readFubonLedgerDirectory(FUBON_SOURCE_LEDGER_DIR_ENV) ??
    readFubonLedgerDirectory("LEDGER_DIR") ??
    DEFAULT_LEDGER_DIR;
  const financialLedgerDirs: Array<readonly [string, string]> = [];
  for (const [envName, directory] of [
    [
      FUBON_FINANCIAL_LEDGER_DIR_ENV,
      readFubonLedgerDirectory(FUBON_FINANCIAL_LEDGER_DIR_ENV),
    ] as const,
    [
      FUBON_LEGACY_FINANCIAL_LEDGER_DIR_ENV,
      readFubonLedgerDirectory(FUBON_LEGACY_FINANCIAL_LEDGER_DIR_ENV),
    ] as const,
  ]) {
    if (directory !== undefined) financialLedgerDirs.push([envName, directory]);
  }
  const uniqueFinancialLedgerDirs = [
    ...new Set(financialLedgerDirs.map(([, directory]) => directory)),
  ];
  if (uniqueFinancialLedgerDirs.length > 1) {
    throw new Error(
      `Ambiguous Fubon financial ledger directories configured in ${financialLedgerDirs
        .map(([envName]) => envName)
        .join(", ")}.`,
    );
  }

  return {
    canonicalLedgerDir: sourceLedgerDir,
    ...(uniqueFinancialLedgerDirs[0]
      ? { canonicalFinancialLedgerDir: uniqueFinancialLedgerDirs[0] }
      : {}),
  };
}

export async function runFubonAllStatements(
  ctx: LibrettoWorkflowContext,
  rawInput: unknown,
  overrides: Partial<typeof fubonAllStatementsDependencies> = {},
) {
  const {
    signInFubon,
    keepBrowserWindowOutOfForeground,
    startFubonSessionKeepAlive,
    runSectionOutOfForeground,
    runFubonStatements,
    runFubonCreditCardStatements,
    runFubonLoanStatements,
    signOutFubon,
  } = { ...fubonAllStatementsDependencies, ...overrides };
  const input = rawInput as Input;
  const { page, session } = ctx;
  console.log("automation-progress: 0");
  // Fubon exposes product availability at runtime. Persisted Settings selections
  // are intentionally ignored; always probe every currently supported component
  // in registry order and let explicit provider absence become skipped_absent.
  const selectedIds = allSupportedStatementTypeIds(
    BANK_STATEMENT_CAPABILITIES.fubon,
  );
  const ledgerOverrides = resolveFubonLedgerOverrides();
  const managedSecret = optionalFubonManagedSecret();
  const canonicalHumanAttestation = managedSecret
    ? deriveFubonCanonicalHumanAttestation(input.credentials, managedSecret)
    : undefined;
  const creditCardInput = canonicalHumanAttestation
    ? { ...input.creditCards, canonicalHumanAttestation }
    : { ...input.creditCards, canonicalHumanAttestation: undefined };

  await signInFubon(page, session, input.credentials);
  await keepBrowserWindowOutOfForeground(page);
  console.log("automation-progress: 20");

  const stopSessionKeepAlive = startFubonSessionKeepAlive(page);
  try {
    const run = await runSelectedStatements(selectedIds, [
      {
        typeId: "deposit",
        run: () =>
          runSectionOutOfForeground(page, "statements", () =>
            runFubonStatements(page, input.statements, ledgerOverrides),
          ),
      },
      {
        typeId: "credit_card",
        run: () =>
          runSectionOutOfForeground(page, "creditCards", () =>
            runFubonCreditCardStatements(page, creditCardInput, {
              ...(ledgerOverrides.canonicalFinancialLedgerDir
                ? {
                    canonicalFinancialLedgerDir:
                      ledgerOverrides.canonicalFinancialLedgerDir,
                  }
                : {}),
              ...(managedSecret
                ? { panFingerprintKey: { secret: managedSecret } }
                : {}),
            }),
          ),
      },
      {
        typeId: "loan",
        run: () =>
          runSectionOutOfForeground(page, "loans", () =>
            runFubonLoanStatements(page, input.loans, {
              ...ledgerOverrides,
              sourceConnectionScope:
                fubonLoginScope(input.credentials)?.join("\u0000") ??
                "fubon-loan-workflow",
            }),
          ),
      },
    ]);
    console.log("automation-progress: 100");

    return {
      statements: run.outputs.deposit as
        z.infer<typeof fubonStatementsOutputSchema> | undefined,
      creditCards: run.outputs.credit_card as
        z.infer<typeof fubonCreditCardStatementsOutputSchema> | undefined,
      loans: run.outputs.loan as
        z.infer<typeof fubonLoanStatementsOutputSchema> | undefined,
      componentResults: run.results,
    };
  } finally {
    stopSessionKeepAlive();
    await signOutFubon(page).catch((error: unknown) => {
      console.warn("fubon-logout-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export default workflow("fubonAllStatements", {
  credentials: ["fubon_user_id", "fubon_account", "fubon_password"],
  input: inputSchema,
  output: outputSchema,
  handler: runFubonAllStatements,
});
