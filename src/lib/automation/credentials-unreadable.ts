import type { AutomationCredentialStatus, SignInDataStatus } from "$lib/desktop/api.ts";

/**
 * Whether the stored Sign-in Details could not be read. Only an unreadable
 * credentials file marks a credential `read_failed`, and it marks them all
 * (ADR 0149), so this holds even when no source is enabled.
 */
export function credentialsUnreadable(states: Readonly<Record<string, AutomationCredentialStatus>> | undefined): boolean {
  return Object.values(states ?? {}).includes("read_failed");
}

/** What Settings says beside Reset ledger and its sign-in data box; an unknown status says nothing extra. */
export function signInDataGuidance(status: SignInDataStatus | null): Readonly<{ unreadableHint: boolean; resetWarning: boolean }> {
  return {
    unreadableHint: status?.credentials === "undecodable",
    resetWarning: status?.clearRequiresFinancialDataDeletion === true,
  };
}
