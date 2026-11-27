/** Set in the tab's session storage across the one reload; cleared once a snapshot is accepted again. */
export const RUNTIME_RELOADED_KEY = "octopusbeak-automation-runtime-reloaded";

type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** What the renderer does once it has failed to read or accept a runtime snapshot. */
export type AutomationRuntimeRecoveryStep = "reloading" | "unavailable";

export type AutomationRuntimeRecovery = Readonly<{
  failed(): AutomationRuntimeRecoveryStep;
  /** A snapshot was read and accepted, so a later failure may reload once again. */
  accepted(): void;
  /** The person asked to try again from the error state. */
  retry(): void;
}>;

/**
 * The renderer's answer to a runtime snapshot it cannot read or accept: it
 * reloads the window, which leaves the host and any running collection alone
 * (ADR 0161). A failure after that reload, before any snapshot was accepted,
 * shows the error state instead of reloading again, so a renderer that stays
 * broken cannot loop. So does a storage that cannot record the reload.
 */
export function createAutomationRuntimeRecovery(port: Readonly<{
  /** May throw, or be absent, when the browser refuses storage. */
  storage(): SessionStore | null | undefined;
  reload(): void;
}>): AutomationRuntimeRecovery {
  const store = (): SessionStore | null => {
    try {
      return port.storage() ?? null;
    } catch {
      return null;
    }
  };
  const remember = (reloaded: boolean): boolean => {
    try {
      const storage = store();
      if (!storage) return false;
      if (reloaded) storage.setItem(RUNTIME_RELOADED_KEY, "1");
      else storage.removeItem(RUNTIME_RELOADED_KEY);
      return true;
    } catch {
      return false;
    }
  };
  let reloadedOnce = (() => {
    try {
      return store()?.getItem(RUNTIME_RELOADED_KEY) === "1";
    } catch {
      return false;
    }
  })();
  let reloading = false;

  return {
    failed() {
      if (reloading) return "reloading";
      if (reloadedOnce || !remember(true)) return "unavailable";
      reloading = true;
      port.reload();
      return "reloading";
    },
    accepted() {
      if (!reloadedOnce) return;
      reloadedOnce = false;
      remember(false);
    },
    retry() {
      port.reload();
    },
  };
}
