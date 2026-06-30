import type { Locator, Page } from "playwright";

export async function activateControlWithoutPointer(
  locator: Locator,
): Promise<void> {
  await locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Control is not an HTMLElement.");
    }

    element.click();
  });
}

export async function fillInputWithoutPointer(
  locator: Locator,
  value: string,
): Promise<void> {
  await locator.evaluate((element, nextValue) => {
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      )
    ) {
      throw new Error("Input control is not an input or textarea element.");
    }

    element.value = nextValue;
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: nextValue,
        inputType: "insertReplacementText",
      }),
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

export async function selectOptionWithoutPointer(
  locator: Locator,
  value: string,
): Promise<void> {
  await locator.evaluate((element, nextValue) => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Select control is not a select element.");
    }

    const option = Array.from(element.options).find(
      (item) => item.value === nextValue,
    );
    if (!option) {
      throw new Error(`Select option "${nextValue}" was not found.`);
    }

    element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

export async function keepBrowserWindowOutOfForeground(
  page: Page,
): Promise<void> {
  const client = await page.context().newCDPSession(page).catch(() => null);
  if (!client) return;

  try {
    const { windowId } = await client.send("Browser.getWindowForTarget");
    await client.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    await client.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: -10_000, top: 0, width: 1280, height: 900 },
    });
  } catch {
    // Keeping the headed browser out of the foreground is a best-effort UX guard.
  } finally {
    await client.detach().catch(() => undefined);
  }
}
