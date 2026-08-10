import assert from "node:assert/strict";
import test from "node:test";

import { activateOnboardingTarget } from "./target-observer.ts";

function restoreGlobal(name: "HTMLButtonElement" | "HTMLInputElement", descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

test("enter-credentials buttons invoke their native click handler once", () => {
  const inputDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLInputElement");
  const buttonDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLButtonElement");
  let focused = 0;
  let clicked = 0;

  class FakeInputElement {}
  class FakeButtonElement {
    dataset = { onboardingAction: "enter-credentials" };

    focus() { focused += 1; }
    click() { clicked += 1; }
  }

  Object.defineProperty(globalThis, "HTMLInputElement", {
    configurable: true,
    value: FakeInputElement,
  });
  Object.defineProperty(globalThis, "HTMLButtonElement", {
    configurable: true,
    value: FakeButtonElement,
  });
  try {
    activateOnboardingTarget(new FakeButtonElement() as unknown as HTMLElement);
    assert.deepEqual({ focused, clicked }, { focused: 1, clicked: 1 });
  } finally {
    restoreGlobal("HTMLInputElement", inputDescriptor);
    restoreGlobal("HTMLButtonElement", buttonDescriptor);
  }
});

test("enter-credentials inputs keep focus and dispatch onboarding advancement", () => {
  const inputDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLInputElement");
  let focused = 0;
  let advanced = 0;
  let clicked = 0;

  class FakeInputElement {
    dataset = { onboardingAction: "enter-credentials" };
    value = "  certificate password  ";

    focus() { focused += 1; }
    click() { clicked += 1; }
    dispatchEvent(event: Event) {
      if (event.type === "onboardingadvance" && event.bubbles) advanced += 1;
      return true;
    }
  }

  Object.defineProperty(globalThis, "HTMLInputElement", {
    configurable: true,
    value: FakeInputElement,
  });
  try {
    activateOnboardingTarget(new FakeInputElement() as unknown as HTMLElement);
    assert.deepEqual({ focused, advanced, clicked }, { focused: 1, advanced: 1, clicked: 0 });
  } finally {
    restoreGlobal("HTMLInputElement", inputDescriptor);
  }
});
