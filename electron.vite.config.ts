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
  /^libretto/,
  /^playwright/,
  /^zod/,
  /^@ai-sdk\/openai/,
  /^tesseract\.js/,
  /^onnxruntime-node/,
  /^sherpa-onnx/,
  /^mpg123-decoder/,
  /^pngjs/,
];

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "build-electron",
    lib: {
      entry: {
        main: "electron/main.ts",
        preload: "electron/preload.ts",
        "financial-page-worker": "electron/financial-page-worker.ts",
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
