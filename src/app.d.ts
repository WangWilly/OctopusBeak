import type { OctopusBeakApi } from "$lib/desktop/api.ts";

declare global {
  interface Window {
    octopusBeak: OctopusBeakApi;
  }
}

export {};
