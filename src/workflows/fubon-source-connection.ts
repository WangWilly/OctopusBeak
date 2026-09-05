import {
  assembleStableSourceLoginScope,
  deriveSourceConnectionIdentityKey,
} from "../ledger/canonical/source-connection-identity.ts";

/**
 * The stable Fubon login scope shared by every product workflow.
 *
 * The separator is part of this workflow contract: the loan canonical adapter
 * accepts a string scope, so deposit, loan, and combined runs must hand it the
 * exact same normalized representation. Passwords, OTPs, solver/session
 * state, and query ranges are deliberately not accepted here.
 */
export type FubonStableLoginCredentials = {
  fubon_user_id?: string;
  fubon_account?: string;
};

export function fubonStableLoginScope(
  credentials: FubonStableLoginCredentials,
): string | undefined {
  return assembleStableSourceLoginScope(
    [
      { name: "fubon_user_id", value: credentials.fubon_user_id },
      { name: "fubon_account", value: credentials.fubon_account },
    ],
    "undefined",
  );
}

/**
 * Derive the portable source identity for one Fubon login. This is
 * deterministic across machines and changes only when the stable login
 * identifiers change.
 */
export function deriveFubonSourceConnectionKey(
  credentials: FubonStableLoginCredentials,
): string | undefined {
  const scope = fubonStableLoginScope(credentials);
  return scope
    ? deriveSourceConnectionIdentityKey("fubon", scope)
    : undefined;
}
