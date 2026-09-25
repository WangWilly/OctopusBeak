import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_BROWSER_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const BROWSER_STATE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type BrowserStateCleanupOptions = Readonly<{
  directory: string;
  runtimeDirectory?: string;
  now?: () => number;
  retentionMs?: number;
  isActive?: (name: string) => boolean;
}>;

/** Remove abandoned, disposable Chromium profiles as soon as their task is inactive. */
export async function cleanupAbandonedBrowserRuntimeProfiles(
  options: Pick<BrowserStateCleanupOptions, "directory" | "isActive">,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(options.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (name === "." || name === ".." || options.isActive?.(name)) continue;
    const target = join(options.directory, name);
    let metadata;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    await rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Only direct, inactive entries in the dedicated browser-state root are eligible. */
export async function cleanupExpiredBrowserStates(
  options: BrowserStateCleanupOptions,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(options.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const cutoff = (options.now?.() ?? Date.now())
    - (options.retentionMs ?? DEFAULT_BROWSER_STATE_RETENTION_MS);
  let removed = 0;
  for (const name of names) {
    if (name === "." || name === ".." || options.isActive?.(name)) continue;
    const target = join(options.directory, name);
    let metadata;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink() || metadata.mtimeMs > cutoff) continue;
    await rm(target, { recursive: metadata.isDirectory(), force: true });
    removed += 1;
  }
  return removed;
}

export function startBrowserStateCleanup(
  options: BrowserStateCleanupOptions & Readonly<{ onError?: (error: unknown) => void }>,
): () => void {
  const runtimeDirectory = options.runtimeDirectory
    ?? join(dirname(options.directory), "browser-runtime");
  const run = () => {
    void cleanupExpiredBrowserStates(options).catch((error) => options.onError?.(error));
    void cleanupAbandonedBrowserRuntimeProfiles({
      directory: runtimeDirectory,
      isActive: options.isActive,
    }).catch((error) => options.onError?.(error));
  };
  run();
  const timer = setInterval(run, BROWSER_STATE_CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
