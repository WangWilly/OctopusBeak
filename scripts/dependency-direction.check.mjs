import assert from "node:assert/strict";
import test from "node:test";
import {
  electronImportsInSrc,
  rendererViolations,
  runtimeSpecifiers,
} from "./dependency-direction.mjs";

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

test("type-only imports are erased, every runtime import form is followed", () => {
  const source = `
    import type { A } from "./types-a.ts";
    import { type B, type C } from "./types-b.ts";
    export type { D } from "./types-d.ts";
    import { e, type F } from "./mixed.ts";
    import "./side-effect.ts";
    export { g } from "./re-export.ts";
    const lazy = () => import("./lazy.ts");
  `;
  assert.deepEqual(runtimeSpecifiers("src/lib/x.ts", source), [
    "./mixed.ts",
    "./side-effect.ts",
    "./re-export.ts",
    "./lazy.ts",
  ]);
  assert.deepEqual(
    runtimeSpecifiers("src/lib/X.svelte", `<script lang="ts">import { h } from "./h.ts";</script><p>{h}</p>`),
    ["./h.ts"],
  );
});

test("a server module two hops from a route is reported with its chain", () => {
  const files = {
    "src/routes/+page.svelte": `<script lang="ts">import { view } from "$lib/feature/view.ts";</script>`,
    "src/lib/feature/view.ts": `import { load } from "./server/load.ts"; export const view = load;`,
    "src/lib/feature/server/load.ts": `import { readFileSync } from "node:fs"; export const load = readFileSync;`,
  };
  const { violations } = rendererViolations({
    entries: ["src/routes/+page.svelte"],
    read: (file) => files[file] ?? "",
  });
  assert.deepEqual(violations.map(describe), [
    "src/routes/+page.svelte > src/lib/feature/view.ts imports ./server/load.ts (a server module)",
  ]);
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
