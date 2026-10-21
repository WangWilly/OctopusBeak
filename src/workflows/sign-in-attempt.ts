import type { Dialog, Page } from "playwright";
import { withAbort } from "./abort.ts";

export type SignInAttempt = Readonly<{
  submit: () => Promise<void>;
  /** Resolves once the provider shows its signed-in page; the signal ends the probe. */
  waitForSuccess: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /**
   * Answers one browser dialog. An Error ends the attempt with it; null
   * means the dialog was handled and the attempt keeps waiting.
   */
  handleDialog: (dialog: Dialog) => Promise<Error | null>;
}>;

/**
 * Submit a login form and wait for the signed-in page while the provider's
 * dialog policy answers any browser dialog. A Playwright dialog blocks the
 * page until it is handled, so the handler lives exactly as long as this
 * attempt, and the success probe ends with it.
 */
export async function signInAttempt(
  page: Page,
  { submit, waitForSuccess, signal, handleDialog }: SignInAttempt,
): Promise<void> {
  signal?.throwIfAborted();
  const probe = new AbortController();
  let interrupt!: (error: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = reject;
  });
  const end = (error: unknown) => {
    probe.abort();
    interrupt(error);
  };
  const onDialog = (dialog: Dialog): void => {
    void Promise.resolve().then(() => handleDialog(dialog)).then((error) => {
      if (error) end(error);
    }, end);
  };

  page.on("dialog", onDialog);
  try {
    const success = waitForSuccess(signal ? AbortSignal.any([probe.signal, signal]) : probe.signal);
    void success.catch(() => undefined);
    const outcome = Promise.race([
      (async () => {
        await submit();
        await success;
      })(),
      interrupted,
    ]);
    void outcome.catch(() => undefined);
    await withAbort(outcome, signal);
  } finally {
    probe.abort();
    page.off("dialog", onDialog);
  }
}
