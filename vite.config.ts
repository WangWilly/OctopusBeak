import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
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
