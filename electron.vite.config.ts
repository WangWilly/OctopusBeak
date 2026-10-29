import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const external = [
  "electron",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  /^drizzle-orm/,
  // PGlite ships its WASM/data assets beside its Node entrypoints. Keep the
  // package (including /live) external so the packaged app resolves those
  // assets from the installed dependency instead of rewriting their URLs into
  // the worker bundle.
  /^@electric-sql\/pglite(?:\/.*)?$/,
  /^playwright/,
  /^zod/,
  /^@ai-sdk\/openai/,
  /^tesseract\.js/,
  /^onnxruntime-node/,
  /^sherpa-onnx/,
  /^mpg123-decoder/,
  /^pngjs/,
];

/** ADR 0077: the usage endpoint is set at build time so it never appears in the source. */
function usagePingUrl() {
  const value = process.env.OCTOPUSBEAK_USAGE_PING_URL ?? "";
  if (value && !/^https:\/\/[^\s/]+\/v1\/ping$/u.test(value)) {
    throw new Error("OCTOPUSBEAK_USAGE_PING_URL must be an https:// URL ending in /v1/ping.");
  }
  return value;
}

export default defineConfig({
  define: {
    __OCTOPUSBEAK_USAGE_PING_URL__: JSON.stringify(usagePingUrl()),
  },
  build: {
    emptyOutDir: true,
    ssr: true,
    outDir: "build-electron",
    lib: {
      entry: {
        main: "electron/main.ts",
        preload: "electron/preload.ts",
        "app-workflow-worker": "electron/app-workflow-worker.ts",
        "pglite-view-worker": "electron/pglite-view-worker.ts",
      },
      formats: ["cjs"],
      fileName: (_format, name) => `${name}.cjs`,
    },
    rollupOptions: {
      external,
    },
  },
  resolve: {
    alias: {
      $lib: "/src/lib",
    },
  },
});
