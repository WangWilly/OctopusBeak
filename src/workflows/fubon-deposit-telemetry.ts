/**
 * Retained pure auth-race classifier for the deposit response diagnostics.
 * Authentication and bank navigation belong to the App-owned workflow host.
 */
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
    // The shared App auth seam may complete submit while a bounded CAPTCHA
    // reacquire loop observes the authenticated frame during a transition.
    // Accept only an independently observed authenticated marker.
    if (await isAuthenticated()) {
      return "authenticated-after-auth-race";
    }
    throw error;
  }
  throw new Error(
    "Fubon telemetry authentication finished without an authenticated marker.",
  );
}
