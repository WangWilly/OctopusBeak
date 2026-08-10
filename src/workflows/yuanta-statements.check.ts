import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { dismissYuantaBankNotice } = await import("./yuanta-statements.ts");

class DelayedVisibilityLocator {
  private readonly visibleAt: number;
  private hidden = false;
  clicked = false;

  constructor(delayMs: number) {
    this.visibleAt = Date.now() + delayMs;
  }

  async isVisible(): Promise<boolean> {
    return !this.hidden && Date.now() >= this.visibleAt;
  }

  async waitFor(options: {
    state: "visible" | "hidden";
    timeout?: number;
  }): Promise<void> {
    const deadline = Date.now() + (options.timeout ?? 1_000);
    while (Date.now() < deadline) {
      const visible = await this.isVisible();
      if (visible === (options.state === "visible")) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Timed out waiting for ${options.state}.`);
  }

  locator(selector: string): DelayedVisibilityLocator {
    assert.equal(selector, "#commonPopupLeftBtnImg");
    return this;
  }

  async click(): Promise<void> {
    this.clicked = true;
    this.hidden = true;
  }
}

const source = readFileSync(
  new URL("./yuanta-statements.ts", import.meta.url),
  "utf8",
);

assert.match(
  source,
  /if \(page\.frame\(\{ name: "fmain" \}\) && currentCidFromFrameUrls\(page\)\) return;/,
);
assert.match(source, /await dismissYuantaBankNotice\(loginFrame\);/);
assert.match(source, /popup\.locator\("#commonPopupLeftBtnImg"\)/);

const popup = new DelayedVisibilityLocator(20);
const dismissed = await dismissYuantaBankNotice(
  {
    locator(selector: string) {
      assert.equal(selector, "#commonPopup");
      return popup;
    },
  } as never,
  100,
);
assert.equal(dismissed, true);
assert.equal(popup.clicked, true);

const absentPopup = new DelayedVisibilityLocator(1_000);
const dismissedAbsentPopup = await dismissYuantaBankNotice(
  {
    locator(selector: string) {
      assert.equal(selector, "#commonPopup");
      return absentPopup;
    },
  } as never,
  10,
);
assert.equal(dismissedAbsentPopup, false);
assert.equal(absentPopup.clicked, false);
