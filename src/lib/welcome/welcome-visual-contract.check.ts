import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const forceTextSource = await readFile(new URL("./ForceText.svelte", import.meta.url), "utf8");
const welcomeSource = await readFile(new URL("./FirstRunWelcome.svelte", import.meta.url), "utf8");

test("ForceText keeps particles legible and strongly separated", () => {
  assert.match(forceTextSource, /forceCollide<[^>]+>\(4\)\.strength\(1\)/);
  assert.match(forceTextSource, /<circle[^>]+r=\"4\"/);
});

test("slide 2 uses the supplied static curved arrow", () => {
  assert.match(welcomeSource, /curved-arrow-animation\.svg/);
  assert.match(welcomeSource, /rotate\(45deg\)/);
  assert.doesNotMatch(welcomeSource, /↟/);
  assert.doesNotMatch(welcomeSource, /arrow-float/);
});

test("slides 1 and 2 do not use opacity entry or exit animations", () => {
  assert.doesNotMatch(
    welcomeSource,
    /\.intro-slide\s*,\s*\.product-slide\s*\{[^}]*animation:/s,
  );
  assert.doesNotMatch(welcomeSource, /animation:\s*(?:icon-arrive|copy-rise|arrow-float)/);
});
