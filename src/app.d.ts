import type { OctopusBeakApi } from "$lib/desktop/api.ts";

declare global {
  /** package.json version, injected by Vite. */
  const __APP_VERSION__: string;

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
