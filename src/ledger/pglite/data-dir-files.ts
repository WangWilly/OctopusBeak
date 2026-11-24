import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** The filesystem calls a walk and a flush make; tests replace them. */
export type DataDirFs = Readonly<{
  readdir: typeof readdir;
  open: typeof open;
  stat: typeof stat;
}>;

const NODE_FS: DataDirFs = { readdir, open, stat };

/**
 * The folder runs on while it is read: PostgreSQL removes spill files in
 * `base/pgsql_tmp`, recycled WAL segments and the files a checkpoint
 * unlinks. A file or directory gone by the time it is reached has nothing
 * left to count or flush.
 */
function gone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function* walk(directory: string, fs: DataDirFs): AsyncGenerator<Readonly<{ path: string; directory: boolean }>> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (gone(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path, fs);
    else if (entry.isFile()) yield { path, directory: false };
  }
  yield { path: directory, directory: true };
}

/** Bytes the files under `directory` take, WAL segments included. */
export async function directoryBytes(directory: string, fs: DataDirFs = NODE_FS): Promise<number> {
  let bytes = 0;
  for await (const { path, directory: isDirectory } of walk(directory, fs)) {
    if (isDirectory) continue;
    try {
      bytes += (await fs.stat(path)).size;
    } catch (error) {
      if (!gone(error)) throw error;
    }
  }
  return bytes;
}

/**
 * Flushes every file under `directory`, then each directory, to the disk.
 * PGlite runs with `fsync=off` on a filesystem that has no fsync of its own,
 * so a checkpoint reaches only the OS cache. Each directory is flushed after
 * its files, so a renamed or new file is durable under its name too.
 * Node's fsync is not macOS's `F_FULLFSYNC`, so the drive's own cache may
 * still hold the last writes. An aborted `signal` stops it between files.
 */
export async function fsyncDirectory(directory: string, fs: DataDirFs = NODE_FS, signal?: AbortSignal): Promise<void> {
  for await (const { path } of walk(directory, fs)) {
    signal?.throwIfAborted();
    let handle;
    try {
      handle = await fs.open(path, "r");
    } catch (error) {
      if (gone(error)) continue;
      throw error;
    }
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
