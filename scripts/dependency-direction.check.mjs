import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  electronImportsInSrc,
  ledgerImportsOfWorkflows,
  moduleReferences,
  REPO_ROOT,
  rendererViolations,
  runtimeSpecifiers,
  srcImportsOfElectron,
} from "./dependency-direction.mjs";

function fakeTree(files) {
  return {
    read: (file) => files[file] ?? "",
    isFile: (path) => Object.keys(files).some((file) => join(REPO_ROOT, file) === path),
  };
}

const describe = (violation) =>
  `${violation.chain.join(" > ")} imports ${violation.specifier} (${violation.refusal})`;

test("the renderer bundle reaches no server module, Electron main code, Node built-in or main-process package", () => {
  const { violations, reached } = rendererViolations();
  assert.ok(reached > 50, `the walk followed the route graph (${reached} modules)`);
  assert.deepEqual(violations.map(describe), []);
});

test("no src/ module loads the electron package", () => {
  assert.deepEqual(electronImportsInSrc(), []);
});

test("import type is erased everywhere; a named import of only types is erased only by Svelte", () => {
  const source = `
    import type { A } from "./types-a.ts";
    import { type B, type C } from "./types-b.ts";
    export type { D } from "./types-d.ts";
    import { e, type F } from "./mixed.ts";
    import "./side-effect.ts";
    export { g } from "./re-export.ts";
    export * from "./star.ts";
    const lazy = () => import("./lazy.ts");
    const legacy = require("./legacy.cjs");
    const worker = new Worker(new URL("./worker.ts", import.meta.url));
    const logo = new URL("./logo.webp", import.meta.url);
  `;
  assert.deepEqual(runtimeSpecifiers("src/lib/x.ts", source), [
    "./types-b.ts",
    "./mixed.ts",
    "./side-effect.ts",
    "./re-export.ts",
    "./star.ts",
    "./lazy.ts",
    "./legacy.cjs",
    "./worker.ts",
  ], "verbatimModuleSyntax keeps import { type B } from a .ts file as import \"./types-b.ts\"");
  assert.deepEqual(
    runtimeSpecifiers(
      "src/lib/X.svelte",
      `<script lang="ts">import { type B } from "./types-b.ts"; import { h } from "./h.ts";</script><p>{h}</p>`,
    ),
    ["./h.ts"],
  );
});

test("forms the walk cannot follow are refused, an asset glob is not", () => {
  const unchecked = (source) => moduleReferences("src/lib/x.ts", source)
    .filter((reference) => reference.unchecked).map((reference) => reference.unchecked);
  assert.deepEqual(unchecked("const all = import.meta.glob('./server/*.ts', { eager: true });"), [
    "an import.meta.glob that can match code",
  ]);
  assert.deepEqual(unchecked("const logos = import.meta.glob(['./logos/*.webp', './logos/*.svg']);"), []);
  assert.deepEqual(unchecked("const load = (name) => import(`./server/${name}.ts`);"), ["a computed import()"]);
  assert.deepEqual(unchecked("const x = require(name);"), ["a computed require()"]);
  assert.deepEqual(unchecked("new Worker(new URL(path, import.meta.url));"), ["a computed new URL(…, import.meta.url)"]);
});

test("a server module two hops from a route is reported with its chain", () => {
  const files = {
    "src/routes/+page.svelte": `<script lang="ts">import { view } from "$lib/feature/view.ts";</script>`,
    "src/lib/feature/view.ts": `import { load } from "./server/load.ts"; export const view = load;`,
    "src/lib/feature/server/load.ts": `import { readFileSync } from "node:fs"; export const load = readFileSync;`,
  };
  const { violations } = rendererViolations({ entries: ["src/routes/+page.svelte"], ...fakeTree(files) });
  assert.deepEqual(violations.map(describe), [
    "src/routes/+page.svelte > src/lib/feature/view.ts imports ./server/load.ts (a server module)",
  ]);
});

test("a .ts module importing only types from a server module still brings it into the renderer", () => {
  const files = {
    "src/routes/+page.svelte": `<script lang="ts">import { view } from "$lib/feature/view.ts";</script>`,
    "src/lib/feature/view.ts": `import { type Load } from "./server/load.ts"; export const view = 1;`,
    "src/lib/feature/server/load.ts": `export type Load = number;`,
  };
  const { violations } = rendererViolations({ entries: ["src/routes/+page.svelte"], ...fakeTree(files) });
  assert.deepEqual(violations.map(describe), [
    "src/routes/+page.svelte > src/lib/feature/view.ts imports ./server/load.ts (a server module)",
  ]);
});

