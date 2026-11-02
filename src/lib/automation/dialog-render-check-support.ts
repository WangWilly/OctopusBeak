import type { Component } from "svelte";
import { createServer, type ViteDevServer } from "vite";

export type RenderComponent = (path: string, props: Record<string, unknown>) => Promise<string>;

/**
 * Server-renders Svelte components through the app's Vite config, in English, the way
 * src/lib/settings/SettingsPage.check.ts does. onMount never runs, so nothing calls a port.
 */
export async function withRenderer(check: (render: RenderComponent) => Promise<void>): Promise<void> {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "en", setItem: () => {} },
  });
  let server: ViteDevServer | null = null;
  try {
    server = await createServer({
      configFile: new URL("../../../vite.config.ts", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    });
    const vite = server;
    const { render } = await vite.ssrLoadModule("svelte/server") as {
      render: typeof import("svelte/server").render;
    };
    await check(async (path, props) => {
      const loaded = await vite.ssrLoadModule(path) as { default: Component<Record<string, unknown>> };
      return render(loaded.default, { props }).body;
    });
  } finally {
    await server?.close();
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

/** The visible text of rendered markup, with tags and hydration comments removed. */
export function visibleText(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
