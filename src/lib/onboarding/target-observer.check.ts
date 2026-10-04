import assert from "node:assert/strict";
import test from "node:test";

import {
  createOnboardingTargetRegistry,
  focusOnboardingTarget,
  registerOnboardingTarget,
} from "./target-observer.ts";

test("registered targets notify subscribers and stale cleanup cannot remove a replacement", () => {
  const registry = createOnboardingTargetRegistry();
  const events: Array<string | null> = [];
  const unsubscribe = registry.subscribe(() => {
    events.push(registry.get("automation.progress")?.action ?? null);
  });
  const first = {} as HTMLElement;
  const second = {} as HTMLElement;

  const removeFirst = registry.register("automation.progress", first, "first-copy");
  const removeSecond = registry.register("automation.progress", second, "progress-copy");

  removeFirst();
  assert.equal(registry.get("automation.progress")?.element, second);
  assert.equal(registry.get("automation.progress")?.action, "progress-copy");
  removeSecond();
  assert.equal(registry.get("automation.progress"), null);
  assert.deepEqual(events, [null, "first-copy", "progress-copy", null]);

  unsubscribe();
  registry.register("automation.progress", first);
  assert.equal(events.length, 4);
});

test("subscribing after target registration immediately exposes the current target snapshot", () => {
  const registry = createOnboardingTargetRegistry();
  const element = {} as HTMLElement;
  registry.register("automation.credentials", element, "open-credentials");

  let seen: HTMLElement | null = null;
  const unsubscribe = registry.subscribe(() => {
    seen = registry.get("automation.credentials")?.element ?? null;
  });

  assert.equal(seen, element);
  unsubscribe();
});

test("Svelte target action updates and removes its explicit registration", () => {
  const registry = createOnboardingTargetRegistry();
  const element = {} as HTMLElement;
  const action = registerOnboardingTarget(element, {
    registry,
    id: "automation.run",
    action: "run-copy",
  });
  assert.equal(registry.get("automation.run")?.element, element);

  action.update({ registry, id: "automation.progress", action: "progress-copy" });
  assert.equal(registry.get("automation.run"), null);
  assert.equal(registry.get("automation.progress")?.element, element);
  assert.equal(registry.get("automation.progress")?.action, "progress-copy");

  action.destroy();
  assert.equal(registry.get("automation.progress"), null);
});

test("focus targets receives focus only and never synthesizes an application action", () => {
  let focused = 0;
  let clicked = 0;
  const target = {
    focus(options?: FocusOptions) {
      assert.deepEqual(options, { preventScroll: true });
      focused += 1;
    },
    click() {
      clicked += 1;
    },
  } as unknown as HTMLElement;

  assert.equal(focusOnboardingTarget(target), true);
  assert.deepEqual({ focused, clicked }, { focused: 1, clicked: 0 });
});
