import {
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Frame, Page } from "playwright";
import { z } from "zod";
import {
  authMenuDiagnosticOutputSchema,
  collectAuthMenuDiagnostic,
  executeAuthMenuDiagnostic,
  YUANTA_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
  type AuthMenuDiagnosticOutput,
} from "./auth-menu-diagnostic.ts";
import {
  authenticateYuantaBank,
  isYuantaSignedIn,
  type YuantaCredentials,
  YUANTA_ENTRY_URL,
} from "./yuanta-auth.ts";

export const yuantaAuthMenuDiagnosticInputSchema = z.object({
  expandApprovedMenu: z.literal("function-overview").optional(),
});
export const yuantaAuthMenuDiagnosticOutputSchema =
  authMenuDiagnosticOutputSchema;

export type YuantaAuthMenuDiagnosticDependencies = Partial<{
  authenticate: (
    ctx: LibrettoWorkflowContext,
    credentials: YuantaCredentials,
  ) => Promise<unknown>;
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
 * Expand only the user-approved Yuanta function overview control. Candidate
 * controls are rejected when they carry navigation, form submission, or
 * transaction-like handlers; the accepted interaction only reveals a menu.
 */
export async function expandApprovedYuantaFunctionOverview(
  page: Page,
): Promise<void> {
  const scopes: Array<Page | Frame> = [page, ...page.frames()];
  for (const scope of scopes) {
    const control = scope.getByText("功能總覽", { exact: true }).first();
    if (
      (await control.count().catch(() => 0)) === 0 ||
      !(await control.isVisible().catch(() => false))
    ) {
      continue;
    }

    const href = (await control.getAttribute("href"))?.trim() ?? "";
    const formAction =
      (await control.getAttribute("formaction"))?.trim() ?? "";
    const type = (await control.getAttribute("type"))?.trim().toLowerCase() ?? "";
    const onclick = (await control.getAttribute("onclick"))?.trim() ?? "";
    if (
      href !== "" ||
      formAction !== "" ||
      type === "submit" ||
      /(?:submit|transfer|payment|repay|doAction)\s*\(/iu.test(onclick)
    ) {
      console.warn("auth-menu-approved-expansion", {
        provider: "yuanta",
        status: "guard-rejected",
      });
      throw new Error("approved function overview guard rejected control");
    }

    await control.click();
    await page.waitForTimeout(750);
    console.log("auth-menu-approved-expansion", {
      provider: "yuanta",
      status: "expanded",
    });
    return;
  }
  console.warn("auth-menu-approved-expansion", {
    provider: "yuanta",
    status: "control-unavailable",
  });
  throw new Error("approved function overview unavailable");
}

const YUANTA_MENU_FRAME_NAMES = ["fmenu", "fmain"] as const;

/**
 * Yuanta's authenticated shell can retain its frame names while the menu is
 * still empty. Read visible anchors from the menu frames so a signed-in
 * marker alone cannot make the diagnostic report `ready`.
 */
export async function hasVisibleYuantaMenuAnchor(
  page: Page,
): Promise<boolean> {
  for (const frameName of YUANTA_MENU_FRAME_NAMES) {
    let frame: Frame | null;
    try {
      frame = page.frame({ name: frameName });
    } catch {
      continue;
    }
    if (!frame) continue;

    let anchors;
    try {
      anchors = frame.locator("a");
      const count = await anchors.count();
      for (let index = 0; index < count; index += 1) {
        if (await anchors.nth(index).isVisible().catch(() => false)) {
          return true;
        }
      }
    } catch {
      // A bank frame can be detached while it is rebuilding its menu. The
      // bounded readiness poll will inspect the replacement frame.
    }
  }
  return false;
}

export async function hasReadyYuantaMenu(page: Page): Promise<boolean> {
  if (!(await isYuantaSignedIn(page))) return false;
  return await hasVisibleYuantaMenuAnchor(page);
}

export async function runYuantaAuthMenuDiagnostic(
  ctx: LibrettoWorkflowContext,
  rawInput: unknown,
  overrides: YuantaAuthMenuDiagnosticDependencies = {},
): Promise<AuthMenuDiagnosticOutput> {
  const input = rawInput as typeof rawInput & {
    credentials: YuantaCredentials;
    expandApprovedMenu?: "function-overview";
  };
  const { page } = ctx;
  // Use the same authentication function and startUrl as the proven
  // yuanta-all-statements workflow; only the post-auth diagnostic exit differs.
  const authenticate = overrides.authenticate ?? authenticateYuantaBank;
  const isAuthenticated = overrides.isAuthenticated ?? hasReadyYuantaMenu;
  const collect = overrides.collect
    ? async () => await overrides.collect!(page)
    : undefined;
  const captureScreenshot = overrides.captureScreenshot
    ? async () => await overrides.captureScreenshot!(page)
    : undefined;
  const prepareMenu =
    input.expandApprovedMenu === "function-overview"
      ? async () =>
          await (
            overrides.expandApprovedMenu ??
            expandApprovedYuantaFunctionOverview
          )(page)
      : undefined;

  return await executeAuthMenuDiagnostic({
    page,
    provider: "yuanta",
    contractVersion: YUANTA_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
    authenticate: async () => {
      await authenticate(ctx, input.credentials);
    },
    isReady: async () => await isAuthenticated(page),
    timeoutMs: overrides.timeoutMs,
    pollIntervalMs: overrides.pollIntervalMs,
    prepareMenu,
    collect,
    captureScreenshot,
  });
}

export default workflow("yuantaAuthMenuDiagnostic", {
  startUrl: YUANTA_ENTRY_URL,
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: yuantaAuthMenuDiagnosticInputSchema,
  output: yuantaAuthMenuDiagnosticOutputSchema,
  handler: async (ctx, input) =>
    await runYuantaAuthMenuDiagnostic(ctx, input),
});
