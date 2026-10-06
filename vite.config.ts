import { readFileSync } from "node:fs";

import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [sveltekit()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    fs: {
      // Welcome shows the marketing site's institution logos.
      allow: ["site/assets/logos"],
    },
    watch: {
      ignored: ["**/.env"],
    },
  },
});
