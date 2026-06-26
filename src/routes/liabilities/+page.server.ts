import { loadLiabilities } from "$lib/liabilities/server/load-liabilities.ts";

export async function load() {
  return {
    liabilities: await loadLiabilities(),
  };
}
