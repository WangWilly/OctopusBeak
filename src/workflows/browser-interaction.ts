import type { Locator, Page, Response } from "playwright";

type AttachedLocatorProbe = {
  first(): {
    waitFor(options: { state: "attached"; timeout: number }): Promise<void>;
  };
};

export async function hasAttachedLocator(
  locator: AttachedLocatorProbe,
  timeoutMs = 250,
): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: "attached", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function activateControlWithoutPointer(
  locator: Locator,
  options: {
    signal?: AbortSignal;
    timeout?: number;
  } = {},
): Promise<void> {
  if (options.signal !== undefined || options.timeout !== undefined) {
    // Playwright's dispatchEvent is the no-pointer equivalent of
    // HTMLElement.click(), but unlike locator.evaluate it supports an
    // AbortSignal. A timed-out evaluation remains queued in the frame and can
    // block every subsequent probe after a bank redirect.
    await locator.dispatchEvent("click", undefined, options);
    return;
  }

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
    if (!(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    )) {
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function keepBrowserWindowOutOfForeground(
  page: Page,
  timeoutMs = 1_500,
): Promise<void> {
  void moveBrowserWindowOutOfForeground(page, timeoutMs).catch(() => undefined);
}

async function moveBrowserWindowOutOfForeground(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  const client = await withTimeout(
    page.context().newCDPSession(page),
    timeoutMs,
  ).catch(() => null);
  if (!client) return;

  try {
    const { windowId } = await withTimeout(
      client.send("Browser.getWindowForTarget"),
      timeoutMs,
    );
    await withTimeout(
      client.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      }),
      timeoutMs,
    );
    await withTimeout(
      client.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: -10_000, top: 0, width: 1280, height: 900 },
      }),
      timeoutMs,
    );
  } catch {
    // Keeping the headed browser out of the foreground is a best-effort UX guard.
  } finally {
    await withTimeout(client.detach(), timeoutMs).catch(() => undefined);
  }
}

/**
 * Whether this response ends a redirect chain that a `method` request to a URL
 * containing `path` started. A hop that redirects onward is not the end; the
 * chain's last response matches wherever it landed, so a chain that leaves the
 * endpoint surfaces as that response instead of as no response at all.
 */
export function endsRequestChainFrom(response: Response, path: string, method: string): boolean {
  if (response.status() >= 300 && response.status() < 400 && response.headers().location !== undefined) return false;
  let origin = response.request();
  for (let previous = origin.redirectedFrom(); previous; previous = previous.redirectedFrom()) origin = previous;
  return origin.url().includes(path) && origin.method() === method;
}
