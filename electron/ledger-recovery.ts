import { existsSync, renameSync } from "node:fs";
import type { LedgerRestoreOrigin, StuckRestoreChoice } from "./ledger-restore.ts";

/** What the person chose when the local ledger refused to open (ADR 0150, ADR 0157). */
export type LedgerRecoveryChoice = "retry" | "rebuild" | "restore" | "quit";

type Copy = Readonly<{
  title: string;
  message: string;
  detail(backupPath: string): string;
  /** The paragraph that explains restoring the Cleanup Backup taken on `date`. */
  restoreDetail(backupPath: string, date: string): string;
  retry: string;
  rebuild: string;
  restore(date: string): string;
  quit: string;
  moveFailed(backupPath: string, reason: string): string;
  restoreFailed(reason: string): string;
}>;

const COPY: Readonly<Record<"zh-TW" | "en", Copy>> = {
  "zh-TW": {
    title: "OctopusBeak",
    message: "本機帳本毀損，無法安全開啟",
    detail: (backupPath) => [
      "帳本的索引壞了，無法檢查或修復。照常開啟可能讓同一筆交易被收集兩次，所以 OctopusBeak 沒有開啟它。",
      "重試：再檢查並嘗試修復一次。只有在問題是暫時性的時候才有幫助。",
      `備份後重建帳本：把目前的帳本原封不動搬到「${backupPath}」，建立一個新的空帳本，之後重新同步各來源。你在 app 裡輸入或修改過的資料（例如手動資產、標籤、消費分類與配對），以及各來源已不再提供的較舊紀錄，都只留在備份裡，app 內看不到。`,
    ].join("\n\n"),
    restoreDetail: (backupPath, date) =>
      `還原 ${date} 的備份：和重建一樣，把目前的帳本原封不動搬到「${backupPath}」，再用 ${date} 清理前的備份取代它。備份之後新增或收集的資料會遺失。`,
    retry: "重試",
    rebuild: "備份後重建帳本",
    restore: (date) => `還原 ${date} 的備份`,
    quit: "結束",
    moveFailed: (backupPath, reason) => `無法把帳本搬到「${backupPath}」：${reason}\n\n帳本沒有被變更。OctopusBeak 將結束。`,
    restoreFailed: (reason) => `無法開始還原備份：${reason}\n\n帳本沒有被變更。OctopusBeak 將結束。`,
  },
  en: {
    title: "OctopusBeak",
    message: "The local ledger is damaged and cannot open safely",
    detail: (backupPath) => [
      "An index the ledger needs is damaged and could not be checked or repaired. Opening it anyway could collect the same transaction twice, so OctopusBeak did not open it.",
      "Retry: check and try to repair it again. This only helps if the problem was temporary.",
      `Back up and rebuild: move the current ledger, untouched, to "${backupPath}", start a new empty one, then sync each source again. Anything you entered or edited in the app, such as manual assets, tags, spending categories, and pairings, and history older than what each source still provides, stays only in the backup and does not appear in the app.`,
    ].join("\n\n"),
    restoreDetail: (backupPath, date) =>
      `Restore the backup from ${date}: move the current ledger, untouched, to "${backupPath}", as a rebuild does, and put the backup taken before the cleanup on ${date} in its place. Data added since the backup is lost.`,
    retry: "Retry",
    rebuild: "Back up and rebuild",
    restore: (date) => `Restore the backup from ${date}`,
    quit: "Quit",
    moveFailed: (backupPath, reason) => `The ledger could not be moved to "${backupPath}": ${reason}\n\nThe ledger was not changed. OctopusBeak will quit.`,
    restoreFailed: (reason) => `The backup could not be restored: ${reason}\n\nThe ledger was not changed. OctopusBeak will quit.`,
  },
};

