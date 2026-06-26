import { loadAssets } from "$lib/assets/server/load-assets.ts";

export async function load() {
  return {
    assets: await loadAssets(),
  };
}
