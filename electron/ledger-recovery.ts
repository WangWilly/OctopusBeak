import { existsSync, renameSync } from "node:fs";

/** What the person chose when the local ledger refused to open (ADR 0150). */
export type LedgerRecoveryChoice = "retry" | "rebuild" | "quit";

type Copy = Readonly<{
  title: string;
  message: string;
  detail(backupPath: string): string;
  retry: string;
  rebuild: string;
  quit: string;
  moveFailed(backupPath: string, reason: string): string;
}>;

const COPY: Readonly<Record<"zh-TW" | "en", Copy>> = {
  "zh-TW": {
    title: "OctopusBeak",
    message: "本機帳本損壞，無法安全開啟",
    detail: (backupPath) => [
      "帳本的索引壞了，無法檢查或修復。照常開啟可能讓同一筆交易被收集兩次，所以 OctopusBeak 沒有開啟它。",
      "重試：再檢查並嘗試修復一次。只有在問題是暫時性的時候才有幫助。",
      `備份後重建帳本：把目前的帳本原封不動搬到「${backupPath}」，建立一個新的空帳本，之後重新同步各來源。你在 app 裡輸入或修改過的資料（例如手動資產、標籤、消費分類與配對），以及各來源已不再提供的較舊紀錄，都只留在備份裡，app 內看不到。`,
    ].join("\n\n"),
    retry: "重試",
    rebuild: "備份後重建帳本",
    quit: "結束",
    moveFailed: (backupPath, reason) => `無法把帳本搬到「${backupPath}」：${reason}\n\n帳本沒有被變更。OctopusBeak 將結束。`,
  },
  en: {
    title: "OctopusBeak",
    message: "The local ledger is damaged and cannot open safely",
    detail: (backupPath) => [
      "An index the ledger needs is damaged and could not be checked or repaired. Opening it anyway could collect the same transaction twice, so OctopusBeak did not open it.",
      "Retry: check and try to repair it again. This only helps if the problem was temporary.",
      `Back up and rebuild: move the current ledger, untouched, to "${backupPath}", start a new empty one, then sync each source again. Anything you entered or edited in the app, such as manual assets, tags, spending categories, and pairings, and history older than what each source still provides, stays only in the backup and does not appear in the app.`,
    ].join("\n\n"),
    retry: "Retry",
    rebuild: "Back up and rebuild",
    quit: "Quit",
    moveFailed: (backupPath, reason) => `The ledger could not be moved to "${backupPath}": ${reason}\n\nThe ledger was not changed. OctopusBeak will quit.`,
  },
};

const CHOICES: readonly LedgerRecoveryChoice[] = ["retry", "rebuild", "quit"];

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
 * nothing is deleted. Returns the choice for diagnostics.
 */
export async function recoverUnusableLedger(dataDir: string, deps: LedgerRecoveryDeps): Promise<LedgerRecoveryChoice | "rebuild-failed"> {
  const copy = COPY[deps.locale];
  const exists = deps.exists ?? existsSync;
  const backupPath = damagedLedgerPath(dataDir, deps.now(), exists);
  const index = await deps.ask({
    type: "error",
    title: copy.title,
    message: copy.message,
    detail: copy.detail(backupPath),
    buttons: [copy.retry, copy.rebuild, copy.quit],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  const choice = CHOICES[index] ?? "quit";
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
