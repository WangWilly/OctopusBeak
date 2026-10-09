import type {
  TdccClient,
  TdccOtpChannel,
  TdccSignInDetails,
} from "./tdcc-epassbook-client.ts";

export type TdccRegistrationResult =
  | { kind: "already-trusted" }
  | { kind: "registered"; channels: readonly TdccOtpChannel[] };

type RegistrationState =
  | { step: "sign-in" }
  | { step: "request-code"; channel: TdccOtpChannel; verified: readonly TdccOtpChannel[] }
  | { step: "verify-code"; channel: TdccOtpChannel; verified: readonly TdccOtpChannel[] }
  | { step: "done"; result: TdccRegistrationResult };

export type TdccRegistrationPorts = Readonly<{
  client: Pick<TdccClient, "getInitialToken" | "login" | "requestEmailOtp" | "requestMobileOtp" | "verifyOtp">;
  details: TdccSignInDetails;
  /** Returns the code the person typed. The value is used once and never stored. */
  readOtp: (channel: TdccOtpChannel) => Promise<string>;
}>;

/**
 * Source device registration: sign in, and when TDCC does not trust this
 * device, walk its Email OTP then SMS OTP sequence until it does.
 * TdccError (for example otp-expired) propagates to the caller.
 */
export async function registerTdccDevice(ports: TdccRegistrationPorts): Promise<TdccRegistrationResult> {
  let state: RegistrationState = { step: "sign-in" };
  while (state.step !== "done") state = await advance(state, ports);
  return state.result;
}

async function advance(state: RegistrationState, ports: TdccRegistrationPorts): Promise<RegistrationState> {
  const { client, details, readOtp } = ports;
  switch (state.step) {
    case "sign-in": {
      await client.getInitialToken();
      const outcome = await client.login(details);
      return outcome.kind === "trusted"
        ? { step: "done", result: { kind: "already-trusted" } }
        : { step: "request-code", channel: "email", verified: [] };
    }
    case "request-code": {
      if (state.channel === "email") await client.requestEmailOtp(details.userId);
      else await client.requestMobileOtp(details.userId);
      return { step: "verify-code", channel: state.channel, verified: state.verified };
    }
    case "verify-code": {
      const outcome = await client.verifyOtp(details.userId, await readOtp(state.channel), state.channel);
      const verified = [...state.verified, state.channel];
      return outcome.kind === "sms-verification-required"
        ? { step: "request-code", channel: "sms", verified }
        : { step: "done", result: { kind: "registered", channels: verified } };
    }
    case "done":
      return state;
  }
}
