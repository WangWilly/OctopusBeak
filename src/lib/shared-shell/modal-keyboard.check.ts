import assert from "node:assert/strict";
import test from "node:test";
import { closesOnKey, focusReturnTarget } from "./modal-keyboard.ts";

const key = (value: string, extra: { defaultPrevented?: boolean; isComposing?: boolean } = {}) => ({
  key: value,
  defaultPrevented: extra.defaultPrevented ?? false,
  isComposing: extra.isComposing,
});

test("Escape closes a closable dialog", () => {
  assert.equal(closesOnKey(key("Escape"), true), true);
});

test("Escape leaves a busy dialog open", () => {
  assert.equal(closesOnKey(key("Escape"), false), false);
});

test("other keys, handled keys, and IME composition never close the dialog", () => {
  assert.equal(closesOnKey(key("Enter"), true), false);
  assert.equal(closesOnKey(key("Escape", { defaultPrevented: true }), true), false);
  assert.equal(closesOnKey(key("Escape", { isComposing: true }), true), false);
});

test("focus returns to the element focused before opening only while it is still on the page", () => {
  const opener = { focus() {}, isConnected: true };
  assert.equal(focusReturnTarget(opener), opener);
  assert.equal(focusReturnTarget({ focus() {}, isConnected: false }), null);
  assert.equal(focusReturnTarget(null), null);
  assert.equal(focusReturnTarget({ isConnected: true }), null);
});
