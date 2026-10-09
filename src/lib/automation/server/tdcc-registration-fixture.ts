import { TDCC_BASE_URL, type TdccClientOptions } from "../../../workflows/tdcc-epassbook-client.ts";

/**
 * A scripted TDCC for the development CDP fixture, so the registration
 * screens can be exercised without the network. The first registration of
 * the session has its email code rejected; every later one asks for an
 * email code, then an SMS code, and then trusts the device.
 */
export function createTdccRegistrationFixtureFetch(options: Readonly<{ delayMs?: number }> = {}): NonNullable<TdccClientOptions["fetch"]> {
  const delayMs = options.delayMs ?? 400;
  let trusted = false;
  let registrations = 0;
  const reply = (body: unknown, header: Record<string, unknown> = {}) =>
    Response.json({ responseHeader: { returnCode: "0000", ...header }, responseBody: body });
  return async (url, init) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const body = (JSON.parse(String(init?.body)) as { requestBody: Record<string, string> }).requestBody;
    switch (String(url).slice(TDCC_BASE_URL.length)) {
      case "CM001":
        return reply({ tokenID: "fixture-initial-token" });
      case "AU001":
        return trusted
          ? reply({ tokenID: "fixture-session-token", richUrl: "https://fixture.invalid/rich", isDiffDevice: "N" })
          : reply({}, { returnCode: "D0005", returnMsg: "new device" });
      case "AU013":
        registrations += 1;
        return reply({});
      case "AU014":
        return reply({});
      case "AU015":
        if (registrations === 1) return reply({}, { returnCode: "E1234", returnMsg: "wrong code" });
        if (body.sendType === "MOBILE") trusted = true;
        return reply({ isMobileValid: body.sendType === "MOBILE" ? "Y" : "N" });
      default:
        return reply({}, { returnCode: "E9999", returnMsg: "not in the fixture" });
    }
  };
}
