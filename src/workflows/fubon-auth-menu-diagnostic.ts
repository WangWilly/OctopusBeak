import {
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Frame, Page } from "playwright";
import { z } from "zod";
import { keepBrowserWindowOutOfForeground } from "./browser-interaction.ts";
import {
  authMenuDiagnosticOutputSchema,
  captureAuthMenuScreenshot,
  collectAuthMenuDiagnostic,
  executeAuthMenuDiagnostic,
  FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
  type AuthMenuDiagnosticOutput,
} from "./auth-menu-diagnostic.ts";
import {
  signInFubon,
  type FubonCredentials,
} from "./fubon-statements.ts";

const FUBON_AUTHENTICATED_MARKER_SELECTOR = [
  "#header_form\\:header_logout",
  "#menu_CDS",
  "#menu_CCC",
  "#menu_CLN",
  "a.task_CBOQU003.menu_CDS0102",
  "a.task_CCCQU002.menu_CCC02",
  "a.task_CLNQU001.menu_CLN02",
].join(", ");

export const fubonAuthMenuDiagnosticInputSchema = z.object({
  expandApprovedMenu: z.literal("loan").optional(),
});
export const fubonAuthMenuDiagnosticOutputSchema =
  authMenuDiagnosticOutputSchema;

export type FubonAuthMenuDiagnosticDependencies = Partial<{
  signIn: (
    page: Page,
    session: string,
    credentials: FubonCredentials,
  ) => Promise<void>;
  keepBrowserWindowOutOfForeground: (page: Page) => Promise<void>;
  isAuthenticated: (page: Page) => Promise<boolean>;
  collect: (page: Page) => Promise<
    Awaited<ReturnType<typeof collectAuthMenuDiagnostic>>
  >;
  captureScreenshot: (page: Page) => Promise<string>;
  expandApprovedMenu: (page: Page) => Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
}>;

/**
 * Expand only the user-approved Fubon loan menu. The fixed control id and
 * handler guard prevent this diagnostic from following a payment or submit
 * action even if the surrounding authenticated shell changes.
 */
export async function expandApprovedFubonLoanMenu(page: Page): Promise<void> {
  const headerFrame = page.frame({ name: "frame1" });
  if (!headerFrame) {
    console.warn("auth-menu-approved-expansion", {
      provider: "fubon",
      status: "frame-unavailable",
    });
    throw new Error("approved menu frame unavailable");
  }

  const control = headerFrame.locator("#menu_CLN").first();
  if (
    (await control.count()) !== 1 ||
    !(await control.isVisible().catch(() => false))
  ) {
    console.warn("auth-menu-approved-expansion", {
      provider: "fubon",
      status: "control-unavailable",
    });
    throw new Error("approved loan menu unavailable");
  }

  const href = (await control.getAttribute("href"))?.trim() ?? "";
  const onclick = (await control.getAttribute("onclick"))?.trim() ?? "";
  const hrefIsMenuOnly =
    href === "" || href === "#" || /^javascript:\s*(?:void\(0\))?;?$/iu.test(href);
  if (!hrefIsMenuOnly || !/switchTo\s*\([^)]*menu_CLN/iu.test(onclick)) {
    console.warn("auth-menu-approved-expansion", {
      provider: "fubon",
      status: "guard-rejected",
      hrefKind: href === "" ? "empty" : href.startsWith("javascript:") ? "script" : "route",
      handlerKind: /switchTo/iu.test(onclick) ? "switch-menu" : "other",
    });
    throw new Error("approved loan menu guard rejected control");
  }

  await control.click();
  await page.waitForTimeout(750);
  console.log("auth-menu-approved-expansion", {
    provider: "fubon",
    status: "expanded",
  });
}

/**
 * Fubon authenticated state is proven by the header/menu marker, not merely
 * by a frame named txnFrame: that frame also exists while the login form is
 * displayed. The probe only reads attached locator state.
 */
export async function hasAuthenticatedFubonMenu(
  page: Page,
): Promise<boolean> {
  const scopes: Array<Page | Frame> = [page];
  try {
    scopes.push(...page.frames());
  } catch {
    return false;
  }
  for (const scope of scopes) {
    try {
      if ((await scope.locator(FUBON_AUTHENTICATED_MARKER_SELECTOR).count()) > 0) {
        return true;
      }
    } catch {
      // The bank can recreate a frame during post-login handoff. Keep polling
      // without surfacing a provider URL or browser error.
    }
  }
  return false;
}

export async function runFubonAuthMenuDiagnostic(
  ctx: LibrettoWorkflowContext,
  rawInput: unknown,
  overrides: FubonAuthMenuDiagnosticDependencies = {},
): Promise<AuthMenuDiagnosticOutput> {
  const input = rawInput as typeof rawInput & {
    credentials: FubonCredentials;
    expandApprovedMenu?: "loan";
  };
  const { page, session } = ctx;
  // Keep the diagnostic on the exact auth seam used by fubon-all-statements.
  // That workflow deliberately has no startUrl: signInFubon owns the single
  // entry navigation. A second runner preload caused live auth to diverge.
  const authenticate = overrides.signIn ?? signInFubon;
  const keepWindowOutOfForeground =
    overrides.keepBrowserWindowOutOfForeground ??
    keepBrowserWindowOutOfForeground;
  const isAuthenticated =
    overrides.isAuthenticated ?? hasAuthenticatedFubonMenu;
  const collect = overrides.collect
    ? async () => await overrides.collect!(page)
    : undefined;
  const captureScreenshot = overrides.captureScreenshot
    ? async () => await overrides.captureScreenshot!(page)
    : undefined;
  const prepareMenu =
    input.expandApprovedMenu === "loan"
      ? async () =>
          await (overrides.expandApprovedMenu ?? expandApprovedFubonLoanMenu)(
            page,
          )
      : undefined;

  return await executeAuthMenuDiagnostic({
    page,
    provider: "fubon",
    contractVersion: FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
    authenticate: async () => {
      await authenticate(page, session, input.credentials);
      await keepWindowOutOfForeground(page);
    },
    isReady: async () => await isAuthenticated(page),
    timeoutMs: overrides.timeoutMs,
    pollIntervalMs: overrides.pollIntervalMs,
    prepareMenu,
    collect,
    captureScreenshot,
  });
}

export default workflow("fubonAuthMenuDiagnostic", {
  credentials: ["fubon_user_id", "fubon_account", "fubon_password"],
  input: fubonAuthMenuDiagnosticInputSchema,
  output: fubonAuthMenuDiagnosticOutputSchema,
  handler: async (ctx, input) =>
    await runFubonAuthMenuDiagnostic(ctx, input),
});
