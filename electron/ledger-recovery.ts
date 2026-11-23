import { existsSync, renameSync } from "node:fs";

/** What the person chose when the local ledger refused to open (ADR 0150). */
export type LedgerRecoveryChoice = "retry" | "rebuild" | "quit";

type Copy = Readonly<{
  title: string;
  message: string;
  detail: string;
  retry: string;
  rebuild: string;
  quit: string;
}>;

const COPY: Readonly<Record<"zh-TW" | "en", Copy>> = {
  "zh-TW": {
    title: "OctopusBeak",
    message: "本機帳本損壞，無法安全開啟",
    detail: [
      "帳本的索引壞了，而且修不好。照常開啟可能讓同一筆交易被收集兩次，所以 OctopusBeak 沒有開啟它。",
      "重試：再檢查並嘗試修復一次。",
      "備份後重建：把目前的帳本整個搬到旁邊保留，建立一個新的空帳本，之後重新同步各來源。手動資產、消費分類與配對無法從銀行重新下載，會留在備份裡，app 內看不到。",
    ].join("\n\n"),
    retry: "重試",
    rebuild: "備份後重建帳本",
    quit: "結束",
  },
  en: {
    title: "OctopusBeak",
    message: "The local ledger is damaged and cannot open safely",
    detail: [
      "An index the ledger needs is damaged and could not be repaired. Opening it anyway could collect the same transaction twice, so OctopusBeak did not open it.",
      "Retry: check and try to repair it again.",
      "Back up and rebuild: move the current ledger aside, untouched, and start a new empty one, then sync each source again. Manual assets, spending categories, and pairings cannot be downloaded again from your banks; they stay in the backup and do not appear in the app.",
    ].join("\n\n"),
    retry: "Retry",
    rebuild: "Back up and rebuild",
    quit: "Quit",
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
export async function recoverUnusableLedger(dataDir: string, deps: LedgerRecoveryDeps): Promise<LedgerRecoveryChoice> {
  const copy = COPY[deps.locale];
  const index = await deps.ask({
    type: "error",
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    buttons: [copy.retry, copy.rebuild, copy.quit],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  const choice = CHOICES[index] ?? "quit";
  if (choice === "rebuild") {
    const exists = deps.exists ?? existsSync;
    const rename = deps.rename ?? renameSync;
    if (exists(dataDir)) rename(dataDir, damagedLedgerPath(dataDir, deps.now(), exists));
  }
  if (choice === "quit") {
    deps.exit(1);
    return choice;
  }
  deps.relaunch();
  deps.exit(0);
  return choice;
}
