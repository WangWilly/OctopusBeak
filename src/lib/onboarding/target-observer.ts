export type OnboardingTargetRegistration = {
  element: HTMLElement;
  action?: string;
};

export type OnboardingTargetRegistry = ReturnType<typeof createOnboardingTargetRegistry>;

export function createOnboardingTargetRegistry() {
  const targets = new Map<string, OnboardingTargetRegistration>();
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) listener();
  }

  return {
    get(id: string | null | undefined) {
      return id ? targets.get(id) ?? null : null;
    },

    register(id: string, element: HTMLElement, action?: string) {
      const registration = { element, ...(action ? { action } : {}) };
      targets.set(id, registration);
      emit();
      return () => {
        if (targets.get(id) !== registration) return;
        targets.delete(id);
        emit();
      };
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      // Observers need the current snapshot as well as future changes. A route
      // may register its target before the coach mounts and subscribes.
      listener();
      return () => listeners.delete(listener);
    },
  };
}

export type OnboardingTargetActionParameters = {
  registry: OnboardingTargetRegistry;
  id: string | null;
  action?: string;
};

export function registerOnboardingTarget(
  node: HTMLElement,
  parameters: OnboardingTargetActionParameters,
) {
  let unregister = parameters.id
    ? parameters.registry.register(parameters.id, node, parameters.action)
    : () => {};
  let current = parameters;
  return {
    update(next: OnboardingTargetActionParameters) {
      if (next.registry === current.registry && next.id === current.id && next.action === current.action) return;
      unregister();
      current = next;
      unregister = current.id
        ? current.registry.register(current.id, node, current.action)
        : () => {};
    },
    destroy() {
      unregister();
    },
  };
}

export function focusOnboardingTarget(target: HTMLElement) {
  target.focus({ preventScroll: true });
  return true;
}
