import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const external = [
  "electron",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  /^drizzle-orm/,
  /^libretto/,
  /^playwright/,
  /^xlsx/,
  /^zod/,
  /^@ai-sdk\/openai/,
];

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "build-electron",
    lib: {
      entry: {
        main: "electron/main.ts",
        preload: "electron/preload.ts",
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
