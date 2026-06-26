import { loadOverview } from "$lib/overview/server/load-overview.ts";

export async function load() {
  return {
    overview: await loadOverview(),
  };
}
