import { createHash } from "node:crypto";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import { TDCC_NAMESPACE } from "../ledger/canonical/tdcc-settlement-contract.ts";
import type { TdccDeviceIdentity, TdccSession, TdccSignInDetails } from "./tdcc-epassbook-client.ts";

/** A session token with the time of the sign-in that issued it. */
export type TdccIssuedSession = TdccSession & Readonly<{ issuedAt: string }>;

export type TdccConnection = Readonly<{
  sourceConnectionKey: `sha256:${string}`;
  identityEpochKey: `sha256:${string}`;
}>;

/**
 * What a run may know before it signs in: the connection it collects for, the
 * registered device, and the last saved session. The password is not part of
 * it; a run asks for it only when TDCC no longer accepts the saved session.
 */
export type TdccSessionLease =
  | Readonly<{
    status: "ready";
    connection: TdccConnection;
    device: TdccDeviceIdentity;
    session: TdccIssuedSession | null;
  }>
  | Readonly<{ status: "device-registration-required" }>;

export type TdccSignInLease =
  | Readonly<{ status: "ready"; details: TdccSignInDetails }>
  | Readonly<{ status: "device-registration-required" }>;

/**
 * The host-owned port through which a TDCC run reaches its Authentication
 * secrets (ADR 0041). The host keeps them in credentials.json; none of them
 * enters the workflow input or environment.
 */
export type TdccSessionPort = Readonly<{
  open(): Promise<TdccSessionLease>;
  signInDetails(): Promise<TdccSignInLease>;
  /**
   * Records a rotated session for the leased device. It does not wait for the
   * host, so a run that fails or is cancelled right after still keeps it. The
   * host ignores it once the device was registered again or reset.
   */
  saveSession(session: TdccIssuedSession): void;
}>;

/** The Source connection belongs to the TDCC sign-in identifier, never to the device or session. */
export function tdccConnection(userId: string): TdccConnection {
  const sourceConnectionKey = deriveSourceConnectionIdentityKey(TDCC_NAMESPACE, userId);
  const identityEpochKey = `sha256:${createHash("sha256")
    .update(["tdcc-identity-epoch-v1", sourceConnectionKey].join("\u0000"))
    .digest("base64url")}` as const;
  return { sourceConnectionKey, identityEpochKey };
}
