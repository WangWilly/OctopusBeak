import { workflow, type LibrettoWorkflowContext } from "libretto";
import {
  captureFubonDepositTelemetry,
  fubonDepositTelemetryInputSchema,
  fubonDepositTelemetryOutputSchema,
  signInFubon,
  type FubonCredentials,
} from "./fubon-statements.ts";

const FUBON_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";

async function hasAuthenticatedFubonFrame(
  page: LibrettoWorkflowContext["page"],
): Promise<boolean> {
  for (const frame of page.frames()) {
    if (
      (await frame
        .locator("#header_form\\:header_logout")
        .count()
        .catch(() => 0)) > 0
    ) {
      return true;
    }
  }
  return false;
}

export async function reconcileFubonTelemetryAuthentication(
  authenticate: () => Promise<void>,
  isAuthenticated: () => Promise<boolean>,
): Promise<
  | "already-authenticated"
  | "authenticated-after-auth-race"
  | "fresh-authenticated"
> {
  if (await isAuthenticated()) return "already-authenticated";
  try {
    await authenticate();
    if (await isAuthenticated()) return "fresh-authenticated";
  } catch (error) {
    // The shared auth seam can finish the bank submit while its bounded
    // CAPTCHA reacquire loop observes the now-authenticated frame as a
    // transient "login document not ready" state. Never retry login here:
    // accept only an independently observed authenticated marker.
    if (await isAuthenticated()) {
      console.warn("fubon-telemetry-auth-handoff", {
        status: "authenticated-after-auth-race",
      });
      return "authenticated-after-auth-race";
    }
    throw error;
  }
  throw new Error(
    "Fubon telemetry authentication finished without an authenticated marker.",
  );
}

async function ensureFubonTelemetryAuthentication(
  page: LibrettoWorkflowContext["page"],
  session: string,
  credentials: FubonCredentials,
) {
  return await reconcileFubonTelemetryAuthentication(
    async () => await signInFubon(page, session, credentials),
    async () => await hasAuthenticatedFubonFrame(page),
  );
}

type Input = typeof fubonDepositTelemetryInputSchema._output & {
  credentials: FubonCredentials;
};

export default workflow("fubonDepositTelemetry", {
  startUrl: FUBON_ENTRY_URL,
  credentials: ["fubon_user_id", "fubon_account", "fubon_password"],
  input: fubonDepositTelemetryInputSchema,
  output: fubonDepositTelemetryOutputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const { page, session } = ctx;
    const input = rawInput as Input;
    await ensureFubonTelemetryAuthentication(page, session, input.credentials);
    return await captureFubonDepositTelemetry(page, input);
  },
});
