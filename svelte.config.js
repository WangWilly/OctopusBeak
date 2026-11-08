import adapter from "@sveltejs/adapter-static";
import { readFileSync, writeFileSync } from "node:fs";
import { withRendererCsp } from "./scripts/renderer-csp.mjs";

function electronStaticAdapter() {
  const base = adapter({
    fallback: "index.html",
  });

  return {
    ...base,
    async adapt(builder) {
      await base.adapt(builder);
      const fallback = "build/index.html";
      writeFileSync(
        fallback,
        withRendererCsp(
          readFileSync(fallback, "utf8")
            .replaceAll('href="/', 'href="./')
            .replaceAll('src="/', 'src="./')
            .replaceAll('import("/', 'import("./'),
        ),
      );
    },
  };
}

/** @type {import("@sveltejs/kit").Config} */
const config = {
  kit: {
    adapter: electronStaticAdapter(),
    paths: {
      relative: true,
    },
  },
};

export default config;