/** A day as the system's clock reads it, as Settings writes it: 2026/11/23. */
function localDate(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}/${pad(value.getMonth() + 1)}/${pad(value.getDate())}`;
}

export type LedgerRecoveryDeps = Readonly<{
  locale: "zh-TW" | "en";
  /** Resolves with the index of the button the person chose. */
  ask(options: Readonly<{
    type: "error";
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: true;
  }>): Promise<number>;
  /** Starts the App again once this process exits. */
  relaunch(): void;
  exit(code: number): void;
  now(): Date;
  /** Tells the person why a rebuild could not move the ledger aside. */
  showError(title: string, message: string): void;
  rename?(from: string, to: string): void;
  exists?(path: string): boolean;
  /**
   * A Cleanup Backup that can be restored (ADR 0157), or null. Its request
   * names where the unusable ledger goes; the next launch moves it there and
   * puts the backup in its place.
   */
  restore?: Readonly<{ takenAt: Date; request(aside: string): Promise<void> }> | null;
  /** The day a backup was taken, as Settings writes it; the system clock's day when absent. */
  formatDate?(value: Date): string;
}>;

/** Where a set-aside ledger goes: beside the original, named by when it was set aside. */
export function damagedLedgerPath(dataDir: string, now: Date, exists: (path: string) => boolean = existsSync): string {
  const stamp = now.toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z");
  for (let attempt = 0; ; attempt += 1) {
    const candidate = `${dataDir}.damaged-${stamp}${attempt === 0 ? "" : `-${attempt}`}`;
    if (!exists(candidate)) return candidate;
  }
}

/**
 * Asks the person what to do with a ledger that refused to open, does it,
 * and ends this process. Retry and rebuild start the App again: a new start
 * checks the ledger again, since a refused ledger leaves no clean-shutdown
 * record. Rebuild moves the whole data directory aside first, untouched, so
 * nothing is deleted. Restore records the Cleanup Restore, which the next
 * launch carries out (ADR 0157). Returns the choice for diagnostics.
 */
export async function recoverUnusableLedger(
  dataDir: string,
  deps: LedgerRecoveryDeps,
): Promise<LedgerRecoveryChoice | "rebuild-failed" | "restore-failed"> {
  const copy = COPY[deps.locale];
  const exists = deps.exists ?? existsSync;
  const backupPath = damagedLedgerPath(dataDir, deps.now(), exists);
  const restore = deps.restore ?? null;
  const date = restore ? (deps.formatDate ?? localDate)(restore.takenAt) : "";
  const choices: LedgerRecoveryChoice[] = restore ? ["retry", "rebuild", "restore", "quit"] : ["retry", "rebuild", "quit"];
  const labels: Record<LedgerRecoveryChoice, string> = { retry: copy.retry, rebuild: copy.rebuild, restore: copy.restore(date), quit: copy.quit };
  const index = await deps.ask({
    type: "error",
    title: copy.title,
    message: copy.message,
    detail: restore ? `${copy.detail(backupPath)}\n\n${copy.restoreDetail(backupPath, date)}` : copy.detail(backupPath),
    buttons: choices.map((choice) => labels[choice]),
    defaultId: 0,
    cancelId: choices.length - 1,
    noLink: true,
  });
  const choice = choices[index] ?? "quit";
  if (choice === "restore" && restore) {
    // Only recorded here: the next launch moves the ledger aside and the backup in, before anything opens either.
    try {
      await restore.request(backupPath);
    } catch (error) {
      deps.showError(copy.title, copy.restoreFailed(error instanceof Error ? error.message : String(error)));
      deps.exit(1);
      return "restore-failed";
    }
  }
  if (choice === "rebuild" && exists(dataDir)) {
    try {
      (deps.rename ?? renameSync)(dataDir, backupPath);
    } catch (error) {
      deps.showError(copy.title, copy.moveFailed(backupPath, error instanceof Error ? error.message : String(error)));
      deps.exit(1);
      return "rebuild-failed";
    }
  }
  if (choice === "quit") {
    deps.exit(1);
    return choice;
  }
  deps.relaunch();
  deps.exit(0);
  return choice;
}


const STUCK_COPY: Readonly<Record<"zh-TW" | "en", Readonly<{
  message: string;
  detail(date: string, from: LedgerRestoreOrigin): string;
  retry: string;
  swapBack: string;
  quit: string;
}>>> = {
  "zh-TW": {
    message: "還原的備份帳本試了幾次都沒有開啟完成",
    detail: (date, from) => [
      `OctopusBeak 已經嘗試開啟 ${date} 清理前的備份帳本好幾次，每次都沒有完成。`,
      "再試一次：再開啟一次備份帳本。",
      from === "settings"
        ? "換回原本的帳本：放回還原前的帳本。"
        : "換回原本的帳本：放回的是毀損的帳本，之後會再次出現帳本毀損的對話框。",
      "如果還原後 OctopusBeak 曾經開啟、而你輸入了資料，那些資料會留在備份裡，備份保留期間可以從設定再還原；否則換回不會遺失任何資料。",
    ].join("\n\n"),
    retry: "再試一次",
    swapBack: "換回原本的帳本",
    quit: "結束",
  },
  en: {
    message: "The restored backup has not finished opening after several tries",
    detail: (date, from) => [
      `OctopusBeak has tried to open the ledger backed up before the cleanup on ${date} several times, and it never finished opening.`,
      "Try again: open the backup once more.",
      from === "settings"
        ? "Switch back to the original ledger: put back the ledger you had before the restore."
        : "Switch back to the original ledger: the ledger that comes back is the damaged one, and the damaged-ledger dialog will appear again.",
      "If OctopusBeak did open after the restore and you entered data, that data stays in the backup and can be restored again from Settings while the backup is kept. Otherwise switching back loses nothing.",
    ].join("\n\n"),
    retry: "Try again",
    swapBack: "Switch back to the original ledger",
    quit: "Quit",
  },
};

const STUCK_CHOICES: readonly StuckRestoreChoice[] = ["retry", "swap-back", "quit"];

/**
 * Asks what to do with a restored backup that several launches began
 * opening with no word from any of them. Runs before the worker starts, so
 * it never blocks a ledger in use. Trying again is the default; closing the
 * dialog quits.
 */
export async function askAboutStuckRestore(deps: Readonly<{
  locale: "zh-TW" | "en";
  takenAt: Date;
  from: LedgerRestoreOrigin;
  ask: LedgerRecoveryDeps["ask"];
  formatDate?(value: Date): string;
}>): Promise<StuckRestoreChoice> {
  const copy = STUCK_COPY[deps.locale];
  const index = await deps.ask({
    type: "error",
    title: COPY[deps.locale].title,
    message: copy.message,
    detail: copy.detail((deps.formatDate ?? localDate)(deps.takenAt), deps.from),
    buttons: [copy.retry, copy.swapBack, copy.quit],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return STUCK_CHOICES[index] ?? "quit";
}