test("the renderer is refused the PGlite RPC layer's runtime code but may import its types", () => {
  const files = {
    "src/routes/+page.svelte": `<script lang="ts">import { view } from "$lib/feature/view.ts"; import { api } from "$lib/feature/api.ts";</script>`,
    "src/lib/feature/view.ts": `import type { Dtos } from "../pglite-rpc/live-views.ts"; export const view = 1;`,
    "src/lib/feature/api.ts": `import { call } from "../pglite-rpc/worker-call.ts"; export const api = call;`,
    "src/lib/pglite-rpc/live-views.ts": `export type Dtos = {};`,
    "src/lib/pglite-rpc/worker-call.ts": `export const call = 1;`,
  };
  const { violations } = rendererViolations({ entries: ["src/routes/+page.svelte"], ...fakeTree(files) });
  assert.deepEqual(violations.map(describe), [
    "src/routes/+page.svelte > src/lib/feature/api.ts imports ../pglite-rpc/worker-call.ts (the PGlite RPC protocol layer, which runs in main and its workers)",
  ]);
});

test("a path that names no file is refused instead of skipping its subtree", () => {
  const files = { "src/routes/+page.svelte": `<script lang="ts">import { x } from "$lib/x";</script>` };
  const { violations } = rendererViolations({ entries: ["src/routes/+page.svelte"], ...fakeTree(files) });
  assert.deepEqual(violations.map(describe), ["src/routes/+page.svelte imports $lib/x (a path that names no file)"]);
});

test("a src/ module importing electron is reported", () => {
  assert.deepEqual(
    electronImportsInSrc({
      files: ["src/lib/a.ts", "src/lib/b.ts"],
      read: (file) => (file === "src/lib/a.ts" ? `import { shell } from "electron";` : `import type { App } from "electron";`),
    }),
    [{ file: "src/lib/a.ts", specifier: "electron" }],
  );
});

test("no src/ledger module names a src/workflows module", () => {
  assert.deepEqual(ledgerImportsOfWorkflows(), []);
});

test("a ledger module's type-only, re-exported or import() type reference to a workflow is reported", () => {
  const files = {
    "src/ledger/canonical/a.ts": `import type { A } from "../../workflows/a.ts"; export const a = 1;`,
    "src/ledger/canonical/b.check.ts": `export { b } from "../../workflows/b.ts";`,
    "src/ledger/pglite/c.ts": `type C = import("../../workflows/c.ts").C;`,
    "src/ledger/pglite/d.ts": `import { d } from "../canonical/d.ts";`,
    "src/workflows/a.ts": "", "src/workflows/b.ts": "", "src/workflows/c.ts": "", "src/ledger/canonical/d.ts": "",
  };
  const tree = fakeTree(files);
  const found = ledgerImportsOfWorkflows({ files: Object.keys(files).filter((file) => file.startsWith("src/ledger/")), ...tree });
  assert.deepEqual(found.map(({ file }) => file), [
    "src/ledger/canonical/a.ts",
    "src/ledger/canonical/b.check.ts",
    "src/ledger/pglite/c.ts",
  ]);
});

test("no non-check src/ module names an electron/ module", () => {
  assert.deepEqual(srcImportsOfElectron(), []);
});

test("a src/ module's type-only, value or re-exported reference to electron/ is reported; a check's is not", () => {
  const files = {
    "src/lib/a.ts": `import type { A } from "../../electron/a.ts"; export const a = 1;`,
    "src/lib/b.ts": `import { b } from "../../electron/b.ts";`,
    "src/lib/c.ts": `export { c } from "../../electron/c.ts";`,
    "src/lib/d.ts": `type D = import("../../electron/d.ts").D;`,
    "src/lib/e.check.ts": `import { e } from "../../electron/e.ts";`,
    "src/lib/check-support/f.ts": `import { f } from "../../../electron/f.ts";`,
    "src/lib/g.ts": `import { g } from "../pglite-rpc/g.ts";`,
    "electron/a.ts": "", "electron/b.ts": "", "electron/c.ts": "", "electron/d.ts": "", "electron/e.ts": "",
    "electron/f.ts": "", "src/lib/pglite-rpc/g.ts": "",
  };
  const found = srcImportsOfElectron({ files: Object.keys(files).filter((file) => file.startsWith("src/")), ...fakeTree(files) });
  assert.deepEqual(found, [
    { file: "src/lib/a.ts", specifier: "../../electron/a.ts" },
    { file: "src/lib/b.ts", specifier: "../../electron/b.ts" },
    { file: "src/lib/c.ts", specifier: "../../electron/c.ts" },
    { file: "src/lib/d.ts", specifier: "../../electron/d.ts" },
  ]);
});
