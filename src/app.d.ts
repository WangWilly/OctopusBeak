import type { OctopusBeakApi } from "$lib/desktop/api.ts";

declare global {
  interface Window {
    octopusBeak: OctopusBeakApi;
  }
  namespace svelteHTML {
    interface HTMLAttributes<T> {
      ononboardingadvance?: (event: CustomEvent<void>) => void;
      ononboardingback?: (event: CustomEvent<void>) => void;
    }
  }
}

export {};
