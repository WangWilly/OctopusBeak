import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

async function* walk(directory: string): AsyncGenerator<Readonly<{ path: string; directory: boolean }>> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield { path, directory: false };
  }
  yield { path: directory, directory: true };
}

/** Bytes the files under `directory` take, WAL segments included. */
export async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for await (const { path, directory: isDirectory } of walk(directory)) {
    if (!isDirectory) bytes += (await stat(path)).size;
  }
  return bytes;
}

/**
 * Flushes every file under `directory`, then each directory, to the disk.
 * PGlite runs with `fsync=off` on a filesystem that has no fsync of its own,
 * so a checkpoint reaches only the OS cache. Each directory is flushed after
 * its files, so a renamed or new file is durable under its name too.
 * Node's fsync is not macOS's `F_FULLFSYNC`, so the drive's own cache may
 * still hold the last writes.
 */
export async function fsyncDirectory(directory: string): Promise<void> {
  for await (const { path } of walk(directory)) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
