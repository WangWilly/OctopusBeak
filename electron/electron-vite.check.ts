import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../electron.vite.config.ts", import.meta.url), "utf8");
assert.match(
  source,
  /\/\^@electric-sql\\\/pglite\(\?:\\\/\.\*\)\?\$/u,
  "the worker bundle must resolve PGlite and its /live entry from the packaged dependency",
);
assert.match(source, /pglite-view-worker/u, "the dedicated worker must be emitted as an Electron entry");
