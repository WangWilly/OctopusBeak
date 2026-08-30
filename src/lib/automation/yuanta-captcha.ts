/**
 * A host-started solver retry may let the provider adapter own the
 * post-submit dialog. Direct or human resumes intentionally omit this
 * capability and keep the workflow's fail-fast dialog handler.
 */
export const YUANTA_DIALOG_OWNER_ENV = "OCTOPUSBEAK_YUANTA_DIALOG_OWNER";
export const YUANTA_HOST_DIALOG_OWNER_PREFIX = "provider-verification-host:";

export function yuantaHostDialogOwner(session: string): string {
  return YUANTA_HOST_DIALOG_OWNER_PREFIX + session;
}

export const YUANTA_DIALOG_DISMISS_TIMEOUT_MS = 500;
