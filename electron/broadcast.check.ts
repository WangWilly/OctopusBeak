import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") {
      const fake = "export const BrowserWindow = { getAllWindows: () => [] };";
      return { url: `data:text/javascript,${encodeURIComponent(fake)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { broadcast } = await import("./broadcast.ts");

function fakeWindow(destroyed = false) {
  const sent: unknown[][] = [];
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: { send: (...args: unknown[]) => { sent.push(args); } },
  };
}

test("a push event reaches every live window and skips a destroyed one", () => {
  const [live, destroyed, other] = [fakeWindow(), fakeWindow(true), fakeWindow()];
  const event = { version: 4, reason: "preview-data-changed", changedAt: "now" } as const;

  broadcast("data:invalidated", event, [live, destroyed, other]);

  assert.deepEqual(live.sent, [["data:invalidated", event]]);
  assert.deepEqual(other.sent, [["data:invalidated", event]]);
  assert.deepEqual(destroyed.sent, []);
});

test("a push event without a payload sends the channel alone", () => {
  const window = fakeWindow();

  broadcast("automation:notification-target-requested", undefined, [window]);

  assert.deepEqual(window.sent, [["automation:notification-target-requested"]]);
});
