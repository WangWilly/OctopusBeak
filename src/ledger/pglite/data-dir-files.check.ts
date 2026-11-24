import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { directoryBytes, fsyncDirectory, type DataDirFs } from "./data-dir-files.ts";

const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });

/** A data folder with a spill directory and a file in it, both of which PostgreSQL removes while the folder is read. */
async function folder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "octopus-beak-data-dir-"));
  await mkdir(join(directory, "base", "pgsql_tmp"), { recursive: true });
  await mkdir(join(directory, "pg_wal"));
  await writeFile(join(directory, "base", "1"), "x".repeat(100));
  await writeFile(join(directory, "base", "pgsql_tmp", "pgsql_tmp1.0"), "x".repeat(50));
  await writeFile(join(directory, "pg_wal", "000000010000000000000001"), "x".repeat(10));
  return directory;
}

test("a file or directory removed between listing and opening does not fail the flush or the size", async () => {
  const directory = await folder();
  try {
    const opened: string[] = [];
    const removedFile = join(directory, "base", "pgsql_tmp", "pgsql_tmp1.0");
    const removedDirectory = join(directory, "pg_wal");
    const racing: DataDirFs = {
      readdir: (async (path: string, options: never) => {
        if (path === removedDirectory) throw enoent(path);
        return readdir(path, options);
      }) as DataDirFs["readdir"],
      open: (async (path: string, flags: string) => {
        if (path === removedFile) throw enoent(path);
        opened.push(path);
        return open(path, flags);
      }) as DataDirFs["open"],
      stat: (async (path: string) => {
        if (path === removedFile) throw enoent(path);
        return stat(path);
      }) as DataDirFs["stat"],
    };
    await fsyncDirectory(directory, racing);
    assert.ok(opened.includes(join(directory, "base", "1")), "the files still there are flushed");
    assert.ok(opened.includes(directory), "and the directories");
    assert.ok(!opened.includes(removedFile));
    assert.equal(await directoryBytes(directory, racing), 100);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("any other filesystem error still fails the flush", async () => {
  const directory = await folder();
  try {
    const denied: DataDirFs = {
      readdir,
      stat,
      open: (async (path: string) => {
        throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" });
      }) as DataDirFs["open"],
    };
    await assert.rejects(fsyncDirectory(directory, denied), /EACCES/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
