import { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "./baseline.ts";

/**
 * Test-only: one real baseline install per process, snapshotted with
 * `dumpDataDir`, then restored into a fresh PGlite per caller. The seed
 * install runs `applyPgliteBaseline`, which verifies the manifest, so every
 * copy starts from a verified baseline without paying the install again.
 */
let template: Promise<Blob> | undefined;

function baselineTemplate(): Promise<Blob> {
  template ??= (async () => {
    const seed = await PGlite.create();
    try {
      await applyPgliteBaseline(seed);
      return await seed.dumpDataDir("none");
    } finally {
      await seed.close();
    }
  })();
  return template;
}

/** A fresh, isolated PGlite with the reviewed baseline already installed. */
export async function createBaselinePGlite(
  options: Readonly<{ dataDir?: string }> = {},
): Promise<PGlite> {
  return PGlite.create({ ...options, loadDataDir: await baselineTemplate() });
}
