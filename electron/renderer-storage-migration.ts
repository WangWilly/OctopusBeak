import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER_FILE = "renderer-storage-origin";
const BLANK_PAGE = "<!doctype html><meta charset=\"utf-8\"><title></title>";

/** A page the migration can load and run a script in. */
export type StoragePage = Readonly<{
  load(url: string): Promise<void>;
  evaluate<T>(script: string): Promise<T>;
}>;

const READ_STORAGE = "Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]))";

function writeMissing(entries: Readonly<Record<string, string>>) {
  return `(() => {
    const entries = ${JSON.stringify(entries)};
    let written = 0;
    for (const [key, value] of Object.entries(entries)) {
      if (localStorage.getItem(key) !== null) continue;
      localStorage.setItem(key, value);
      written += 1;
    }
    return written;
  })()`;
}

/**
 * Carries the renderer's preferences (language, welcome and onboarding
 * progress, display scale, sidebar, value visibility) from the file:// origin
 * the App used to load from to the app:// origin, once. A key the new origin
 * already holds is kept. The marker is written only after success, so a
 * failed attempt runs again on the next launch.
 */
export async function migrateRendererStorage(options: Readonly<{
  userData: string;
  appOriginPageUrl: string;
  /** The window that will show the renderer, used before it does. */
  page: StoragePage;
}>): Promise<"migrated" | "already-migrated"> {
  const marker = join(options.userData, MARKER_FILE);
  if (existsSync(marker)) return "already-migrated";
  const blankFile = join(options.userData, "renderer-storage-migration.html");
  writeFileSync(blankFile, BLANK_PAGE);
  const { page } = options;
  try {
    await page.load(pathToFileURL(blankFile).href);
    const entries = await page.evaluate<Record<string, string>>(READ_STORAGE);
    // Ending on an app:// page keeps the renderer's own load same-origin, even with nothing to copy.
    await page.load(options.appOriginPageUrl);
    if (Object.keys(entries).length > 0) await page.evaluate<number>(writeMissing(entries));
    writeFileSync(marker, "app\n");
    return "migrated";
  } finally {
    rmSync(blankFile, { force: true });
  }
}
