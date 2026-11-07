import assert from "node:assert/strict";
import test from "node:test";
import { isRendererDocument, trustedIpcMain, UntrustedIpcSenderError } from "./ipc-sender.ts";

const RENDERER = "file:///Applications/OctopusBeak.app/Contents/Resources/app/build/index.html";

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  return {
    handlers,
    listeners,
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      listeners.set(channel, listener);
      return undefined as never;
    },
  };
}

const topFrame = (url: string) => ({ senderFrame: { url, parent: null } });

test("the renderer document matches on every hash route but not another file or origin", () => {
  assert.equal(isRendererDocument(`${RENDERER}#/settings`, RENDERER), true);
  assert.equal(isRendererDocument(`${RENDERER}?x=1`, RENDERER), true);
  assert.equal(isRendererDocument("file:///tmp/evil/index.html", RENDERER), false);
  assert.equal(isRendererDocument("https://example.com/build/index.html", RENDERER), false);
  assert.equal(isRendererDocument(`https://example.com${new URL(RENDERER).pathname}`, RENDERER), false);
  assert.equal(isRendererDocument(RENDERER.replace("file://", "file://evil"), RENDERER), false);
  assert.equal(isRendererDocument("not a url", RENDERER), false);
});

test("an invoke runs its handler only for the renderer's top frame", async () => {
  const ipc = fakeIpc();
  const calls: unknown[][] = [];
  trustedIpcMain(ipc as never, RENDERER).handle("automation:snapshot", (_event, ...args) => {
    calls.push(args);
    return "ok";
  });
  const handler = ipc.handlers.get("automation:snapshot")!;

  assert.equal(await handler(topFrame(`${RENDERER}#/automation`), 1, 2), "ok");
  assert.throws(() => handler(topFrame("https://example.com/"), 3), UntrustedIpcSenderError);
  assert.throws(
    () => handler({ senderFrame: { url: RENDERER, parent: {} } }, 4),
    UntrustedIpcSenderError,
    "a subframe loading the renderer document is still refused",
  );
  assert.throws(() => handler({ senderFrame: null }, 5), UntrustedIpcSenderError);
  assert.deepEqual(calls, [[1, 2]]);
});

test("a send from another frame is dropped without reaching the listener", () => {
  const ipc = fakeIpc();
  const received: unknown[] = [];
  trustedIpcMain(ipc as never, RENDERER).on("display:setScale", (_event, percent) => received.push(percent));
  const listener = ipc.listeners.get("display:setScale")!;

  listener(topFrame("file:///tmp/other.html"), 150);
  listener(topFrame(RENDERER), 125);
  assert.deepEqual(received, [125]);
});

test("removing a handler reaches ipcMain", () => {
  const ipc = fakeIpc();
  const trusted = trustedIpcMain(ipc as never, RENDERER);
  trusted.handle("appUpdates:view", () => null);
  trusted.removeHandler("appUpdates:view");
  assert.equal(ipc.handlers.has("appUpdates:view"), false);
});
