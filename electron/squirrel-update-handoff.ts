import type { AppRelease, AppUpdaterSignal, AppUpdateSupport } from "../src/lib/settings/app-updates.ts";

type Handoff = Readonly<{ feedUrl: string; close(): void }>;

/** The part of Electron's autoUpdater the hand-off drives. */
export type SquirrelAutoUpdater = Readonly<{
  setFeedURL(options: { url: string; serverType: "default" }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(event: "update-downloaded" | "update-not-available", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}>;

/**
 * Hands a verified update ZIP to Squirrel.Mac through a localhost feed, and
 * passes its answer back to the updater. Squirrel.Mac only ever reads the
 * hand-off feed, never the public one. Development and fixture builds have no
 * Squirrel, so they rehearse the hand-off instead and never restart.
 */
export function createSquirrelHandoff(deps: Readonly<{
  support: AppUpdateSupport;
  autoUpdater: SquirrelAutoUpdater;
  zipPath(release: AppRelease): string;
  start(zipPath: string): Promise<Handoff>;
  rehearse(feedUrl: string, release: AppRelease): Promise<boolean>;
  receive(signal: AppUpdaterSignal): void;
  reportError(code: string): void;
}>) {
  const squirrel = deps.support.supported && deps.support.squirrel;
  let closeHandoff: (() => void) | null = null;
  const end = () => {
    closeHandoff?.();
    closeHandoff = null;
  };
  if (squirrel) {
    deps.autoUpdater.on("update-downloaded", () => {
      end();
      deps.receive({ type: "update-downloaded" });
    });
    deps.autoUpdater.on("update-not-available", () => {
      end();
      deps.receive({ type: "error", message: "hand-off answered no update" });
    });
    deps.autoUpdater.on("error", (error) => {
      end();
      deps.receive({ type: "error", message: error.message });
    });
  }
  return {
    install(release: AppRelease) {
      void deps.start(deps.zipPath(release))
        .then(async (handoff) => {
          closeHandoff = handoff.close;
          if (squirrel) {
            deps.autoUpdater.setFeedURL({ url: handoff.feedUrl, serverType: "default" });
            deps.autoUpdater.checkForUpdates();
            return;
          }
          const served = await deps.rehearse(handoff.feedUrl, release).catch(() => false);
          end();
          deps.receive(served ? { type: "update-downloaded" } : { type: "error", message: "fixture hand-off" });
        })
        .catch(() => {
          // setFeedURL throws in an unsigned packaged build.
          end();
          deps.receive({ type: "error", message: "hand-off" });
        });
    },
    // Squirrel.Mac closes the windows, then quits through before-quit, so the ledger closes before ShipIt installs.
    quitAndInstall() {
      if (squirrel) deps.autoUpdater.quitAndInstall();
      else deps.reportError("app-update-fixture-restart-skipped");
    },
  };
}
