import { createBeforeQuitHandler } from "./automation-shutdown.ts";
import type { LedgerRecoveryDeps } from "./ledger-recovery.ts";

/** What a fatal report names: the finite stage and code of `automationRuntimeFatalDetails`, never an error's text. */
export type AutomationRuntimeFatal = Readonly<{ code: string; stage: string }>;

type DialogOptions = Parameters<LedgerRecoveryDeps["ask"]>[0];

const COPY: Readonly<Record<"zh-TW" | "en", Readonly<{
  message: string;
  detail(fatal: AutomationRuntimeFatal): string;
  quit: string;
}>>> = {
  "zh-TW": {
    message: "OctopusBeak 發生內部問題，必須結束",
    detail: ({ stage, code }) => [
      "已收集的資料沒有因為這個問題而變更。",
      "如果再次發生，請回報以下內容：",
      `階段：${stage}\n代碼：${code}`,
    ].join("\n\n"),
    quit: "結束",
  },
  en: {
    message: "OctopusBeak must close because of an internal problem",
    detail: ({ stage, code }) => [
      "The data already collected was not changed by this problem.",
      "If it happens again, please report the following:",
      `Stage: ${stage}\nCode: ${code}`,
    ].join("\n\n"),
    quit: "Quit",
  },
};

export function automationRuntimeFatalDialog(locale: "zh-TW" | "en", fatal: AutomationRuntimeFatal): DialogOptions {
  const copy = COPY[locale];
  return {
    type: "error",
    title: "OctopusBeak",
    message: copy.message,
    detail: copy.detail(fatal),
    buttons: [copy.quit],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/**
 * How the App ends, ordinarily or after a fatal report. Both run the same
 * bounded quit: cleanup, then the ledger close, then the exit. A fatal
 * report first stops work, explains in a dialog and waits for it, and the
 * exit that ends its quit has status 1. A fatal report is handled once, and
 * not at all once a quit is under way or while `fatalIgnored` holds.
 */
export function createOrderedQuit(options: Omit<Parameters<typeof createBeforeQuitHandler>[0], "quit"> & Readonly<{
  /** Starts the quit; Electron's before-quit then reaches `beforeQuit`. */
  quit(): void;
  /** Ends the process at once with this status, once the bounded quit has finished. */
  exit(code: number): void;
  /** Another flow ends the App its own way: ledger recovery is asking, or a restore is swapping back. */
  fatalIgnored(): boolean;
  /** Stops schedules and aborts running collections while the person reads the dialog. */
  stopWork(): void;
  locale(): "zh-TW" | "en";
  /** Shows the dialog and settles once it is closed; settles at once when none can be shown. */
  ask(options: DialogOptions): Promise<unknown>;
  log(event: string, details?: unknown): void;
}>) {
  let fatal = false;
  let quitting = false;
  const handler = createBeforeQuitHandler({
    ...options,
    quit: () => (fatal ? options.exit(1) : options.quit()),
  });

  return {
    beforeQuit(event: { preventDefault(): void }) {
      quitting = true;
      handler(event);
    },
    fatalReported: () => fatal,
    reportFatal(details: AutomationRuntimeFatal) {
      if (fatal || quitting || options.fatalIgnored()) return;
      fatal = true;
      options.log("automation-runtime-fatal", details);
      try {
        options.stopWork();
      } catch {
        options.log("automation-runtime-fatal-stop-failed");
      }
      void Promise.resolve()
        .then(() => options.ask(automationRuntimeFatalDialog(options.locale(), details)))
        .catch(() => options.log("automation-runtime-fatal-dialog-failed"))
        .then(() => options.quit());
    },
  };
}
